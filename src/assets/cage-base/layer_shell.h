#ifndef CG_LAYER_SHELL_H
#define CG_LAYER_SHELL_H

#include <stdbool.h>
#include <wayland-server-core.h>
#include <wlr/util/box.h>

struct cg_output;
struct cg_server;

void handle_new_layer_surface(struct wl_listener *listener, void *data);
void layer_shell_arrange_output(struct cg_output *output, struct wlr_box *usable_area);
void layer_shell_output_destroyed(struct cg_output *output);

#endif
