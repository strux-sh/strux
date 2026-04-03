/*
 * Strux OS Splash Screen for Cage
 *
 * Provides splash screen with:
 * - Framebuffer rendering during early boot
 * - Wayland scene rendering (black background + centered image)
 * - Control socket for strux.boot.HideSplash()
 */

#define _POSIX_C_SOURCE 200809L

#include "splash.h"
#include "server.h"
#include "output.h"
#include "seat.h"

#include <wlr/types/wlr_cursor.h>
#include <wlr/types/wlr_xcursor_manager.h>

#include <errno.h>
#include <fcntl.h>
#include <png.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <drm_fourcc.h>
#include <wlr/interfaces/wlr_buffer.h>
#include <wlr/types/wlr_buffer.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/util/log.h>

#define STRUX_CONTROL_SOCKET "/tmp/strux-cage-control.sock"
#define FB_DEVICE "/dev/fb0"
#define FB_SYS_PATH "/sys/class/graphics/fb0/virtual_size"

/* ===== Data Buffer Implementation ===== */

struct data_buffer {
	struct wlr_buffer base;
	void *data;
	uint32_t format;
	size_t stride;
};

static void data_buffer_destroy(struct wlr_buffer *wlr_buffer)
{
	struct data_buffer *buffer = wl_container_of(wlr_buffer, buffer, base);
	free(buffer->data);
	free(buffer);
}

static bool data_buffer_begin_data_ptr_access(struct wlr_buffer *wlr_buffer,
	uint32_t flags, void **data, uint32_t *format, size_t *stride)
{
	struct data_buffer *buffer = wl_container_of(wlr_buffer, buffer, base);
	*data = buffer->data;
	*format = buffer->format;
	*stride = buffer->stride;
	return true;
}

static void data_buffer_end_data_ptr_access(struct wlr_buffer *wlr_buffer)
{
	// Nothing to do
}

static const struct wlr_buffer_impl data_buffer_impl = {
	.destroy = data_buffer_destroy,
	.begin_data_ptr_access = data_buffer_begin_data_ptr_access,
	.end_data_ptr_access = data_buffer_end_data_ptr_access,
};

static struct data_buffer *data_buffer_create(int width, int height, uint32_t format)
{
	struct data_buffer *buffer = calloc(1, sizeof(struct data_buffer));
	if (!buffer) {
		return NULL;
	}

	buffer->format = format;
	buffer->stride = width * 4;
	buffer->data = calloc(height, buffer->stride);
	if (!buffer->data) {
		free(buffer);
		return NULL;
	}

	wlr_buffer_init(&buffer->base, &data_buffer_impl, width, height);
	return buffer;
}

/* ===== PNG Loading ===== */

struct png_image {
	int width;
	int height;
	uint8_t *data; // RGBA format
};

static struct png_image *load_png(const char *path)
{
	FILE *fp = fopen(path, "rb");
	if (!fp) {
		wlr_log(WLR_ERROR, "Failed to open splash image: %s", path);
		return NULL;
	}

	png_structp png = png_create_read_struct(PNG_LIBPNG_VER_STRING, NULL, NULL, NULL);
	if (!png) {
		fclose(fp);
		return NULL;
	}

	png_infop info = png_create_info_struct(png);
	if (!info) {
		png_destroy_read_struct(&png, NULL, NULL);
		fclose(fp);
		return NULL;
	}

	if (setjmp(png_jmpbuf(png))) {
		png_destroy_read_struct(&png, &info, NULL);
		fclose(fp);
		return NULL;
	}

	png_init_io(png, fp);
	png_read_info(png, info);

	int width = png_get_image_width(png, info);
	int height = png_get_image_height(png, info);
	png_byte color_type = png_get_color_type(png, info);
	png_byte bit_depth = png_get_bit_depth(png, info);

	// Convert to RGBA
	if (bit_depth == 16) {
		png_set_strip_16(png);
	}
	if (color_type == PNG_COLOR_TYPE_PALETTE) {
		png_set_palette_to_rgb(png);
	}
	if (color_type == PNG_COLOR_TYPE_GRAY && bit_depth < 8) {
		png_set_expand_gray_1_2_4_to_8(png);
	}
	if (png_get_valid(png, info, PNG_INFO_tRNS)) {
		png_set_tRNS_to_alpha(png);
	}
	if (color_type == PNG_COLOR_TYPE_RGB || color_type == PNG_COLOR_TYPE_GRAY ||
	    color_type == PNG_COLOR_TYPE_PALETTE) {
		png_set_filler(png, 0xFF, PNG_FILLER_AFTER);
	}
	if (color_type == PNG_COLOR_TYPE_GRAY || color_type == PNG_COLOR_TYPE_GRAY_ALPHA) {
		png_set_gray_to_rgb(png);
	}

	png_read_update_info(png, info);

	struct png_image *img = calloc(1, sizeof(struct png_image));
	if (!img) {
		png_destroy_read_struct(&png, &info, NULL);
		fclose(fp);
		return NULL;
	}

	img->width = width;
	img->height = height;
	img->data = malloc(width * height * 4);
	if (!img->data) {
		free(img);
		png_destroy_read_struct(&png, &info, NULL);
		fclose(fp);
		return NULL;
	}

	png_bytep *row_pointers = malloc(sizeof(png_bytep) * height);
	for (int y = 0; y < height; y++) {
		row_pointers[y] = img->data + y * width * 4;
	}

	png_read_image(png, row_pointers);

	free(row_pointers);
	png_destroy_read_struct(&png, &info, NULL);
	fclose(fp);

	wlr_log(WLR_INFO, "Loaded splash image: %dx%d", width, height);
	return img;
}

static void free_png_image(struct png_image *img)
{
	if (img) {
		free(img->data);
		free(img);
	}
}

/* ===== Framebuffer Operations ===== */

static bool get_fb_resolution(int *width, int *height)
{
	FILE *f = fopen(FB_SYS_PATH, "r");
	if (f) {
		if (fscanf(f, "%d,%d", width, height) == 2) {
			fclose(f);
			if (*width > 0 && *height > 0) {
				wlr_log(WLR_INFO, "Detected framebuffer resolution: %dx%d", *width, *height);
				return true;
			}
		}
		fclose(f);
	}

	// Fallback
	*width = 1280;
	*height = 800;
	wlr_log(WLR_INFO, "Using fallback framebuffer resolution: %dx%d", *width, *height);
	return true;
}

static bool show_framebuffer_splash(const char *image_path)
{
	struct png_image *img = load_png(image_path);
	if (!img) {
		return false;
	}

	int fb_width, fb_height;
	if (!get_fb_resolution(&fb_width, &fb_height)) {
		free_png_image(img);
		return false;
	}

	int fb_fd = open(FB_DEVICE, O_RDWR);
	if (fb_fd < 0) {
		wlr_log(WLR_ERROR, "Failed to open framebuffer: %s", FB_DEVICE);
		free_png_image(img);
		return false;
	}

	size_t fb_size = fb_width * fb_height * 4;
	uint8_t *fb_mem = mmap(NULL, fb_size, PROT_READ | PROT_WRITE, MAP_SHARED, fb_fd, 0);
	if (fb_mem == MAP_FAILED) {
		wlr_log(WLR_ERROR, "Failed to mmap framebuffer");
		close(fb_fd);
		free_png_image(img);
		return false;
	}

	// Clear to black
	memset(fb_mem, 0, fb_size);

	// Center the image
	int offset_x = (fb_width - img->width) / 2;
	int offset_y = (fb_height - img->height) / 2;

	// Draw image (RGBA to BGRA conversion)
	for (int y = 0; y < img->height; y++) {
		int fb_y = offset_y + y;
		if (fb_y < 0 || fb_y >= fb_height) continue;

		for (int x = 0; x < img->width; x++) {
			int fb_x = offset_x + x;
			if (fb_x < 0 || fb_x >= fb_width) continue;

			uint8_t *src = img->data + (y * img->width + x) * 4;
			uint8_t *dst = fb_mem + (fb_y * fb_width + fb_x) * 4;

			dst[0] = src[2]; // B
			dst[1] = src[1]; // G
			dst[2] = src[0]; // R
			dst[3] = src[3]; // A
		}
	}

	munmap(fb_mem, fb_size);
	close(fb_fd);
	free_png_image(img);

	wlr_log(WLR_INFO, "Framebuffer splash displayed");
	return true;
}

static void clear_framebuffer(void)
{
	int fb_width, fb_height;
	if (!get_fb_resolution(&fb_width, &fb_height)) {
		return;
	}

	int fb_fd = open(FB_DEVICE, O_RDWR);
	if (fb_fd < 0) {
		return;
	}

	size_t fb_size = fb_width * fb_height * 4;
	uint8_t *fb_mem = mmap(NULL, fb_size, PROT_READ | PROT_WRITE, MAP_SHARED, fb_fd, 0);
	if (fb_mem != MAP_FAILED) {
		memset(fb_mem, 0, fb_size);
		munmap(fb_mem, fb_size);
	}
	close(fb_fd);
}

/* ===== Control Socket ===== */

// Context for client connection event source
struct client_context {
	struct cg_splash *splash;
	struct wl_event_source *source;
	int fd;
};

static int handle_control_message(int fd, uint32_t mask, void *data)
{
	struct client_context *ctx = data;
	char buffer[256];

	ssize_t n = recv(fd, buffer, sizeof(buffer) - 1, 0);
	if (n <= 0) {
		// Connection closed or error - remove event source and cleanup
		wl_event_source_remove(ctx->source);
		close(fd);
		free(ctx);
		return 0;
	}

	buffer[n] = '\0';

	if (strcmp(buffer, "HIDE_SPLASH") == 0) {
		wlr_log(WLR_INFO, "Received HIDE_SPLASH command");
		splash_hide(ctx->splash);
	}

	// Remove event source and cleanup after handling message
	wl_event_source_remove(ctx->source);
	close(fd);
	free(ctx);
	return 0;
}

static int handle_control_connection(int fd, uint32_t mask, void *data)
{
	struct cg_splash *splash = data;

	int client_fd = accept(splash->control_fd, NULL, NULL);
	if (client_fd < 0) {
		wlr_log(WLR_ERROR, "Failed to accept control connection: %s", strerror(errno));
		return 0;
	}

	// Create context for this client connection
	struct client_context *ctx = calloc(1, sizeof(struct client_context));
	if (!ctx) {
		close(client_fd);
		return 0;
	}
	ctx->splash = splash;
	ctx->fd = client_fd;

	struct wl_event_loop *loop = wl_display_get_event_loop(splash->server->wl_display);
	ctx->source = wl_event_loop_add_fd(loop, client_fd, WL_EVENT_READABLE, handle_control_message, ctx);

	return 0;
}

static bool setup_control_socket(struct cg_splash *splash)
{
	unlink(STRUX_CONTROL_SOCKET);

	splash->control_fd = socket(AF_UNIX, SOCK_STREAM, 0);
	if (splash->control_fd < 0) {
		wlr_log(WLR_ERROR, "Failed to create control socket");
		return false;
	}

	struct sockaddr_un addr = {0};
	addr.sun_family = AF_UNIX;
	strncpy(addr.sun_path, STRUX_CONTROL_SOCKET, sizeof(addr.sun_path) - 1);

	if (bind(splash->control_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
		wlr_log(WLR_ERROR, "Failed to bind control socket: %s", strerror(errno));
		close(splash->control_fd);
		splash->control_fd = -1;
		return false;
	}

	if (listen(splash->control_fd, 5) < 0) {
		wlr_log(WLR_ERROR, "Failed to listen on control socket");
		close(splash->control_fd);
		splash->control_fd = -1;
		return false;
	}

	chmod(STRUX_CONTROL_SOCKET, 0666);

	struct wl_event_loop *loop = wl_display_get_event_loop(splash->server->wl_display);
	splash->control_source = wl_event_loop_add_fd(loop, splash->control_fd,
						       WL_EVENT_READABLE, handle_control_connection, splash);

	wlr_log(WLR_INFO, "Control socket listening: %s", STRUX_CONTROL_SOCKET);
	return true;
}

/* ===== Wayland Scene Splash ===== */

struct cg_splash *splash_create(struct cg_server *server, const char *image_path)
{
	struct cg_splash *splash = calloc(1, sizeof(struct cg_splash));
	if (!splash) {
		return NULL;
	}

	splash->server = server;
	splash->control_fd = -1;
	splash->visible = false;

	if (image_path) {
		splash->image_path = strdup(image_path);

		// Show framebuffer splash immediately
		show_framebuffer_splash(image_path);

		// Pre-load image dimensions
		struct png_image *img = load_png(image_path);
		if (img) {
			splash->image_width = img->width;
			splash->image_height = img->height;
			free_png_image(img);
		}
	}

	// Setup control socket
	setup_control_socket(splash);

	wlr_log(WLR_INFO, "Splash system initialized");
	return splash;
}

void splash_show_wayland(struct cg_splash *splash)
{
	if (!splash || !splash->image_path || splash->visible) {
		return;
	}

	// Clear framebuffer now that Wayland is taking over
	clear_framebuffer();

	// Create scene tree for splash (will be raised to top)
	splash->tree = wlr_scene_tree_create(&splash->server->scene->tree);
	if (!splash->tree) {
		wlr_log(WLR_ERROR, "Failed to create splash scene tree");
		return;
	}

	// Get screen dimensions from first enabled output
	int screen_width = 1280;
	int screen_height = 800;

	struct cg_output *output;
	wl_list_for_each(output, &splash->server->outputs, link) {
		if (output->wlr_output->enabled) {
			screen_width = output->wlr_output->width;
			screen_height = output->wlr_output->height;
			break;
		}
	}

	// Create black background covering entire screen
	float black[4] = {0.0f, 0.0f, 0.0f, 1.0f};
	splash->background = wlr_scene_rect_create(splash->tree, screen_width, screen_height, black);
	if (!splash->background) {
		wlr_log(WLR_ERROR, "Failed to create splash background");
		return;
	}

	// Load and create image buffer
	struct png_image *img = load_png(splash->image_path);
	if (!img) {
		wlr_log(WLR_ERROR, "Failed to load splash image for Wayland");
		return;
	}

	// Create CPU-accessible data buffer for the image
	struct data_buffer *buffer = data_buffer_create(img->width, img->height, DRM_FORMAT_ARGB8888);
	if (!buffer) {
		wlr_log(WLR_ERROR, "Failed to allocate splash buffer");
		free_png_image(img);
		return;
	}

	// Convert RGBA to ARGB8888 directly into buffer
	uint32_t *dst = buffer->data;
	for (int y = 0; y < img->height; y++) {
		uint8_t *src_row = img->data + y * img->width * 4;
		for (int x = 0; x < img->width; x++) {
			uint8_t r = src_row[x * 4 + 0];
			uint8_t g = src_row[x * 4 + 1];
			uint8_t b = src_row[x * 4 + 2];
			uint8_t a = src_row[x * 4 + 3];
			dst[y * img->width + x] = (a << 24) | (r << 16) | (g << 8) | b;
		}
	}

	// Create scene buffer node
	splash->image = wlr_scene_buffer_create(splash->tree, &buffer->base);
	wlr_buffer_drop(&buffer->base); // Scene buffer holds reference

	if (!splash->image) {
		wlr_log(WLR_ERROR, "Failed to create splash scene buffer");
		free_png_image(img);
		return;
	}

	// Center the image
	int offset_x = (screen_width - img->width) / 2;
	int offset_y = (screen_height - img->height) / 2;
	wlr_scene_node_set_position(&splash->image->node, offset_x, offset_y);

	free_png_image(img);

	// Raise splash tree to top
	wlr_scene_node_raise_to_top(&splash->tree->node);

	// Hide cursor while splash is visible
	if (splash->server->seat && splash->server->seat->cursor) {
		wlr_cursor_unset_image(splash->server->seat->cursor);
	}

	splash->visible = true;
	wlr_log(WLR_INFO, "Wayland splash displayed (%dx%d centered on %dx%d) - visible now TRUE",
		splash->image_width, splash->image_height, screen_width, screen_height);
}

void splash_update_geometry(struct cg_splash *splash, int screen_width, int screen_height)
{
	if (!splash || !splash->visible) {
		return;
	}

	// Update background size
	if (splash->background) {
		wlr_scene_rect_set_size(splash->background, screen_width, screen_height);
	}

	// Re-center image
	if (splash->image) {
		int offset_x = (screen_width - splash->image_width) / 2;
		int offset_y = (screen_height - splash->image_height) / 2;
		wlr_scene_node_set_position(&splash->image->node, offset_x, offset_y);
	}

	// Keep on top
	wlr_scene_node_raise_to_top(&splash->tree->node);
}

void splash_hide(struct cg_splash *splash)
{
	if (!splash || !splash->visible) {
		return;
	}

	if (splash->tree) {
		wlr_scene_node_set_enabled(&splash->tree->node, false);
	}

	// Restore cursor (unless hidden by STRUX_HIDE_CURSOR)
	const char *hide_cursor = getenv("STRUX_HIDE_CURSOR");
	if (!(hide_cursor && strcmp(hide_cursor, "1") == 0) &&
	    splash->server->seat && splash->server->seat->cursor &&
	    splash->server->seat->xcursor_manager) {
		wlr_cursor_set_xcursor(splash->server->seat->cursor,
				       splash->server->seat->xcursor_manager, "default");
	}

	splash->visible = false;
	wlr_log(WLR_INFO, "Splash hidden");
}

void splash_destroy(struct cg_splash *splash)
{
	if (!splash) {
		return;
	}

	splash_hide(splash);

	if (splash->control_source) {
		wl_event_source_remove(splash->control_source);
	}
	if (splash->control_fd >= 0) {
		close(splash->control_fd);
		unlink(STRUX_CONTROL_SOCKET);
	}

	if (splash->tree) {
		wlr_scene_node_destroy(&splash->tree->node);
	}

	free(splash->image_path);
	free(splash);

	wlr_log(WLR_INFO, "Splash destroyed");
}
