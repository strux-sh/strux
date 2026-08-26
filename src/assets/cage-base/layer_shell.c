/* Strux-owned layer-shell support for the out-of-process touch keyboard. */

#include <stdlib.h>
#include <string.h>
#include <wayland-server-core.h>
#include <wlr/types/wlr_layer_shell_v1.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/util/log.h>

#include "layer_shell.h"
#include "output.h"
#include "server.h"
#include "view.h"

#define STRUX_KEYBOARD_NAMESPACE "strux-keyboard"

struct cg_layer_surface {
	struct cg_server *server;
	struct cg_output *output;
	struct wlr_layer_surface_v1 *layer_surface;
	struct wlr_scene_layer_surface_v1 *scene;
	bool is_keyboard;

	struct wl_listener commit;
	struct wl_listener map;
	struct wl_listener unmap;
	struct wl_listener destroy;
	struct wl_list link;
};

static void
layer_surface_update(struct cg_layer_surface *surface)
{
	if (!surface->output) {
		return;
	}
	output_update_usable_area(surface->output);
	view_position_all(surface->server);
}

void
layer_shell_arrange_output(struct cg_output *output, struct wlr_box *usable_area)
{
	struct wlr_box full_area;
	wlr_output_layout_get_box(output->server->output_layout, output->wlr_output, &full_area);
	*usable_area = full_area;

	struct cg_layer_surface *surface;
	wl_list_for_each (surface, &output->server->layer_surfaces, link) {
		if (surface->output != output) {
			continue;
		}

		if (surface->is_keyboard && !output->keyboard_visible) {
			struct wlr_box ignored_usable_area = full_area;
			wlr_scene_layer_surface_v1_configure(surface->scene, &full_area, &ignored_usable_area);
			wlr_scene_node_set_enabled(&surface->scene->tree->node, false);
			continue;
		}

		wlr_scene_node_set_enabled(&surface->scene->tree->node, true);
		wlr_scene_layer_surface_v1_configure(surface->scene, &full_area, usable_area);
	}
}

void
layer_shell_output_destroyed(struct cg_output *output)
{
	struct cg_layer_surface *surface, *temporary;
	wl_list_for_each_safe (surface, temporary, &output->server->layer_surfaces, link) {
		if (surface->output == output) {
			wlr_layer_surface_v1_destroy(surface->layer_surface);
		}
	}
}

static void
handle_layer_surface_commit(struct wl_listener *listener, void *data)
{
	struct cg_layer_surface *surface = wl_container_of(listener, surface, commit);
	struct wlr_layer_surface_v1 *layer_surface = surface->layer_surface;

	if (!surface->output && layer_surface->output) {
		surface->output = layer_surface->output->data;
	}

	if (!surface->output) {
		wlr_log(WLR_ERROR, "Layer surface has no output");
		wlr_layer_surface_v1_destroy(layer_surface);
		return;
	}

	if (surface->is_keyboard &&
	    layer_surface->current.keyboard_interactive != ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE) {
		wlr_log(WLR_ERROR, "Rejecting keyboard layer surface that can take keyboard focus");
		wlr_layer_surface_v1_destroy(layer_surface);
		return;
	}

	layer_surface_update(surface);
}

static void
handle_layer_surface_map(struct wl_listener *listener, void *data)
{
	struct cg_layer_surface *surface = wl_container_of(listener, surface, map);
	layer_surface_update(surface);
}

static void
handle_layer_surface_unmap(struct wl_listener *listener, void *data)
{
	struct cg_layer_surface *surface = wl_container_of(listener, surface, unmap);
	layer_surface_update(surface);
}

static void
handle_layer_surface_destroy(struct wl_listener *listener, void *data)
{
	struct cg_layer_surface *surface = wl_container_of(listener, surface, destroy);
	struct cg_output *output = surface->output;

	wl_list_remove(&surface->commit.link);
	wl_list_remove(&surface->map.link);
	wl_list_remove(&surface->unmap.link);
	wl_list_remove(&surface->destroy.link);
	wl_list_remove(&surface->link);
	free(surface);

	if (output) {
		output_update_usable_area(output);
		view_position_all(output->server);
	}
}

void
handle_new_layer_surface(struct wl_listener *listener, void *data)
{
	struct cg_server *server = wl_container_of(listener, server, new_layer_surface);
	struct wlr_layer_surface_v1 *layer_surface = data;

	if (strcmp(layer_surface->namespace, STRUX_KEYBOARD_NAMESPACE) != 0) {
		wlr_log(WLR_ERROR, "Rejecting unsupported layer-shell namespace '%s'", layer_surface->namespace);
		wlr_layer_surface_v1_destroy(layer_surface);
		return;
	}

	struct cg_layer_surface *surface = calloc(1, sizeof(*surface));
	if (!surface) {
		wl_resource_post_no_memory(layer_surface->resource);
		return;
	}

	surface->server = server;
	surface->layer_surface = layer_surface;
	surface->is_keyboard = true;
	if (layer_surface->output) {
		surface->output = layer_surface->output->data;
	}

	surface->scene = wlr_scene_layer_surface_v1_create(server->overlay_tree, layer_surface);
	if (!surface->scene) {
		wl_resource_post_no_memory(layer_surface->resource);
		free(surface);
		return;
	}
	wlr_scene_node_set_enabled(&surface->scene->tree->node, false);

	wl_list_insert(&server->layer_surfaces, &surface->link);
	surface->commit.notify = handle_layer_surface_commit;
	wl_signal_add(&layer_surface->surface->events.commit, &surface->commit);
	surface->map.notify = handle_layer_surface_map;
	wl_signal_add(&layer_surface->surface->events.map, &surface->map);
	surface->unmap.notify = handle_layer_surface_unmap;
	wl_signal_add(&layer_surface->surface->events.unmap, &surface->unmap);
	surface->destroy.notify = handle_layer_surface_destroy;
	wl_signal_add(&layer_surface->events.destroy, &surface->destroy);
}
