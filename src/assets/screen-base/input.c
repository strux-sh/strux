/*
 * strux-screen: virtual input injection
 *
 * Creates a virtual pointer (wlr-virtual-pointer-unstable-v1) and virtual
 * keyboard (virtual-keyboard-unstable-v1) on the compositor and translates
 * normalized input commands into Wayland events. The keyboard keymap is the
 * xkbcommon system default (us/pc105), matching the evdev keycodes and
 * modifier masks the web UI sends.
 */

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#include <xkbcommon/xkbcommon.h>

#include "input.h"

/* Extent used for absolute pointer coordinates; the compositor scales the
 * position onto the mapped output, so any fixed extent works. */
#define POINTER_EXTENT 65535

/* Browser wheel deltas are ~100px per notch; Wayland axis values are ~10
 * per notch ("length of vector in touchpad coordinates"). */
#define AXIS_SCALE 0.1

static uint32_t now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint32_t)((uint64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

/* --- Keymap upload --- */

static int create_anon_file(size_t size)
{
    char name[] = "/strux-screen-keymap-XXXXXX";
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

static int upload_keymap(struct input_context *in)
{
    struct xkb_context *xkb = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    if (!xkb) {
        fprintf(stderr, "[strux-screen] Failed to create xkb context\n");
        return -1;
    }

    /* System defaults: rules=evdev, model=pc105, layout=us */
    struct xkb_keymap *keymap =
        xkb_keymap_new_from_names(xkb, NULL, XKB_KEYMAP_COMPILE_NO_FLAGS);
    if (!keymap) {
        fprintf(stderr, "[strux-screen] Failed to compile default keymap "
                        "(is xkeyboard-config installed?)\n");
        xkb_context_unref(xkb);
        return -1;
    }

    char *str = xkb_keymap_get_as_string(keymap, XKB_KEYMAP_FORMAT_TEXT_V1);
    xkb_keymap_unref(keymap);
    xkb_context_unref(xkb);
    if (!str) {
        fprintf(stderr, "[strux-screen] Failed to serialize keymap\n");
        return -1;
    }

    size_t size = strlen(str) + 1;
    int fd = create_anon_file(size);
    if (fd < 0) {
        fprintf(stderr, "[strux-screen] Failed to create keymap file\n");
        free(str);
        return -1;
    }

    size_t written = 0;
    while (written < size) {
        ssize_t n = write(fd, str + written, size - written);
        if (n < 0) {
            fprintf(stderr, "[strux-screen] Failed to write keymap\n");
            free(str);
            close(fd);
            return -1;
        }
        written += (size_t)n;
    }
    free(str);

    zwp_virtual_keyboard_v1_keymap(in->keyboard,
                                   WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1,
                                   fd, (uint32_t)size);
    wl_display_flush(in->display);
    close(fd);

    return 0;
}

/* --- Public API --- */

int input_init(struct input_context *in, struct capture_context *cap)
{
    memset(in, 0, sizeof(*in));
    in->display = cap->display;

    if (cap->virtual_pointer_manager) {
        if (cap->virtual_pointer_manager_version >= 2 && cap->output) {
            in->pointer =
                zwlr_virtual_pointer_manager_v1_create_virtual_pointer_with_output(
                    cap->virtual_pointer_manager, cap->seat, cap->output);
        } else {
            in->pointer = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(
                cap->virtual_pointer_manager, cap->seat);
        }
        in->pointer_ok = in->pointer != NULL;
    } else {
        fprintf(stderr, "[strux-screen] Compositor lacks wlr-virtual-pointer; "
                        "pointer injection disabled\n");
    }

    if (cap->virtual_keyboard_manager && cap->seat) {
        in->keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(
            cap->virtual_keyboard_manager, cap->seat);
        if (in->keyboard && upload_keymap(in) == 0) {
            in->keyboard_ok = true;
        }
    } else {
        fprintf(stderr, "[strux-screen] Compositor lacks virtual-keyboard "
                        "(or no seat); keyboard injection disabled\n");
    }

    wl_display_flush(in->display);
    return (in->pointer_ok || in->keyboard_ok) ? 0 : -1;
}

void input_destroy(struct input_context *in)
{
    if (in->pointer) {
        zwlr_virtual_pointer_v1_destroy(in->pointer);
        in->pointer = NULL;
    }
    if (in->keyboard) {
        zwp_virtual_keyboard_v1_destroy(in->keyboard);
        in->keyboard = NULL;
    }
    in->pointer_ok = false;
    in->keyboard_ok = false;
}

void input_pointer_motion(struct input_context *in, double x, double y)
{
    if (!in->pointer_ok)
        return;

    if (x < 0.0) x = 0.0;
    if (x > 1.0) x = 1.0;
    if (y < 0.0) y = 0.0;
    if (y > 1.0) y = 1.0;

    zwlr_virtual_pointer_v1_motion_absolute(in->pointer, now_ms(),
                                            (uint32_t)(x * POINTER_EXTENT),
                                            (uint32_t)(y * POINTER_EXTENT),
                                            POINTER_EXTENT, POINTER_EXTENT);
    zwlr_virtual_pointer_v1_frame(in->pointer);
    wl_display_flush(in->display);
}

void input_pointer_button(struct input_context *in, uint32_t button,
                          bool pressed)
{
    if (!in->pointer_ok)
        return;

    zwlr_virtual_pointer_v1_button(in->pointer, now_ms(), button,
                                   pressed ? WL_POINTER_BUTTON_STATE_PRESSED
                                           : WL_POINTER_BUTTON_STATE_RELEASED);
    zwlr_virtual_pointer_v1_frame(in->pointer);
    wl_display_flush(in->display);
}

void input_pointer_axis(struct input_context *in, bool horizontal,
                        double value)
{
    if (!in->pointer_ok)
        return;

    uint32_t axis = horizontal ? WL_POINTER_AXIS_HORIZONTAL_SCROLL
                               : WL_POINTER_AXIS_VERTICAL_SCROLL;

    zwlr_virtual_pointer_v1_axis_source(in->pointer,
                                        WL_POINTER_AXIS_SOURCE_WHEEL);
    zwlr_virtual_pointer_v1_axis(in->pointer, now_ms(), axis,
                                 wl_fixed_from_double(value * AXIS_SCALE));
    zwlr_virtual_pointer_v1_frame(in->pointer);
    wl_display_flush(in->display);
}

void input_keyboard_key(struct input_context *in, uint32_t keycode,
                        bool pressed)
{
    if (!in->keyboard_ok)
        return;

    zwp_virtual_keyboard_v1_key(in->keyboard, now_ms(), keycode,
                                pressed ? WL_KEYBOARD_KEY_STATE_PRESSED
                                        : WL_KEYBOARD_KEY_STATE_RELEASED);
    wl_display_flush(in->display);
}

void input_keyboard_modifiers(struct input_context *in, uint32_t depressed,
                              uint32_t latched, uint32_t locked,
                              uint32_t group)
{
    if (!in->keyboard_ok)
        return;

    zwp_virtual_keyboard_v1_modifiers(in->keyboard, depressed, latched,
                                      locked, group);
    wl_display_flush(in->display);
}
