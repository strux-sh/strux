/*
 * strux-screen: Wayland screen capture via wlr-screencopy protocol
 *
 * Connects to a Cage compositor as a Wayland client and captures frames
 * from a specified output using the wlr-screencopy-unstable-v1 protocol.
 */

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#include <drm_fourcc.h>
#include <gbm.h>

#include "capture.h"

/* --- wl_output listener --- */

static void output_geometry(void *data, struct wl_output *output,
                            int32_t x, int32_t y, int32_t pw, int32_t ph,
                            int32_t subpixel, const char *make,
                            const char *model, int32_t transform)
{
    (void)data; (void)output; (void)x; (void)y; (void)pw; (void)ph;
    (void)subpixel; (void)make; (void)model; (void)transform;
}

static void output_mode(void *data, struct wl_output *output,
                        uint32_t flags, int32_t width, int32_t height,
                        int32_t refresh)
{
    (void)data; (void)output; (void)flags;
    (void)width; (void)height; (void)refresh;
}

static void output_done(void *data, struct wl_output *output)
{
    (void)data; (void)output;
}

static void output_scale(void *data, struct wl_output *output, int32_t factor)
{
    (void)data; (void)output; (void)factor;
}

static void output_name(void *data, struct wl_output *output, const char *name)
{
    struct capture_context *ctx = data;
    if (strcmp(name, ctx->output_name) == 0) {
        ctx->output = output;
        ctx->output_found = true;
        fprintf(stderr, "[strux-screen] Found target output: %s\n", name);
    }
}

static void output_description(void *data, struct wl_output *output,
                                const char *description)
{
    (void)data; (void)output; (void)description;
}

static const struct wl_output_listener output_listener = {
    .geometry = output_geometry,
    .mode = output_mode,
    .done = output_done,
    .scale = output_scale,
    .name = output_name,
    .description = output_description,
};

/* --- wl_registry listener --- */

static void registry_global(void *data, struct wl_registry *registry,
                            uint32_t name, const char *interface,
                            uint32_t version)
{
    struct capture_context *ctx = data;

    if (strcmp(interface, wl_shm_interface.name) == 0) {
        ctx->shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
    } else if (strcmp(interface, zwlr_screencopy_manager_v1_interface.name) == 0) {
        ctx->screencopy_manager = wl_registry_bind(
            registry, name, &zwlr_screencopy_manager_v1_interface, 3);
    } else if (strcmp(interface, wl_seat_interface.name) == 0) {
        ctx->seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
    } else if (strcmp(interface,
                      zwlr_virtual_pointer_manager_v1_interface.name) == 0) {
        uint32_t v = version < 2 ? version : 2;
        ctx->virtual_pointer_manager = wl_registry_bind(
            registry, name, &zwlr_virtual_pointer_manager_v1_interface, v);
        ctx->virtual_pointer_manager_version = v;
    } else if (strcmp(interface,
                      zwp_virtual_keyboard_manager_v1_interface.name) == 0) {
        ctx->virtual_keyboard_manager = wl_registry_bind(
            registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
    } else if (strcmp(interface, zwp_linux_dmabuf_v1_interface.name) == 0) {
        uint32_t v = version < 3 ? version : 3;
        ctx->dmabuf = wl_registry_bind(
            registry, name, &zwp_linux_dmabuf_v1_interface, v);
    } else if (strcmp(interface, wl_output_interface.name) == 0) {
        /* Bind each output to check its name */
        struct wl_output *output = wl_registry_bind(
            registry, name, &wl_output_interface, 4);
        wl_output_add_listener(output, &output_listener, ctx);
    }
}

static void registry_global_remove(void *data, struct wl_registry *registry,
                                   uint32_t name)
{
    (void)data; (void)registry; (void)name;
}

static const struct wl_registry_listener registry_listener = {
    .global = registry_global,
    .global_remove = registry_global_remove,
};

/* --- DMA-BUF capture buffers --- */

void capture_release_dmabuf_slot(void *slot)
{
    struct capture_dmabuf_slot *s = slot;
    __atomic_store_n(&s->in_use, 0, __ATOMIC_RELEASE);
}

static void destroy_dmabuf_slot(struct capture_dmabuf_slot *slot)
{
    if (slot->wl_buffer) {
        wl_buffer_destroy(slot->wl_buffer);
        slot->wl_buffer = NULL;
    }
    if (slot->fd >= 0) {
        close(slot->fd);
        slot->fd = -1;
    }
    if (slot->bo) {
        gbm_bo_destroy(slot->bo);
        slot->bo = NULL;
    }
    slot->in_use = 0;
}

/* Allocate (or reuse) the GBM buffer + wl_buffer for a slot at the offered
 * dmabuf geometry. Returns 0 on success. */
static int ensure_dmabuf_slot(struct capture_context *ctx,
                              struct capture_dmabuf_slot *slot)
{
    if (slot->bo) {
        if (gbm_bo_get_width(slot->bo) == ctx->dmabuf_width &&
            gbm_bo_get_height(slot->bo) == ctx->dmabuf_height &&
            gbm_bo_get_format(slot->bo) == ctx->dmabuf_format)
            return 0;
        destroy_dmabuf_slot(slot); /* geometry changed */
    }

    slot->bo = gbm_bo_create(ctx->gbm, ctx->dmabuf_width, ctx->dmabuf_height,
                             ctx->dmabuf_format,
                             GBM_BO_USE_LINEAR | GBM_BO_USE_RENDERING);
    if (!slot->bo) {
        fprintf(stderr, "[strux-screen] gbm_bo_create failed (%ux%u 0x%08x)\n",
                ctx->dmabuf_width, ctx->dmabuf_height, ctx->dmabuf_format);
        return -1;
    }

    slot->fd = gbm_bo_get_fd(slot->bo);
    slot->stride = gbm_bo_get_stride(slot->bo);
    if (slot->fd < 0) {
        fprintf(stderr, "[strux-screen] gbm_bo_get_fd failed\n");
        destroy_dmabuf_slot(slot);
        return -1;
    }

    struct zwp_linux_buffer_params_v1 *params =
        zwp_linux_dmabuf_v1_create_params(ctx->dmabuf);
    zwp_linux_buffer_params_v1_add(params, slot->fd, 0, 0, slot->stride,
                                   DRM_FORMAT_MOD_INVALID >> 32,
                                   DRM_FORMAT_MOD_INVALID & 0xffffffff);
    slot->wl_buffer = zwp_linux_buffer_params_v1_create_immed(
        params, (int32_t)ctx->dmabuf_width, (int32_t)ctx->dmabuf_height,
        ctx->dmabuf_format, 0);
    zwp_linux_buffer_params_v1_destroy(params);

    if (!slot->wl_buffer) {
        fprintf(stderr, "[strux-screen] dmabuf wl_buffer creation failed\n");
        destroy_dmabuf_slot(slot);
        return -1;
    }

    return 0;
}

static struct capture_dmabuf_slot *acquire_dmabuf_slot(
    struct capture_context *ctx)
{
    for (int i = 0; i < CAPTURE_DMABUF_SLOTS; i++) {
        struct capture_dmabuf_slot *slot = &ctx->slots[i];
        if (__atomic_load_n(&slot->in_use, __ATOMIC_ACQUIRE))
            continue;
        if (ensure_dmabuf_slot(ctx, slot) == 0)
            return slot;
        return NULL; /* allocation failure — let caller fall back to shm */
    }
    return NULL; /* encoder holds every buffer — skip this frame */
}

/* --- screencopy frame listener --- */

static int create_buffer(struct capture_context *ctx);
static void destroy_buffer(struct capture_context *ctx);

static void frame_buffer(void *data, struct zwlr_screencopy_frame_v1 *frame,
                         uint32_t format, uint32_t width, uint32_t height,
                         uint32_t stride)
{
    struct capture_context *ctx = data;

    /* Recreate the shm buffer if the output geometry changed */
    if (ctx->buffer && (ctx->width != width || ctx->height != height ||
                        ctx->stride != stride || ctx->format != format)) {
        destroy_buffer(ctx);
    }

    ctx->format = format;
    ctx->width = width;
    ctx->height = height;
    ctx->stride = stride;
    ctx->buffer_ready = true;
}

static void frame_linux_dmabuf(void *data,
                               struct zwlr_screencopy_frame_v1 *frame,
                               uint32_t format, uint32_t width,
                               uint32_t height)
{
    struct capture_context *ctx = data;
    (void)frame;
    ctx->dmabuf_offered = true;
    ctx->dmabuf_format = format;
    ctx->dmabuf_width = width;
    ctx->dmabuf_height = height;
}

static void frame_buffer_done(void *data,
                              struct zwlr_screencopy_frame_v1 *frame)
{
    struct capture_context *ctx = data;

    /* Issue the copy immediately so it latches onto the compositor's next
     * commit while the daemon is off encoding the previous frame.
     * Prefer the dmabuf target: the compositor blits on the GPU instead of
     * doing an expensive GPU->CPU readback into shm. */
    ctx->copy_slot = NULL;
    if (ctx->gbm && ctx->dmabuf && ctx->dmabuf_offered &&
        !ctx->force_shm && !ctx->dmabuf_disabled) {
        struct capture_dmabuf_slot *slot = acquire_dmabuf_slot(ctx);
        if (slot) {
            ctx->copy_slot = slot;
            zwlr_screencopy_frame_v1_copy(frame, slot->wl_buffer);
            return;
        }
        /* Pool exhausted or allocation failed — shm keeps the stream alive */
    }

    if (!ctx->buffer && create_buffer(ctx) < 0) {
        ctx->frame_failed = true;
        return;
    }
    zwlr_screencopy_frame_v1_copy(frame, ctx->buffer);
}

static void frame_flags(void *data, struct zwlr_screencopy_frame_v1 *frame,
                        uint32_t flags)
{
    (void)data; (void)frame; (void)flags;
}

static void frame_ready(void *data, struct zwlr_screencopy_frame_v1 *frame,
                        uint32_t tv_sec_hi, uint32_t tv_sec_lo,
                        uint32_t tv_nsec)
{
    struct capture_context *ctx = data;
    ctx->frame_ready = true;

    uint64_t timestamp_ns =
        ((uint64_t)tv_sec_hi << 32 | tv_sec_lo) * 1000000000ULL + tv_nsec;

    ctx->last_frame_dmabuf = ctx->copy_slot != NULL;

    if (ctx->copy_slot) {
        /* Zero-copy path: mark the slot busy and hand the fd downstream */
        struct capture_dmabuf_slot *slot = ctx->copy_slot;
        ctx->copy_slot = NULL;
        if (ctx->on_frame_dmabuf) {
            __atomic_store_n(&slot->in_use, 1, __ATOMIC_RELEASE);
            ctx->on_frame_dmabuf(ctx, slot, slot->fd,
                                 (size_t)slot->stride * ctx->dmabuf_height,
                                 slot->stride, ctx->dmabuf_format,
                                 ctx->dmabuf_width, ctx->dmabuf_height,
                                 timestamp_ns);
        }
        return;
    }

    if (ctx->on_frame) {
        ctx->on_frame(ctx, ctx->data, ctx->width, ctx->height,
                      ctx->stride, ctx->format, timestamp_ns);
    }
}

static void frame_failed(void *data, struct zwlr_screencopy_frame_v1 *frame)
{
    struct capture_context *ctx = data;
    ctx->frame_failed = true;
    fprintf(stderr, "[strux-screen] Frame capture failed\n");
}

static void frame_damage(void *data, struct zwlr_screencopy_frame_v1 *frame,
                         uint32_t x, uint32_t y, uint32_t width,
                         uint32_t height)
{
    (void)data; (void)frame; (void)x; (void)y; (void)width; (void)height;
}

static const struct zwlr_screencopy_frame_v1_listener frame_listener = {
    .buffer = frame_buffer,
    .linux_dmabuf = frame_linux_dmabuf,
    .buffer_done = frame_buffer_done,
    .flags = frame_flags,
    .ready = frame_ready,
    .failed = frame_failed,
    .damage = frame_damage,
};

/* --- Shared memory helpers --- */

static int create_shm_file(size_t size)
{
    char name[] = "/strux-screen-XXXXXX";
    int fd = shm_open(name, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (fd < 0)
        return -1;
    shm_unlink(name);

    if (ftruncate(fd, size) < 0) {
        close(fd);
        return -1;
    }

    return fd;
}

static int create_buffer(struct capture_context *ctx)
{
    ctx->shm_size = ctx->stride * ctx->height;
    ctx->shm_fd = create_shm_file(ctx->shm_size);
    if (ctx->shm_fd < 0) {
        fprintf(stderr, "[strux-screen] Failed to create shared memory\n");
        return -1;
    }

    ctx->data = mmap(NULL, ctx->shm_size, PROT_READ | PROT_WRITE,
                     MAP_SHARED, ctx->shm_fd, 0);
    if (ctx->data == MAP_FAILED) {
        close(ctx->shm_fd);
        return -1;
    }

    ctx->pool = wl_shm_create_pool(ctx->shm, ctx->shm_fd, ctx->shm_size);
    ctx->buffer = wl_shm_pool_create_buffer(ctx->pool, 0, ctx->width,
                                            ctx->height, ctx->stride,
                                            ctx->format);

    return 0;
}

static void destroy_buffer(struct capture_context *ctx)
{
    if (ctx->buffer) {
        wl_buffer_destroy(ctx->buffer);
        ctx->buffer = NULL;
    }
    if (ctx->pool) {
        wl_shm_pool_destroy(ctx->pool);
        ctx->pool = NULL;
    }
    if (ctx->data && ctx->data != MAP_FAILED) {
        munmap(ctx->data, ctx->shm_size);
        ctx->data = NULL;
    }
    if (ctx->shm_fd >= 0) {
        close(ctx->shm_fd);
        ctx->shm_fd = -1;
    }
}

/* --- Public API --- */

int capture_init(struct capture_context *ctx, const char *output_name)
{
    memset(ctx, 0, sizeof(*ctx));
    ctx->output_name = output_name;
    ctx->shm_fd = -1;
    ctx->drm_fd = -1;
    for (int i = 0; i < CAPTURE_DMABUF_SLOTS; i++)
        ctx->slots[i].fd = -1;

    ctx->display = wl_display_connect(NULL);
    if (!ctx->display) {
        fprintf(stderr, "[strux-screen] Failed to connect to Wayland display\n");
        return -1;
    }

    ctx->registry = wl_display_get_registry(ctx->display);
    wl_registry_add_listener(ctx->registry, &registry_listener, ctx);

    /* First roundtrip: get globals */
    wl_display_roundtrip(ctx->display);
    /* Second roundtrip: get output names */
    wl_display_roundtrip(ctx->display);

    if (!ctx->screencopy_manager) {
        fprintf(stderr,
                "[strux-screen] Compositor does not support wlr-screencopy\n");
        return -1;
    }

    if (!ctx->shm) {
        fprintf(stderr, "[strux-screen] Compositor does not support wl_shm\n");
        return -1;
    }

    if (!ctx->output_found) {
        fprintf(stderr, "[strux-screen] Output '%s' not found\n", output_name);
        return -1;
    }

    /* Set up GBM for zero-copy dmabuf capture (optional — shm fallback) */
    if (ctx->dmabuf && !getenv("STRUX_SCREEN_NO_DMABUF")) {
        static const char *nodes[] = { "/dev/dri/renderD128", "/dev/dri/card0" };
        for (size_t i = 0; i < sizeof(nodes) / sizeof(nodes[0]); i++) {
            ctx->drm_fd = open(nodes[i], O_RDWR | O_CLOEXEC);
            if (ctx->drm_fd >= 0)
                break;
        }
        if (ctx->drm_fd >= 0) {
            ctx->gbm = gbm_create_device(ctx->drm_fd);
            if (!ctx->gbm) {
                close(ctx->drm_fd);
                ctx->drm_fd = -1;
            }
        }
        fprintf(stderr, "[strux-screen] DMA-BUF capture: %s\n",
                ctx->gbm ? "available" : "unavailable (using shm)");
    }

    ctx->running = true;
    return 0;
}

/* Issue a screencopy request. The copy itself is sent from the buffer_done
 * event, so the request latches onto the compositor's next commit.
 * overlay_cursor=0: the viewer renders its own local cursor. */
static void request_frame(struct capture_context *ctx)
{
    ctx->frame_ready = false;
    ctx->frame_failed = false;
    ctx->buffer_ready = false;
    ctx->dmabuf_offered = false;
    ctx->copy_slot = NULL;

    ctx->pending_frame = zwlr_screencopy_manager_v1_capture_output(
        ctx->screencopy_manager, 0, ctx->output);
    zwlr_screencopy_frame_v1_add_listener(ctx->pending_frame,
                                          &frame_listener, ctx);
    wl_display_flush(ctx->display);
}

int capture_frame(struct capture_context *ctx)
{
    if (!ctx->pending_frame)
        request_frame(ctx);

    /* Wait for the outstanding capture to complete (the frame callback
     * delivers the pixels to on_frame during dispatch) */
    while (!ctx->frame_ready && !ctx->frame_failed) {
        if (wl_display_dispatch(ctx->display) < 0) {
            fprintf(stderr, "[strux-screen] Wayland dispatch error\n");
            zwlr_screencopy_frame_v1_destroy(ctx->pending_frame);
            ctx->pending_frame = NULL;
            return -1;
        }
    }

    bool failed = ctx->frame_failed;

    /* A failure while a dmabuf copy was pending means the compositor could
     * not blit into our buffer — after a few strikes, fall back to shm for
     * good rather than failing forever. */
    if (failed && ctx->copy_slot) {
        ctx->copy_slot = NULL;
        if (++ctx->dmabuf_failures >= 3 && !ctx->dmabuf_disabled) {
            ctx->dmabuf_disabled = true;
            fprintf(stderr, "[strux-screen] DMA-BUF copies keep failing; "
                            "falling back to shm capture\n");
        }
    } else if (!failed && ctx->last_frame_dmabuf) {
        ctx->dmabuf_failures = 0;
    }

    zwlr_screencopy_frame_v1_destroy(ctx->pending_frame);
    ctx->pending_frame = NULL;

    /* Keep the pipeline primed: the next request goes out before the caller
     * spends time encoding, so no compositor commit is missed. */
    request_frame(ctx);

    return failed ? -1 : 0;
}

void capture_destroy(struct capture_context *ctx)
{
    if (ctx->pending_frame) {
        zwlr_screencopy_frame_v1_destroy(ctx->pending_frame);
        ctx->pending_frame = NULL;
    }
    destroy_buffer(ctx);
    for (int i = 0; i < CAPTURE_DMABUF_SLOTS; i++)
        destroy_dmabuf_slot(&ctx->slots[i]);
    if (ctx->gbm) {
        gbm_device_destroy(ctx->gbm);
        ctx->gbm = NULL;
    }
    if (ctx->drm_fd >= 0) {
        close(ctx->drm_fd);
        ctx->drm_fd = -1;
    }
    if (ctx->dmabuf)
        zwp_linux_dmabuf_v1_destroy(ctx->dmabuf);

    if (ctx->screencopy_manager)
        zwlr_screencopy_manager_v1_destroy(ctx->screencopy_manager);
    if (ctx->virtual_pointer_manager)
        zwlr_virtual_pointer_manager_v1_destroy(ctx->virtual_pointer_manager);
    if (ctx->virtual_keyboard_manager)
        zwp_virtual_keyboard_manager_v1_destroy(ctx->virtual_keyboard_manager);
    if (ctx->seat)
        wl_seat_destroy(ctx->seat);
    if (ctx->shm)
        wl_shm_destroy(ctx->shm);
    if (ctx->registry)
        wl_registry_destroy(ctx->registry);
    if (ctx->display)
        wl_display_disconnect(ctx->display);
}
