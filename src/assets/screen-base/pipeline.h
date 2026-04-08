#ifndef STRUX_SCREEN_PIPELINE_H
#define STRUX_SCREEN_PIPELINE_H

#include <stdbool.h>
#include <stdint.h>
#include <gst/gst.h>
#include <gst/app/gstappsrc.h>
#include <gst/app/gstappsink.h>

struct pipeline_context {
    GstElement *pipeline;
    GstElement *appsrc;
    GstElement *appsink;
    GstElement *encoder;

    uint32_t width;
    uint32_t height;
    int fps;
    const char *encoder_name;

    /* Frame counter for timestamps */
    uint64_t frame_count;

    /* Callback for encoded frames */
    void (*on_encoded_frame)(const uint8_t *data, size_t size,
                             uint64_t timestamp_ns, bool is_keyframe,
                             void *user_data);
    void *user_data;

    /* Screenshot pipeline */
    GstElement *screenshot_pipeline;
    GstElement *screenshot_appsrc;
    GstElement *screenshot_appsink;
};

/* Initialize GStreamer and create the encoding pipeline.
 * Tries encoders in order: vaapih264enc, v4l2h264enc, x264enc.
 * wl_format is the wl_shm/DRM fourcc pixel format from the capture.
 * Returns 0 on success. */
int pipeline_init(struct pipeline_context *ctx, uint32_t width,
                  uint32_t height, int fps, uint32_t wl_format);

/* Push a raw frame into the pipeline for encoding.
 * format should be a GStreamer video format string (e.g., "BGRx"). */
int pipeline_push_frame(struct pipeline_context *ctx, const void *data,
                        size_t size, uint32_t format);

/* Request a keyframe on the next frame */
void pipeline_force_keyframe(struct pipeline_context *ctx);

/* Take a screenshot: encode a single frame as JPEG.
 * Returns allocated buffer (caller must free) and sets out_size. */
uint8_t *pipeline_screenshot(struct pipeline_context *ctx, const void *data,
                             size_t size, uint32_t width, uint32_t height,
                             uint32_t format, size_t *out_size);

/* Stop and clean up the pipeline */
void pipeline_destroy(struct pipeline_context *ctx);

#endif /* STRUX_SCREEN_PIPELINE_H */
