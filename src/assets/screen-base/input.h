#ifndef STRUX_SCREEN_INPUT_H
#define STRUX_SCREEN_INPUT_H

#include <stdbool.h>
#include <stdint.h>

#include "capture.h"
#include "wlr-virtual-pointer-unstable-v1-client-protocol.h"
#include "virtual-keyboard-unstable-v1-client-protocol.h"

/*
 * Virtual input injection via the compositor's wlr-virtual-pointer and
 * virtual-keyboard protocols. Shares the capture context's Wayland display;
 * the managers and seat are bound in capture.c's registry listener.
 */

struct input_context {
    struct wl_display *display;
    struct zwlr_virtual_pointer_v1 *pointer;
    struct zwp_virtual_keyboard_v1 *keyboard;
    bool pointer_ok;
    bool keyboard_ok;
};

/* Create virtual devices from the globals bound on the capture context.
 * Returns 0 if at least one device is available. */
int input_init(struct input_context *in, struct capture_context *cap);

void input_destroy(struct input_context *in);

/* x/y are normalized 0..1 within the target output */
void input_pointer_motion(struct input_context *in, double x, double y);

/* button is a Linux evdev button code (BTN_LEFT, ...) */
void input_pointer_button(struct input_context *in, uint32_t button,
                          bool pressed);

/* value is a browser wheel delta in pixels (scaled internally) */
void input_pointer_axis(struct input_context *in, bool horizontal,
                        double value);

/* keycode is a Linux evdev keycode (xkb keycode - 8) */
void input_keyboard_key(struct input_context *in, uint32_t keycode,
                        bool pressed);

/* xkb modifier masks for the default keymap */
void input_keyboard_modifiers(struct input_context *in, uint32_t depressed,
                              uint32_t latched, uint32_t locked,
                              uint32_t group);

#endif /* STRUX_SCREEN_INPUT_H */
