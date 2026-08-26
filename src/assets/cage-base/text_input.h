#ifndef CG_TEXT_INPUT_H
#define CG_TEXT_INPUT_H

#include <wayland-server-core.h>

struct cg_server;
struct cg_output;
struct wlr_surface;

void handle_new_text_input(struct wl_listener *listener, void *data);
void text_input_set_focus(struct cg_server *server, struct wlr_surface *surface);
void text_input_output_destroyed(struct cg_server *server, struct cg_output *output);

#endif
