#ifndef STRUX_KEYBOARD_ICONS_H
#define STRUX_KEYBOARD_ICONS_H

#include <cairo/cairo.h>
#include <stdint.h>

enum keyboard_icon {
	KEYBOARD_ICON_SHIFT,
	KEYBOARD_ICON_BACKSPACE,
	KEYBOARD_ICON_CURSOR_LEFT,
	KEYBOARD_ICON_CURSOR_RIGHT,
	KEYBOARD_ICON_DISMISS,
	KEYBOARD_ICON_ENTER,
	KEYBOARD_ICON_EMOJI,
};

void keyboard_icon_draw(cairo_t *cr, enum keyboard_icon icon, double x, double y, double size, uint32_t color);

#endif
