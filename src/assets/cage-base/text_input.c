/* Text-input-v3 is used only to drive OSK visibility and layout semantics.
 * Editing continues through real virtual-keyboard events. */

#include <stdbool.h>
#include <stdlib.h>
#include <wayland-server-core.h>
#include <wlr/types/wlr_text_input_v3.h>

#include "output.h"
#include "seat.h"
#include "server.h"
#include "text_input.h"
#include "view.h"

struct cg_text_input {
	struct cg_server *server;
	struct wlr_text_input_v3 *text_input;
	struct cg_output *active_output;
	bool enabled;

	struct wl_listener enable;
	struct wl_listener commit;
	struct wl_listener disable;
	struct wl_listener destroy;
	struct wl_list link;
};

static struct cg_output *
text_input_output(struct cg_text_input *input)
{
	struct wlr_surface *surface = input->text_input->focused_surface;
	if (!surface || !surface->data) {
		return NULL;
	}

	struct cg_view *view = view_from_wlr_surface(surface);
	return view ? view->assigned_output : NULL;
}

static void
deactivate_text_input(struct cg_text_input *input)
{
	if (input->active_output) {
		output_set_keyboard_visible(input->active_output, false, 0);
		input->active_output = NULL;
	}
}

static void
activate_text_input(struct cg_text_input *input, bool clear_suppression)
{
	struct cg_output *output = text_input_output(input);
	if (!output) {
		deactivate_text_input(input);
		return;
	}

	if (input->active_output && input->active_output != output) {
		output_set_keyboard_visible(input->active_output, false, 0);
	}
	input->active_output = output;
	if (clear_suppression) {
		output->keyboard_suppressed = false;
	}
	output_set_keyboard_visible(output, !output->keyboard_suppressed,
		input->text_input->current.content_type.purpose);
}

static void
handle_text_input_enable(struct wl_listener *listener, void *data)
{
	struct cg_text_input *input = wl_container_of(listener, input, enable);
	input->enabled = true;
	activate_text_input(input, true);
}

static void
handle_text_input_commit(struct wl_listener *listener, void *data)
{
	struct cg_text_input *input = wl_container_of(listener, input, commit);
	if (input->enabled) {
		activate_text_input(input, false);
	}
}

static void
handle_text_input_disable(struct wl_listener *listener, void *data)
{
	struct cg_text_input *input = wl_container_of(listener, input, disable);
	input->enabled = false;
	deactivate_text_input(input);
}

static void
handle_text_input_destroy(struct wl_listener *listener, void *data)
{
	struct cg_text_input *input = wl_container_of(listener, input, destroy);
	deactivate_text_input(input);
	wl_list_remove(&input->enable.link);
	wl_list_remove(&input->commit.link);
	wl_list_remove(&input->disable.link);
	wl_list_remove(&input->destroy.link);
	wl_list_remove(&input->link);
	free(input);
}

void
handle_new_text_input(struct wl_listener *listener, void *data)
{
	struct cg_server *server = wl_container_of(listener, server, new_text_input);
	struct wlr_text_input_v3 *text_input = data;
	struct cg_text_input *input = calloc(1, sizeof(*input));
	if (!input) {
		wl_resource_post_no_memory(text_input->resource);
		return;
	}

	input->server = server;
	input->text_input = text_input;
	wl_list_insert(&server->text_inputs, &input->link);

	input->enable.notify = handle_text_input_enable;
	wl_signal_add(&text_input->events.enable, &input->enable);
	input->commit.notify = handle_text_input_commit;
	wl_signal_add(&text_input->events.commit, &input->commit);
	input->disable.notify = handle_text_input_disable;
	wl_signal_add(&text_input->events.disable, &input->disable);
	input->destroy.notify = handle_text_input_destroy;
	wl_signal_add(&text_input->events.destroy, &input->destroy);

	struct wlr_surface *focused = server->seat->seat->keyboard_state.focused_surface;
	if (focused && wl_resource_get_client(focused->resource) == wl_resource_get_client(text_input->resource)) {
		wlr_text_input_v3_send_enter(text_input, focused);
	}
}

void
text_input_set_focus(struct cg_server *server, struct wlr_surface *surface)
{
	struct cg_text_input *input;
	wl_list_for_each (input, &server->text_inputs, link) {
		struct wlr_text_input_v3 *text_input = input->text_input;
		bool focus_changed = text_input->focused_surface != surface;
		if (text_input->focused_surface && focus_changed) {
			deactivate_text_input(input);
			wlr_text_input_v3_send_leave(text_input);
		}

		if (!text_input->focused_surface && surface &&
		    wl_resource_get_client(surface->resource) == wl_resource_get_client(text_input->resource)) {
			wlr_text_input_v3_send_enter(text_input, surface);
			if (input->enabled) {
				activate_text_input(input, focus_changed);
			}
		}
	}
}

void
text_input_output_destroyed(struct cg_server *server, struct cg_output *output)
{
	struct cg_text_input *input;
	wl_list_for_each (input, &server->text_inputs, link) {
		if (input->active_output == output) {
			input->active_output = NULL;
		}
	}
}
