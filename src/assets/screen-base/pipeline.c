/*
 * strux-screen: GStreamer encoding pipeline
 *
 * Encodes raw frames to H.264 using hardware-agnostic encoder selection:
 *   1. vaapih264enc  (VA-API hardware)
 *   2. v4l2h264enc   (V4L2 kernel encoder)
 *   3. x264enc       (software fallback)
 *
 * Also provides JPEG screenshot encoding.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <gst/video/video.h>

#include "pipeline.h"

/* Map wl_shm / DRM fourcc format to GStreamer video format string.
 * Modern Wayland compositors use DRM fourcc codes directly. */
static const char *wl_format_to_gst(uint32_t format)
{
    switch (format) {
    /* Legacy wl_shm enum values */
    case 0: /* WL_SHM_FORMAT_ARGB8888 */
        return "BGRA";
    case 1: /* WL_SHM_FORMAT_XRGB8888 */
        return "BGRx";

    /* DRM fourcc codes (used by wlroots 0.18+) */
    case 0x34325241: /* AR24 - DRM_FORMAT_ARGB8888 */
        return "BGRA";
    case 0x34325258: /* XR24 - DRM_FORMAT_XRGB8888 */
        return "BGRx";
    case 0x34324241: /* AB24 - DRM_FORMAT_ABGR8888 */
        return "RGBA";
    case 0x34324258: /* XB24 - DRM_FORMAT_XBGR8888 */
        return "RGBx";
    case 0x34324152: /* RA24 - DRM_FORMAT_RGBA8888 */
        return "ABGR";
    case 0x34324852: /* RX24 - DRM_FORMAT_RGBX8888 */
        return "xBGR";
    case 0x34324142: /* BA24 - DRM_FORMAT_BGRA8888 */
        return "ARGB";
    case 0x34324842: /* BX24 - DRM_FORMAT_BGRX8888 */
        return "xRGB";

    default:
        fprintf(stderr, "[strux-screen] Unknown pixel format: %u (0x%08x), "
                        "assuming BGRx\n", format, format);
        return "BGRx";
    }
}

/* Try to create an encoder element from a list of candidates */
static GstElement *try_create_encoder(const char **name_out)
{
    static const struct {
        const char *factory;
        const char *display_name;
    } encoders[] = {
        {"vaapih264enc",  "VA-API (hardware)"},
        {"v4l2h264enc",   "V4L2 (hardware)"},
        {"x264enc",       "x264 (software)"},
    };

    for (size_t i = 0; i < sizeof(encoders) / sizeof(encoders[0]); i++) {
        GstElement *enc = gst_element_factory_make(encoders[i].factory, "encoder");
        if (enc) {
            fprintf(stderr, "[strux-screen] Using encoder: %s (%s)\n",
                    encoders[i].factory, encoders[i].display_name);
            *name_out = encoders[i].factory;

            /* Configure encoder-specific properties */
            if (strcmp(encoders[i].factory, "x264enc") == 0) {
                g_object_set(enc,
                    "tune", 0x04, /* zerolatency */
                    "speed-preset", 1, /* ultrafast */
                    "bitrate", 2000,
                    "key-int-max", 60,
                    NULL);
            } else if (strcmp(encoders[i].factory, "vaapih264enc") == 0) {
                g_object_set(enc,
                    "rate-control", 2, /* CBR */
                    "bitrate", 2000,
                    "keyframe-period", 60,
                    NULL);
            } else if (strcmp(encoders[i].factory, "v4l2h264enc") == 0) {
                /* v4l2h264enc properties vary by driver, keep defaults */
                GObjectClass *klass = G_OBJECT_GET_CLASS(enc);
                if (g_object_class_find_property(klass, "extra-controls")) {
                    /* Some v4l2 drivers support extra controls for bitrate */
                    GstStructure *controls = gst_structure_new(
                        "controls",
                        "video_bitrate", G_TYPE_INT, 2000000,
                        NULL);
                    g_object_set(enc, "extra-controls", controls, NULL);
                    gst_structure_free(controls);
                }
            }

            return enc;
        }
    }

    fprintf(stderr, "[strux-screen] No H.264 encoder available\n");
    *name_out = NULL;
    return NULL;
}

/* Callback when appsink has a new encoded sample */
static GstFlowReturn on_new_sample(GstAppSink *appsink, gpointer user_data)
{
    struct pipeline_context *ctx = user_data;

    GstSample *sample = gst_app_sink_pull_sample(appsink);
    if (!sample)
        return GST_FLOW_ERROR;

    GstBuffer *buffer = gst_sample_get_buffer(sample);
    if (!buffer) {
        gst_sample_unref(sample);
        return GST_FLOW_ERROR;
    }

    GstMapInfo map;
    if (!gst_buffer_map(buffer, &map, GST_MAP_READ)) {
        gst_sample_unref(sample);
        return GST_FLOW_ERROR;
    }

    /* Check if this is a keyframe */
    bool is_keyframe = !GST_BUFFER_FLAG_IS_SET(buffer, GST_BUFFER_FLAG_DELTA_UNIT);

    uint64_t timestamp_ns = GST_BUFFER_PTS(buffer);

    if (ctx->on_encoded_frame) {
        ctx->on_encoded_frame(map.data, map.size, timestamp_ns,
                              is_keyframe, ctx->user_data);
    }

    gst_buffer_unmap(buffer, &map);
    gst_sample_unref(sample);

    return GST_FLOW_OK;
}

int pipeline_init(struct pipeline_context *ctx, uint32_t width,
                  uint32_t height, int fps, uint32_t wl_format)
{
    ctx->width = width;
    ctx->height = height;
    ctx->fps = fps;
    ctx->frame_count = 0;

    const char *gst_format = wl_format_to_gst(wl_format);
    fprintf(stderr, "[strux-screen] Pixel format: 0x%08x -> GStreamer %s\n",
            wl_format, gst_format);

    /* Create pipeline elements */
    ctx->pipeline = gst_pipeline_new("screen-encode");
    ctx->appsrc = gst_element_factory_make("appsrc", "src");
    GstElement *videoconvert = gst_element_factory_make("videoconvert", "convert");
    GstElement *capsfilter = gst_element_factory_make("capsfilter", "nv12filter");
    ctx->encoder = try_create_encoder(&ctx->encoder_name);
    GstElement *h264parse = gst_element_factory_make("h264parse", "parse");
    ctx->appsink = gst_element_factory_make("appsink", "sink");

    if (!ctx->pipeline || !ctx->appsrc || !videoconvert || !capsfilter ||
        !ctx->encoder || !h264parse || !ctx->appsink) {
        fprintf(stderr, "[strux-screen] Failed to create pipeline elements\n");
        return -1;
    }

    /* Configure appsrc */
    GstCaps *src_caps = gst_caps_new_simple("video/x-raw",
        "format", G_TYPE_STRING, gst_format,
        "width", G_TYPE_INT, (int)width,
        "height", G_TYPE_INT, (int)height,
        "framerate", GST_TYPE_FRACTION, fps, 1,
        NULL);
    g_object_set(ctx->appsrc,
        "caps", src_caps,
        "format", GST_FORMAT_TIME,
        "do-timestamp", FALSE,
        "is-live", TRUE,
        "max-buffers", 2,
        "drop", TRUE,
        NULL);
    gst_caps_unref(src_caps);

    /* Configure NV12 caps filter for encoder input */
    GstCaps *nv12_caps = gst_caps_new_simple("video/x-raw",
        "format", G_TYPE_STRING, "NV12",
        NULL);
    g_object_set(capsfilter, "caps", nv12_caps, NULL);
    gst_caps_unref(nv12_caps);

    /* Configure appsink */
    g_object_set(ctx->appsink,
        "emit-signals", TRUE,
        "sync", FALSE,
        "max-buffers", 4,
        "drop", TRUE,
        NULL);

    /* Set output caps on appsink for H.264 byte-stream */
    GstCaps *sink_caps = gst_caps_new_simple("video/x-h264",
        "stream-format", G_TYPE_STRING, "byte-stream",
        "alignment", G_TYPE_STRING, "au",
        NULL);
    g_object_set(ctx->appsink, "caps", sink_caps, NULL);
    gst_caps_unref(sink_caps);

    /* Connect sample callback */
    g_signal_connect(ctx->appsink, "new-sample",
                     G_CALLBACK(on_new_sample), ctx);

    /* Add elements to pipeline */
    gst_bin_add_many(GST_BIN(ctx->pipeline),
        ctx->appsrc, videoconvert, capsfilter,
        ctx->encoder, h264parse, ctx->appsink, NULL);

    /* Link elements */
    if (!gst_element_link_many(ctx->appsrc, videoconvert, capsfilter,
                               ctx->encoder, h264parse, ctx->appsink, NULL)) {
        fprintf(stderr, "[strux-screen] Failed to link pipeline elements\n");
        return -1;
    }

    /* Start the pipeline */
    GstStateChangeReturn ret = gst_element_set_state(ctx->pipeline,
                                                     GST_STATE_PLAYING);
    if (ret == GST_STATE_CHANGE_FAILURE) {
        fprintf(stderr, "[strux-screen] Failed to start pipeline\n");
        return -1;
    }

    fprintf(stderr, "[strux-screen] Pipeline started: %ux%u@%dfps encoder=%s\n",
            width, height, fps, ctx->encoder_name);

    return 0;
}

int pipeline_push_frame(struct pipeline_context *ctx, const void *data,
                        size_t size, uint32_t format)
{
    (void)format; /* Already configured in caps */

    GstBuffer *buffer = gst_buffer_new_allocate(NULL, size, NULL);
    if (!buffer)
        return -1;

    gst_buffer_fill(buffer, 0, data, size);

    /* Set timestamp */
    uint64_t duration = GST_SECOND / ctx->fps;
    GST_BUFFER_PTS(buffer) = ctx->frame_count * duration;
    GST_BUFFER_DTS(buffer) = GST_BUFFER_PTS(buffer);
    GST_BUFFER_DURATION(buffer) = duration;
    ctx->frame_count++;

    GstFlowReturn ret = gst_app_src_push_buffer(GST_APP_SRC(ctx->appsrc),
                                                 buffer);
    if (ret != GST_FLOW_OK) {
        fprintf(stderr, "[strux-screen] Failed to push frame: %s\n",
                gst_flow_get_name(ret));
        return -1;
    }

    return 0;
}

void pipeline_force_keyframe(struct pipeline_context *ctx)
{
    if (!ctx->encoder)
        return;

    GstEvent *event = gst_video_event_new_downstream_force_key_unit(
        GST_CLOCK_TIME_NONE, GST_CLOCK_TIME_NONE, GST_CLOCK_TIME_NONE,
        TRUE, 0);
    gst_element_send_event(ctx->encoder, event);
}

uint8_t *pipeline_screenshot(struct pipeline_context *ctx, const void *data,
                             size_t size, uint32_t width, uint32_t height,
                             uint32_t format, size_t *out_size)
{
    const char *gst_format = wl_format_to_gst(format);

    /* Build a one-shot pipeline: appsrc ! videoconvert ! jpegenc ! appsink */
    gchar *pipeline_str = g_strdup_printf(
        "appsrc name=src caps=video/x-raw,format=%s,width=%u,height=%u,"
        "framerate=0/1 ! videoconvert ! jpegenc quality=85 ! "
        "appsink name=sink",
        gst_format, width, height);

    GError *error = NULL;
    GstElement *pipe = gst_parse_launch(pipeline_str, &error);
    g_free(pipeline_str);

    if (!pipe) {
        fprintf(stderr, "[strux-screen] Screenshot pipeline error: %s\n",
                error->message);
        g_error_free(error);
        return NULL;
    }

    GstElement *src = gst_bin_get_by_name(GST_BIN(pipe), "src");
    GstElement *sink = gst_bin_get_by_name(GST_BIN(pipe), "sink");

    g_object_set(src, "format", GST_FORMAT_TIME, NULL);
    g_object_set(sink, "sync", FALSE, NULL);

    gst_element_set_state(pipe, GST_STATE_PLAYING);

    /* Push frame */
    GstBuffer *buf = gst_buffer_new_allocate(NULL, size, NULL);
    gst_buffer_fill(buf, 0, data, size);
    GST_BUFFER_PTS(buf) = 0;
    gst_app_src_push_buffer(GST_APP_SRC(src), buf);
    gst_app_src_end_of_stream(GST_APP_SRC(src));

    /* Pull encoded JPEG */
    GstSample *sample = gst_app_sink_pull_sample(GST_APP_SINK(sink));
    uint8_t *result = NULL;
    *out_size = 0;

    if (sample) {
        GstBuffer *outbuf = gst_sample_get_buffer(sample);
        GstMapInfo map;
        if (gst_buffer_map(outbuf, &map, GST_MAP_READ)) {
            result = malloc(map.size);
            if (result) {
                memcpy(result, map.data, map.size);
                *out_size = map.size;
            }
            gst_buffer_unmap(outbuf, &map);
        }
        gst_sample_unref(sample);
    }

    gst_element_set_state(pipe, GST_STATE_NULL);
    gst_object_unref(src);
    gst_object_unref(sink);
    gst_object_unref(pipe);

    return result;
}

void pipeline_destroy(struct pipeline_context *ctx)
{
    if (ctx->pipeline) {
        gst_element_set_state(ctx->pipeline, GST_STATE_NULL);
        gst_object_unref(ctx->pipeline);
        ctx->pipeline = NULL;
    }
}
