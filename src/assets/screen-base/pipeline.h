#ifndef STRUX_SCREEN_PIPELINE_H
#define STRUX_SCREEN_PIPELINE_H

#include <stdbool.h>
#include <stdint.h>
#include <gst/gst.h>
#include <gst/app/gstappsrc.h>
#include <gst/app/gstappsink.h>
#include <gst/video/video.h>

struct pipeline_context {
    GstElement *pipeline;
    GstElement *appsrc;
    GstElement *appsink;
    GstElement *encoder;

    uint32_t width;
    uint32_t height;
    uint32_t input_format;
    int fps;
    const char *encoder_name;

    /* Zero-copy input support */
    GstAllocator *dmabuf_allocator;
    GstVideoFormat vformat;

    /* Frame counter + first capture timestamp (for zero-based PTS) */
    uint64_t frame_count;
    uint64_t base_capture_ns;

    /* Diagnostics: encoded-output rate + negotiated caps (logged once) */
    bool caps_logged;
    uint64_t out_count;
    int64_t rate_log_us;

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
 * format should be a GStreamer video format string (e.g., "BGRx").
 * capture_ns is the compositor's capture timestamp (CLOCK_MONOTONIC); it is
 * carried through as the buffer PTS so viewers can measure real latency. */
int pipeline_push_frame(struct pipeline_context *ctx, const void *data,
                        size_t size, uint32_t stride, uint32_t format,
                        uint64_t capture_ns);

/* Push a dmabuf-backed frame (zero-copy). The fd is dup'd internally; the
 * release callback fires (from the streaming thread) once the pipeline is
 * done with the buffer. Returns -1 without invoking release on failure. */
int pipeline_push_dmabuf(struct pipeline_context *ctx, int fd, size_t size,
                         uint32_t stride, uint32_t width, uint32_t height,
                         uint64_t capture_ns,
                         void (*release)(void *), void *release_data);

/* Request a keyframe on the next frame */
void pipeline_force_keyframe(struct pipeline_context *ctx);

/* Take a screenshot: encode a single frame as JPEG.
 * Returns allocated buffer (caller must free) and sets out_size. */
uint8_t *pipeline_screenshot(struct pipeline_context *ctx, const void *data,
                             size_t size, uint32_t width, uint32_t height,
                             uint32_t stride, uint32_t format,
                             size_t *out_size);

/* Stop and clean up the pipeline */
void pipeline_destroy(struct pipeline_context *ctx);

#endif /* STRUX_SCREEN_PIPELINE_H */
