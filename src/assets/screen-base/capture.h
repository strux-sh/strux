#ifndef STRUX_SCREEN_CAPTURE_H
#define STRUX_SCREEN_CAPTURE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <wayland-client.h>
#include "wlr-screencopy-unstable-v1-client-protocol.h"
#include "wlr-virtual-pointer-unstable-v1-client-protocol.h"
#include "virtual-keyboard-unstable-v1-client-protocol.h"
#include "linux-dmabuf-unstable-v1-client-protocol.h"

struct gbm_device;
struct gbm_bo;

/* GPU-side capture buffer for the zero-copy path. The compositor blits into
 * the dmabuf on the GPU; the fd is handed to the encoder, which imports it
 * without any CPU copy. in_use is set while the encoder holds the buffer
 * (cleared from the GStreamer streaming thread). */
#define CAPTURE_DMABUF_SLOTS 3
struct capture_dmabuf_slot {
    struct gbm_bo *bo;
    struct wl_buffer *wl_buffer;
    int fd;
    uint32_t stride;
    int in_use; /* accessed with __atomic builtins */
};

struct capture_context {
    /* Wayland globals */
    struct wl_display *display;
    struct wl_registry *registry;
    struct wl_shm *shm;
    struct wl_output *output;
    struct zwlr_screencopy_manager_v1 *screencopy_manager;

    /* Virtual input globals (consumed by input.c) */
    struct wl_seat *seat;
    struct zwlr_virtual_pointer_manager_v1 *virtual_pointer_manager;
    uint32_t virtual_pointer_manager_version;
    struct zwp_virtual_keyboard_manager_v1 *virtual_keyboard_manager;

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

    /* Outstanding screencopy request. A request is kept in flight at all
     * times while capturing so every compositor commit is caught; the old
     * request-after-processing loop missed every other commit. */
    struct zwlr_screencopy_frame_v1 *pending_frame;

    /* DMA-BUF capture path (zero-copy). Falls back to shm when unavailable. */
    struct zwp_linux_dmabuf_v1 *dmabuf;
    struct gbm_device *gbm;
    int drm_fd;
    bool dmabuf_offered;   /* compositor offered a dmabuf target this frame */
    uint32_t dmabuf_format; /* DRM fourcc offered by the compositor */
    uint32_t dmabuf_width;
    uint32_t dmabuf_height;
    struct capture_dmabuf_slot slots[CAPTURE_DMABUF_SLOTS];
    struct capture_dmabuf_slot *copy_slot; /* slot used by the pending copy */
    bool force_shm;         /* screenshots need CPU-readable shm frames */
    bool last_frame_dmabuf; /* which path the last completed frame took */
    bool dmabuf_disabled;   /* set after repeated dmabuf copy failures */
    int dmabuf_failures;

    /* Status */
    bool frame_ready;
    bool frame_failed;
    bool running;

    /* Frame callback (shm path) */
    void (*on_frame)(struct capture_context *ctx, void *data,
                     uint32_t width, uint32_t height, uint32_t stride,
                     uint32_t format, uint64_t timestamp_ns);

    /* Frame callback (dmabuf path). The receiver must eventually call
     * capture_release_dmabuf_slot(slot) to return the buffer to the pool. */
    void (*on_frame_dmabuf)(struct capture_context *ctx, void *slot,
                            int fd, size_t size, uint32_t stride,
                            uint32_t drm_format, uint32_t width,
                            uint32_t height, uint64_t timestamp_ns);
    void *user_data;
};

/* Initialize capture context and connect to Wayland */
int capture_init(struct capture_context *ctx, const char *output_name);

/* Capture a single frame (blocking). Returns 0 on success. */
int capture_frame(struct capture_context *ctx);

/* Return a dmabuf slot to the pool. Safe to call from any thread. */
void capture_release_dmabuf_slot(void *slot);

/* Clean up capture resources */
void capture_destroy(struct capture_context *ctx);

#endif /* STRUX_SCREEN_CAPTURE_H */
