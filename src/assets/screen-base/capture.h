#ifndef STRUX_SCREEN_CAPTURE_H
#define STRUX_SCREEN_CAPTURE_H

#include <stdbool.h>
#include <stdint.h>
#include <wayland-client.h>
#include "wlr-screencopy-unstable-v1-client-protocol.h"

struct capture_context {
    /* Wayland globals */
    struct wl_display *display;
    struct wl_registry *registry;
    struct wl_shm *shm;
    struct wl_output *output;
    struct zwlr_screencopy_manager_v1 *screencopy_manager;

    /* Target output name */
    const char *output_name;
    bool output_found;

    /* Buffer state */
    uint32_t format;
    uint32_t width;
    uint32_t height;
    uint32_t stride;
    bool buffer_ready;

    /* Frame state */
    struct wl_buffer *buffer;
    struct wl_shm_pool *pool;
    void *data;
    int shm_fd;
    size_t shm_size;

    /* Status */
    bool frame_ready;
    bool frame_failed;
    bool running;

    /* Frame callback */
    void (*on_frame)(struct capture_context *ctx, void *data,
                     uint32_t width, uint32_t height, uint32_t stride,
                     uint32_t format, uint64_t timestamp_ns);
    void *user_data;
};

/* Initialize capture context and connect to Wayland */
int capture_init(struct capture_context *ctx, const char *output_name);

/* Capture a single frame (blocking). Returns 0 on success. */
int capture_frame(struct capture_context *ctx);

/* Clean up capture resources */
void capture_destroy(struct capture_context *ctx);

#endif /* STRUX_SCREEN_CAPTURE_H */
