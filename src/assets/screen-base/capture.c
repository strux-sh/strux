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

/* --- screencopy frame listener --- */

static void frame_buffer(void *data, struct zwlr_screencopy_frame_v1 *frame,
                         uint32_t format, uint32_t width, uint32_t height,
                         uint32_t stride)
{
    struct capture_context *ctx = data;
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
    (void)data; (void)frame; (void)format; (void)width; (void)height;
    /* We use wl_shm buffers, ignore DMA-BUF offers */
}

static void frame_buffer_done(void *data,
                              struct zwlr_screencopy_frame_v1 *frame)
{
    (void)data; (void)frame;
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

    ctx->running = true;
    return 0;
}

int capture_frame(struct capture_context *ctx)
{
    ctx->frame_ready = false;
    ctx->frame_failed = false;
    ctx->buffer_ready = false;

    /* Request a frame capture */
    struct zwlr_screencopy_frame_v1 *frame =
        zwlr_screencopy_manager_v1_capture_output(
            ctx->screencopy_manager, 1, ctx->output);
    zwlr_screencopy_frame_v1_add_listener(frame, &frame_listener, ctx);

    /* Wait for buffer info */
    while (!ctx->buffer_ready && !ctx->frame_failed) {
        if (wl_display_dispatch(ctx->display) < 0) {
            fprintf(stderr, "[strux-screen] Wayland dispatch error\n");
            zwlr_screencopy_frame_v1_destroy(frame);
            return -1;
        }
    }

    if (ctx->frame_failed) {
        zwlr_screencopy_frame_v1_destroy(frame);
        return -1;
    }

    fprintf(stderr, "[strux-screen] Buffer info: %ux%u stride=%u format=%u\n",
            ctx->width, ctx->height, ctx->stride, ctx->format);

    /* Create or recreate buffer if needed */
    if (!ctx->buffer) {
        fprintf(stderr, "[strux-screen] Creating shm buffer...\n");
        if (create_buffer(ctx) < 0) {
            zwlr_screencopy_frame_v1_destroy(frame);
            return -1;
        }
    }

    /* Copy the frame */
    zwlr_screencopy_frame_v1_copy(frame, ctx->buffer);

    /* Wait for ready or failed */
    while (!ctx->frame_ready && !ctx->frame_failed) {
        if (wl_display_dispatch(ctx->display) < 0) {
            fprintf(stderr, "[strux-screen] Wayland dispatch error\n");
            zwlr_screencopy_frame_v1_destroy(frame);
            return -1;
        }
    }

    zwlr_screencopy_frame_v1_destroy(frame);

    if (ctx->frame_failed)
        return -1;

    return 0;
}

void capture_destroy(struct capture_context *ctx)
{
    destroy_buffer(ctx);

    if (ctx->screencopy_manager)
        zwlr_screencopy_manager_v1_destroy(ctx->screencopy_manager);
    if (ctx->shm)
        wl_shm_destroy(ctx->shm);
    if (ctx->registry)
        wl_registry_destroy(ctx->registry);
    if (ctx->display)
        wl_display_disconnect(ctx->display);
}
