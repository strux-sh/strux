/* Lightweight native vectors for the LawnLite keyboard action icons.
 *
 * Shift, backspace, cursor, and dismiss geometry is derived from the matching
 * Boxicons Basic SVGs used by LawnLite. Boxicons is MIT licensed:
 * https://github.com/box-icons/boxicons-core
 */

#include <math.h>

#include "keyboard_icons.h"

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static void
set_color(cairo_t *cr, uint32_t color)
{
	double alpha = ((color >> 24) & 0xff) / 255.0;
	double red = ((color >> 16) & 0xff) / 255.0;
	double green = ((color >> 8) & 0xff) / 255.0;
	double blue = (color & 0xff) / 255.0;
	cairo_set_source_rgba(cr, red, green, blue, alpha);
}

static void
draw_shift(cairo_t *cr)
{
	cairo_move_to(cr, 13, 18);
	cairo_line_to(cr, 13, 12);
	cairo_line_to(cr, 17, 12);
	cairo_line_to(cr, 12, 6);
	cairo_line_to(cr, 7, 12);
	cairo_line_to(cr, 11, 12);
	cairo_line_to(cr, 11, 18);
	cairo_close_path(cr);
	cairo_fill(cr);
}

static void
draw_backspace(cairo_t *cr)
{
	/* Exact bx-backspace v3.0.8 compound paths. */
	cairo_set_fill_rule(cr, CAIRO_FILL_RULE_EVEN_ODD);
	cairo_move_to(cr, 20, 4);
	cairo_line_to(cr, 8.51, 4);
	cairo_curve_to(cr, 7.87, 4, 7.26, 4.31, 6.88, 4.84);
	cairo_line_to(cr, 2.18, 11.42);
	cairo_curve_to(cr, 1.94, 11.77, 1.94, 12.23, 2.18, 12.58);
	cairo_line_to(cr, 6.88, 19.16);
	cairo_curve_to(cr, 7.25, 19.68, 7.86, 20, 8.51, 20);
	cairo_line_to(cr, 20, 20);
	cairo_curve_to(cr, 21.1, 20, 22, 19.1, 22, 18);
	cairo_line_to(cr, 22, 6);
	cairo_curve_to(cr, 22, 4.9, 21.1, 4, 20, 4);
	cairo_close_path(cr);
	cairo_move_to(cr, 20, 18);
	cairo_line_to(cr, 8.51, 18);
	cairo_line_to(cr, 4.22, 12);
	cairo_line_to(cr, 8.51, 6);
	cairo_line_to(cr, 20, 6);
	cairo_close_path(cr);
	cairo_fill(cr);
	cairo_set_fill_rule(cr, CAIRO_FILL_RULE_WINDING);

	cairo_move_to(cr, 9.79, 9.21);
	cairo_line_to(cr, 12.59, 12);
	cairo_line_to(cr, 9.79, 14.79);
	cairo_line_to(cr, 11.21, 16.21);
	cairo_line_to(cr, 14, 13.41);
	cairo_line_to(cr, 16.79, 16.21);
	cairo_line_to(cr, 18.21, 14.79);
	cairo_line_to(cr, 15.41, 12);
	cairo_line_to(cr, 18.21, 9.21);
	cairo_line_to(cr, 16.79, 7.79);
	cairo_line_to(cr, 14, 10.59);
	cairo_line_to(cr, 11.21, 7.79);
	cairo_close_path(cr);
	cairo_fill(cr);
}

static void
draw_cursor_left(cairo_t *cr)
{
	cairo_move_to(cr, 6, 12);
	cairo_line_to(cr, 12, 17);
	cairo_line_to(cr, 12, 13);
	cairo_line_to(cr, 18, 13);
	cairo_line_to(cr, 18, 11);
	cairo_line_to(cr, 12, 11);
	cairo_line_to(cr, 12, 7);
	cairo_close_path(cr);
	cairo_fill(cr);
}

static void
draw_cursor_right(cairo_t *cr)
{
	cairo_move_to(cr, 6, 13);
	cairo_line_to(cr, 12, 13);
	cairo_line_to(cr, 12, 17);
	cairo_line_to(cr, 18, 12);
	cairo_line_to(cr, 12, 7);
	cairo_line_to(cr, 12, 11);
	cairo_line_to(cr, 6, 11);
	cairo_close_path(cr);
	cairo_fill(cr);
}

static void
draw_dismiss(cairo_t *cr)
{
	cairo_move_to(cr, 12, 15.41);
	cairo_line_to(cr, 17.71, 9.71);
	cairo_line_to(cr, 16.29, 8.29);
	cairo_line_to(cr, 12, 12.59);
	cairo_line_to(cr, 7.71, 8.29);
	cairo_line_to(cr, 6.29, 9.71);
	cairo_close_path(cr);
	cairo_fill(cr);
}

static void
draw_enter(cairo_t *cr)
{
	cairo_set_line_width(cr, 2);
	cairo_set_line_cap(cr, CAIRO_LINE_CAP_ROUND);
	cairo_set_line_join(cr, CAIRO_LINE_JOIN_ROUND);
	cairo_move_to(cr, 18, 7);
	cairo_line_to(cr, 18, 11);
	cairo_curve_to(cr, 18, 13.2, 16.2, 15, 14, 15);
	cairo_line_to(cr, 7, 15);
	cairo_move_to(cr, 10, 11.5);
	cairo_line_to(cr, 6.5, 15);
	cairo_line_to(cr, 10, 18.5);
	cairo_stroke(cr);
}

static void
draw_emoji(cairo_t *cr)
{
	cairo_set_line_width(cr, 1.6);
	cairo_arc(cr, 12, 12, 7, 0, 2 * M_PI);
	cairo_stroke(cr);
	cairo_arc(cr, 9.5, 10, 0.8, 0, 2 * M_PI);
	cairo_fill(cr);
	cairo_arc(cr, 14.5, 10, 0.8, 0, 2 * M_PI);
	cairo_fill(cr);
	cairo_arc(cr, 12, 12, 4, 0.25, M_PI - 0.25);
	cairo_stroke(cr);
}

void
keyboard_icon_draw(cairo_t *cr, enum keyboard_icon icon, double x, double y, double size, uint32_t color)
{
	cairo_save(cr);
	cairo_translate(cr, x, y);
	cairo_scale(cr, size / 24.0, size / 24.0);
	set_color(cr, color);

	switch (icon) {
	case KEYBOARD_ICON_SHIFT:
		draw_shift(cr);
		break;
	case KEYBOARD_ICON_BACKSPACE:
		draw_backspace(cr);
		break;
	case KEYBOARD_ICON_CURSOR_LEFT:
		draw_cursor_left(cr);
		break;
	case KEYBOARD_ICON_CURSOR_RIGHT:
		draw_cursor_right(cr);
		break;
	case KEYBOARD_ICON_DISMISS:
		draw_dismiss(cr);
		break;
	case KEYBOARD_ICON_ENTER:
		draw_enter(cr);
		break;
	case KEYBOARD_ICON_EMOJI:
		draw_emoji(cr);
		break;
	}

	cairo_restore(cr);
}
