#ifndef CG_OUTPUT_H
#define CG_OUTPUT_H

#include <sys/types.h>
#include <wayland-server-core.h>
#include <wlr/types/wlr_output.h>
#include <wlr/util/box.h>

#include "server.h"
#include "view.h"

struct cg_output {
	struct cg_server *server;
	struct wlr_output *wlr_output;
	struct wlr_scene_output *scene_output;

	struct wl_listener commit;
	struct wl_listener request_state;
	struct wl_listener destroy;
	struct wl_listener frame;

	/* Cog browser PID spawned for this output (per-view mode with display map) */
	pid_t cog_pid;
	pid_t keyboard_pid;
	int keyboard_control_fd;
	struct wl_event_source *keyboard_control_source;
	struct wl_event_source *keyboard_hide_timer;

	struct wlr_box usable_area;
	bool keyboard_visible;
	bool keyboard_hiding;
	bool keyboard_suppressed;

	struct wl_list link; // cg_server::outputs
};

void handle_output_manager_apply(struct wl_listener *listener, void *data);
void handle_output_manager_test(struct wl_listener *listener, void *data);
void handle_output_layout_change(struct wl_listener *listener, void *data);
void handle_new_output(struct wl_listener *listener, void *data);
void output_set_window_title(struct cg_output *output, const char *title);
void output_get_usable_box(struct cg_output *output, struct wlr_box *box);
void output_set_keyboard_visible(struct cg_output *output, bool visible, uint32_t purpose);
void output_update_usable_area(struct cg_output *output);
void output_start_keyboard(struct cg_output *output);

#endif
