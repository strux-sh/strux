#define _GNU_SOURCE

#include <cairo/cairo.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/input-event-codes.h>
#include <math.h>
#include <poll.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>

#include "virtual-keyboard-unstable-v1-client-protocol.h"
#include "wlr-layer-shell-unstable-v1-client-protocol.h"
#include "keyboard_icons.h"

#define TOOLBAR_HEIGHT 44
#define STATUS_HEIGHT 29
#define KEY_HEIGHT 64
#define KEY_GAP 6
#define KEYBOARD_EDGE_PADDING 6
#define KEYBOARD_BOTTOM_PADDING 6
#define KEYBOARD_HEIGHT (TOOLBAR_HEIGHT + STATUS_HEIGHT + 4 * KEY_HEIGHT + 3 * KEY_GAP + KEYBOARD_BOTTOM_PADDING)
#define NUMERIC_KEYBOARD_HEIGHT (TOOLBAR_HEIGHT + 4 * KEY_HEIGHT + 3 * KEY_GAP + KEYBOARD_BOTTOM_PADDING)
#define KEYBOARD_MAX_WIDTH 824
#define NUMERIC_MAX_WIDTH 234
#define SHOW_ANIMATION_MS 120
#define HIDE_ANIMATION_MS 90
#define ANIMATION_TRANSLATE_Y 24
#define ANIMATION_INPUT_THRESHOLD 0.55
#define BACKSPACE_REPEAT_DELAY_MS 400
#define BACKSPACE_REPEAT_INTERVAL_MS 60
#define SPACE_DRAG_DEAD_ZONE 8
#define SPACE_DRAG_STEP 14
#define CLICK_SAMPLE_RATE 48000
#define CLICK_DURATION_MS 24
#define CLICK_SAMPLE_COUNT (CLICK_SAMPLE_RATE * CLICK_DURATION_MS / 1000)
#define CLICK_MAX_PENDING 2
#define CLICK_RECONNECT_MS 1000

/* Minimal declarations for the stable libpulse-simple ABI. Loading it at
 * runtime keeps the keyboard usable on BSPs that intentionally ship no audio
 * stack, while audio-capable targets retain a single warm playback stream. */
struct pa_simple;
struct pa_sample_spec {
	int format;
	uint32_t rate;
	uint8_t channels;
};
struct pa_buffer_attr {
	uint32_t maxlength;
	uint32_t tlength;
	uint32_t prebuf;
	uint32_t minreq;
	uint32_t fragsize;
};

#define PA_STREAM_PLAYBACK 1
#if __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
#define PA_SAMPLE_S16_NATIVE 3
#else
#define PA_SAMPLE_S16_NATIVE 4
#endif

typedef struct pa_simple *(*pa_simple_new_fn)(const char *, const char *, int, const char *,
	const char *, const struct pa_sample_spec *, const void *, const void *, int *);
typedef int (*pa_simple_write_fn)(struct pa_simple *, const void *, size_t, int *);
typedef void (*pa_simple_free_fn)(struct pa_simple *);

enum key_type {
	KB_KEY_CHARACTER,
	KB_KEY_BACKSPACE,
	KB_KEY_ENTER,
	KB_KEY_SHIFT,
	KB_KEY_MODE,
	KB_KEY_CURSOR,
	KB_KEY_SPACE,
	KB_KEY_SPACER,
};

enum keyboard_mode {
	MODE_LETTERS,
	MODE_SYMBOLS,
	MODE_EMOJI,
};

enum keyboard_layout {
	LAYOUT_DEFAULT,
	LAYOUT_EMAIL,
	LAYOUT_URL,
	LAYOUT_NUMERIC,
};

enum click_sound {
	CLICK_SOUND_NONE,
	CLICK_SOUND_KEY,
	CLICK_SOUND_MODIFIER,
	CLICK_SOUND_SPACE,
	CLICK_SOUND_COUNT,
};

struct key {
	enum key_type type;
	const char *label;
	const char *shift_label;
	double weight;
	enum keyboard_mode mode;
};

struct key_row {
	const struct key *keys;
	size_t count;
};

struct key_hitbox {
	const struct key *key;
	double x;
	double y;
	double width;
	double height;
};

struct keyboard;

struct output_info {
	struct wl_output *output;
	char *name;
	int32_t scale;
	struct output_info *next;
};

struct keyboard_buffer {
	struct keyboard *keyboard;
	struct wl_buffer *buffer;
	void *data;
	size_t size;
	uint32_t pixel_width;
	uint32_t pixel_height;
	uint32_t stride;
	cairo_surface_t *image;
	bool busy;
	bool stale;
	struct keyboard_buffer *next;
};

struct click_audio {
	pthread_t thread;
	int pipe_fds[2];
	atomic_bool running;
	atomic_bool ready;
	atomic_uint pending;
	bool enabled;
	bool started;
	double volume;
	void *pulse_library;
	struct pa_simple *stream;
	pa_simple_new_fn simple_new;
	pa_simple_write_fn simple_write;
	pa_simple_free_fn simple_free;
	int16_t samples[CLICK_SOUND_COUNT][CLICK_SAMPLE_COUNT];
};

struct keyboard {
	struct wl_display *display;
	struct wl_registry *registry;
	struct wl_compositor *compositor;
	struct wl_shm *shm;
	struct wl_seat *seat;
	struct wl_touch *touch;
	struct zwlr_layer_shell_v1 *layer_shell;
	struct zwlr_layer_surface_v1 *layer_surface;
	struct zwp_virtual_keyboard_manager_v1 *virtual_keyboard_manager;
	struct zwp_virtual_keyboard_v1 *virtual_keyboard;
	struct wl_surface *surface;
	struct output_info *outputs;
	struct output_info *target_output;
	char *target_output_name;
	int control_fd;

	struct xkb_context *xkb_context;
	struct xkb_keymap *xkb_keymap;

	uint32_t width;
	uint32_t height;
	bool configured;
	bool running;
	bool visible;
	enum keyboard_layout layout;
	enum keyboard_mode mode;
	bool shifted;
	bool caps_locked;
	uint64_t last_shift_press_ms;
	double animation_progress;
	double animation_start_progress;
	double visual_offset_y;
	uint64_t animation_started_us;
	uint64_t animation_duration_us;
	bool animation_running;
	bool hide_completion_pending;

	struct key_hitbox hitboxes[96];
	size_t hitbox_count;
	const struct key *active_key;
	int32_t active_touch_id;
	double touch_start_x;
	double touch_last_x;
	bool space_dragging;
	uint64_t backspace_repeat_at_ms;

	struct keyboard_buffer *buffers;
	struct wl_callback *frame_callback;
	bool redraw_requested;
	bool profile_rendering;
	uint64_t render_count;
	uint64_t render_total_us;
	uint64_t render_max_us;
	uint64_t buffer_allocations;
	uint32_t shift_modifier_mask;
	struct click_audio click_audio;
};

#define ARRAY_LENGTH(array) (sizeof(array) / sizeof((array)[0]))
#define CHAR(label) {KB_KEY_CHARACTER, label, NULL, 1.0, MODE_LETTERS}
#define CHAR_SHIFT(label, shifted) {KB_KEY_CHARACTER, label, shifted, 1.0, MODE_LETTERS}
#define WEIGHTED_CHAR(label, shifted, key_weight) {KB_KEY_CHARACTER, label, shifted, key_weight, MODE_LETTERS}
#define SYSTEM(type, label, key_weight) {type, label, NULL, key_weight, MODE_LETTERS}
#define MODE_KEY(label, target, key_weight) {KB_KEY_MODE, label, NULL, key_weight, target}
#define SPACER(key_weight) {KB_KEY_SPACER, "", NULL, key_weight, MODE_LETTERS}

static const struct key letters_row_1[] = {
	CHAR_SHIFT("q", "Q"), CHAR_SHIFT("w", "W"), CHAR_SHIFT("e", "E"), CHAR_SHIFT("r", "R"),
	CHAR_SHIFT("t", "T"), CHAR_SHIFT("y", "Y"), CHAR_SHIFT("u", "U"), CHAR_SHIFT("i", "I"),
	CHAR_SHIFT("o", "O"), CHAR_SHIFT("p", "P"), SYSTEM(KB_KEY_BACKSPACE, "⌫", 1.5),
};
static const struct key letters_row_2[] = {
	SPACER(0.45), CHAR_SHIFT("a", "A"), CHAR_SHIFT("s", "S"), CHAR_SHIFT("d", "D"),
	CHAR_SHIFT("f", "F"), CHAR_SHIFT("g", "G"), CHAR_SHIFT("h", "H"), CHAR_SHIFT("j", "J"),
	CHAR_SHIFT("k", "K"), CHAR_SHIFT("l", "L"), SYSTEM(KB_KEY_ENTER, "↵", 2.05),
};
static const struct key letters_row_3[] = {
	SYSTEM(KB_KEY_SHIFT, "⇧", 1.35), CHAR_SHIFT("z", "Z"), CHAR_SHIFT("x", "X"),
	CHAR_SHIFT("c", "C"), CHAR_SHIFT("v", "V"), CHAR_SHIFT("b", "B"), CHAR_SHIFT("n", "N"),
	CHAR_SHIFT("m", "M"), CHAR_SHIFT(",", "<"), CHAR_SHIFT(".", ">"), SYSTEM(KB_KEY_SHIFT, "⇧", 1.15),
};
static const struct key default_bottom[] = {
	MODE_KEY("&123", MODE_SYMBOLS, 1.35), MODE_KEY("☺", MODE_EMOJI, 1.1),
	SYSTEM(KB_KEY_CURSOR, "←", 1.0), SYSTEM(KB_KEY_SPACE, "Space", 4.6), SYSTEM(KB_KEY_CURSOR, "→", 1.0),
	CHAR("?"), CHAR_SHIFT("'", "\""), SPACER(0.45),
};
static const struct key email_bottom[] = {
	MODE_KEY("&123", MODE_SYMBOLS, 1.35), CHAR("@"), CHAR("_"), CHAR("-"),
	SYSTEM(KB_KEY_SPACE, "Space", 2.15), SYSTEM(KB_KEY_CURSOR, "←", 1.0), SYSTEM(KB_KEY_CURSOR, "→", 1.0),
	CHAR_SHIFT(".", ">"), WEIGHTED_CHAR(".com", NULL, 2.0),
};
static const struct key url_bottom[] = {
	MODE_KEY("&123", MODE_SYMBOLS, 1.35), WEIGHTED_CHAR("://", NULL, 1.4), CHAR_SHIFT("/", "?"), CHAR_SHIFT(".", ">"),
	SYSTEM(KB_KEY_CURSOR, "←", 1.0), SYSTEM(KB_KEY_CURSOR, "→", 1.0),
	WEIGHTED_CHAR(".com", NULL, 2.0), WEIGHTED_CHAR("www.", NULL, 1.75),
};
static const struct key symbols_row_1[] = {
	CHAR("1"), CHAR("2"), CHAR("3"), CHAR("4"), CHAR("5"), CHAR("6"), CHAR("7"), CHAR("8"),
	CHAR("9"), CHAR("0"), SYSTEM(KB_KEY_BACKSPACE, "⌫", 1.5),
};
static const struct key symbols_row_2[] = {
	SPACER(0.45), CHAR("@"), CHAR("#"), CHAR("$"), CHAR("%"), CHAR("&"), CHAR("*"),
	CHAR("-"), CHAR("+"), CHAR("("), SYSTEM(KB_KEY_ENTER, "↵", 2.05),
};
static const struct key symbols_row_3[] = {
	SPACER(0.75), CHAR(")"), CHAR("["), CHAR("]"), CHAR("{"), CHAR("}"), CHAR("/"), CHAR("\\"),
	CHAR(":"), CHAR("!"), CHAR("?"), SPACER(0.75),
};
static const struct key symbols_bottom[] = {
	MODE_KEY("ABC", MODE_LETTERS, 1.35), MODE_KEY("☺", MODE_EMOJI, 1.1),
	SYSTEM(KB_KEY_CURSOR, "←", 1.0), SYSTEM(KB_KEY_SPACE, "Space", 4.6), SYSTEM(KB_KEY_CURSOR, "→", 1.0),
	CHAR("?"), CHAR("'"), SPACER(0.45),
};
static const struct key emoji_row_1[] = {
	SPACER(1.75), CHAR("☺"), CHAR("☹"), CHAR("♥"), CHAR("★"), CHAR("✓"), CHAR("✕"), CHAR("☑"), CHAR("⚑"), SPACER(1.75),
};
static const struct key emoji_row_2[] = {
	SPACER(1.75), CHAR("☀"), CHAR("☁"), CHAR("☔"), CHAR("❄"), CHAR("⚡"), CHAR("☂"), CHAR("♨"), CHAR("☕"), SPACER(1.75),
};
static const struct key emoji_row_3[] = {
	SPACER(1.75), CHAR("⌂"), CHAR("⚒"), CHAR("✿"), CHAR("♻"), CHAR("☎"), CHAR("✉"), CHAR("⌖"), CHAR("⌛"), SPACER(1.75),
};
static const struct key emoji_bottom[] = {
	MODE_KEY("ABC", MODE_LETTERS, 1.35), MODE_KEY("&123", MODE_SYMBOLS, 1.1),
	SYSTEM(KB_KEY_CURSOR, "←", 1.0), SYSTEM(KB_KEY_SPACE, "Space", 4.6), SYSTEM(KB_KEY_CURSOR, "→", 1.0),
	SYSTEM(KB_KEY_BACKSPACE, "⌫", 1.1), SYSTEM(KB_KEY_ENTER, "↵", 1.35),
};
static const struct key numeric_row_1[] = {CHAR("1"), CHAR("2"), CHAR("3")};
static const struct key numeric_row_2[] = {CHAR("4"), CHAR("5"), CHAR("6")};
static const struct key numeric_row_3[] = {CHAR("7"), CHAR("8"), CHAR("9")};
static const struct key numeric_row_4[] = {
	SYSTEM(KB_KEY_BACKSPACE, "⌫", 1.0), CHAR("0"), SYSTEM(KB_KEY_ENTER, "↵", 1.0),
};

static uint64_t
monotonic_milliseconds(void)
{
	struct timespec now;
	clock_gettime(CLOCK_MONOTONIC, &now);
	return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}

static uint64_t
monotonic_microseconds(void)
{
	struct timespec now;
	clock_gettime(CLOCK_MONOTONIC, &now);
	return (uint64_t)now.tv_sec * 1000000 + (uint64_t)now.tv_nsec / 1000;
}

static enum click_sound
click_sound_for_key(const struct key *key)
{
	switch (key->type) {
	case KB_KEY_CHARACTER:
	case KB_KEY_BACKSPACE:
	case KB_KEY_ENTER:
	case KB_KEY_CURSOR:
		return CLICK_SOUND_KEY;
	case KB_KEY_SHIFT:
	case KB_KEY_MODE:
		return CLICK_SOUND_MODIFIER;
	case KB_KEY_SPACE:
		return CLICK_SOUND_SPACE;
	case KB_KEY_SPACER:
		return CLICK_SOUND_NONE;
	}
	return CLICK_SOUND_NONE;
}

static void
generate_click_samples(struct click_audio *audio, enum click_sound sound,
	double center_frequency, double resonance, double gain)
{
	double omega = 2.0 * M_PI * center_frequency / CLICK_SAMPLE_RATE;
	double alpha = sin(omega) / (2.0 * resonance);
	double a0 = 1.0 + alpha;
	double b0 = alpha / a0;
	double b2 = -alpha / a0;
	double a1 = -2.0 * cos(omega) / a0;
	double a2 = (1.0 - alpha) / a0;
	double x1 = 0;
	double x2 = 0;
	double y1 = 0;
	double y2 = 0;
	uint32_t noise = 0x9e3779b9u ^ ((uint32_t)sound * 0x85ebca6bu);

	for (size_t index = 0; index < CLICK_SAMPLE_COUNT; index++) {
		noise ^= noise << 13;
		noise ^= noise >> 17;
		noise ^= noise << 5;
		double input = ((double)(noise & 0xffff) / 32767.5) - 1.0;
		double output = b0 * input + b2 * x2 - a1 * y1 - a2 * y2;
		x2 = x1;
		x1 = input;
		y2 = y1;
		y1 = output;
		double position = (double)index / CLICK_SAMPLE_COUNT;
		double decay = 1.0 - position;
		double envelope = decay * decay * decay * decay;
		double sample = output * envelope * gain * audio->volume;
		/* The synthesized transient is deliberately kept far below full scale;
		 * volume configuration can only attenuate this conservative ceiling. */
		if (sample > 0.12) {
			sample = 0.12;
		} else if (sample < -0.12) {
			sample = -0.12;
		}
		audio->samples[sound][index] = (int16_t)lround(sample * INT16_MAX);
	}
}

static bool
load_pulse_simple(struct click_audio *audio)
{
	audio->pulse_library = dlopen("libpulse-simple.so.0", RTLD_NOW | RTLD_LOCAL);
	if (!audio->pulse_library) {
		return false;
	}
	audio->simple_new = (pa_simple_new_fn)dlsym(audio->pulse_library, "pa_simple_new");
	audio->simple_write = (pa_simple_write_fn)dlsym(audio->pulse_library, "pa_simple_write");
	audio->simple_free = (pa_simple_free_fn)dlsym(audio->pulse_library, "pa_simple_free");
	if (!audio->simple_new || !audio->simple_write || !audio->simple_free) {
		dlclose(audio->pulse_library);
		audio->pulse_library = NULL;
		return false;
	}
	return true;
}

static void
drain_click_pipe(struct click_audio *audio)
{
	uint8_t discarded[32];
	while (read(audio->pipe_fds[0], discarded, sizeof(discarded)) > 0) {}
	atomic_store(&audio->pending, 0);
}

static void *
click_audio_thread(void *data)
{
	struct click_audio *audio = data;
	if (!load_pulse_simple(audio)) {
		fprintf(stderr, "strux-keyboard: key-click audio unavailable (libpulse-simple not installed)\n");
		atomic_store(&audio->running, false);
		return NULL;
	}

	const struct pa_sample_spec sample_spec = {
		.format = PA_SAMPLE_S16_NATIVE,
		.rate = CLICK_SAMPLE_RATE,
		.channels = 1,
	};
	const uint32_t click_bytes = CLICK_SAMPLE_COUNT * sizeof(int16_t);
	const struct pa_buffer_attr buffer_attr = {
		.maxlength = click_bytes * 4,
		.tlength = click_bytes * 2,
		.prebuf = 0,
		.minreq = click_bytes,
		.fragsize = UINT32_MAX,
	};
	while (atomic_load(&audio->running)) {
		if (!audio->stream) {
			drain_click_pipe(audio);
			int error = 0;
			audio->stream = audio->simple_new(NULL, "Strux Keyboard", PA_STREAM_PLAYBACK,
				NULL, "Key clicks", &sample_spec, NULL, &buffer_attr, &error);
			if (!audio->stream) {
				struct pollfd retry = {.fd = audio->pipe_fds[0], .events = POLLIN};
				poll(&retry, 1, CLICK_RECONNECT_MS);
				continue;
			}
			atomic_store(&audio->ready, true);
		}

		struct pollfd request = {.fd = audio->pipe_fds[0], .events = POLLIN};
		int result = poll(&request, 1, -1);
		if (result < 0) {
			if (errno == EINTR) {
				continue;
			}
			break;
		}
		uint8_t sound;
		if (read(audio->pipe_fds[0], &sound, sizeof(sound)) != sizeof(sound)) {
			continue;
		}
		if (!atomic_load(&audio->running)) {
			break;
		}
		if (sound <= CLICK_SOUND_NONE || sound >= CLICK_SOUND_COUNT) {
			continue;
		}
		atomic_fetch_sub(&audio->pending, 1);
		int error = 0;
		if (audio->simple_write(audio->stream, audio->samples[sound],
				sizeof(audio->samples[sound]), &error) < 0) {
			atomic_store(&audio->ready, false);
			audio->simple_free(audio->stream);
			audio->stream = NULL;
		}
	}

	atomic_store(&audio->ready, false);
	if (audio->stream) {
		audio->simple_free(audio->stream);
		audio->stream = NULL;
	}
	dlclose(audio->pulse_library);
	audio->pulse_library = NULL;
	return NULL;
}

static void
start_click_audio(struct click_audio *audio)
{
	const char *enabled = getenv("STRUX_KEYBOARD_SOUND_ENABLED");
	audio->enabled = !enabled || (strcmp(enabled, "0") != 0 && strcasecmp(enabled, "false") != 0 &&
		strcasecmp(enabled, "off") != 0 && strcasecmp(enabled, "no") != 0);
	if (!audio->enabled) {
		return;
	}
	audio->volume = 1.0;
	const char *volume = getenv("STRUX_KEYBOARD_SOUND_VOLUME");
	if (volume) {
		char *end = NULL;
		double parsed = strtod(volume, &end);
		if (end != volume && *end == '\0' && parsed >= 0 && parsed <= 1) {
			audio->volume = parsed;
		}
	}
	generate_click_samples(audio, CLICK_SOUND_KEY, 500, 0.6, 0.065);
	generate_click_samples(audio, CLICK_SOUND_MODIFIER, 400, 0.6, 0.045);
	generate_click_samples(audio, CLICK_SOUND_SPACE, 280, 0.4, 0.040);
	if (pipe2(audio->pipe_fds, O_NONBLOCK | O_CLOEXEC) < 0) {
		fprintf(stderr, "strux-keyboard: unable to create key-click audio queue: %s\n", strerror(errno));
		audio->enabled = false;
		return;
	}
	atomic_store(&audio->running, true);
	if (pthread_create(&audio->thread, NULL, click_audio_thread, audio) != 0) {
		close(audio->pipe_fds[0]);
		close(audio->pipe_fds[1]);
		audio->pipe_fds[0] = -1;
		audio->pipe_fds[1] = -1;
		audio->enabled = false;
		atomic_store(&audio->running, false);
		return;
	}
	audio->started = true;
}

static void
request_click_sound(struct click_audio *audio, enum click_sound sound)
{
	if (!audio->enabled || !atomic_load(&audio->ready) || sound <= CLICK_SOUND_NONE ||
	    sound >= CLICK_SOUND_COUNT) {
		return;
	}
	unsigned int pending = atomic_load(&audio->pending);
	while (pending < CLICK_MAX_PENDING) {
		if (atomic_compare_exchange_weak(&audio->pending, &pending, pending + 1)) {
			uint8_t request = (uint8_t)sound;
			if (write(audio->pipe_fds[1], &request, sizeof(request)) != sizeof(request)) {
				atomic_fetch_sub(&audio->pending, 1);
			}
			return;
		}
	}
}

static void
stop_click_audio(struct click_audio *audio)
{
	if (!audio->started) {
		return;
	}
	atomic_store(&audio->ready, false);
	atomic_store(&audio->running, false);
	uint8_t wake = 0;
	ssize_t ignored = write(audio->pipe_fds[1], &wake, sizeof(wake));
	(void)ignored;
	pthread_join(audio->thread, NULL);
	close(audio->pipe_fds[0]);
	close(audio->pipe_fds[1]);
	audio->pipe_fds[0] = -1;
	audio->pipe_fds[1] = -1;
	audio->started = false;
}

static double render_opacity = 1.0;

static uint32_t
color_with_opacity(uint32_t color, double opacity)
{
	uint32_t alpha = (color >> 24) & 0xff;
	uint32_t scaled_alpha = (uint32_t)lround(alpha * opacity);
	return (color & 0x00ffffff) | (scaled_alpha << 24);
}

static void
set_color(cairo_t *cr, uint32_t color)
{
	double alpha = ((color >> 24) & 0xff) / 255.0 * render_opacity;
	double red = ((color >> 16) & 0xff) / 255.0;
	double green = ((color >> 8) & 0xff) / 255.0;
	double blue = (color & 0xff) / 255.0;
	cairo_set_source_rgba(cr, red, green, blue, alpha);
}

static void
rounded_rectangle(cairo_t *cr, double x, double y, double width, double height, double radius)
{
	cairo_new_sub_path(cr);
	cairo_arc(cr, x + width - radius, y + radius, radius, -M_PI / 2, 0);
	cairo_arc(cr, x + width - radius, y + height - radius, radius, 0, M_PI / 2);
	cairo_arc(cr, x + radius, y + height - radius, radius, M_PI / 2, M_PI);
	cairo_arc(cr, x + radius, y + radius, radius, M_PI, 3 * M_PI / 2);
	cairo_close_path(cr);
}

static void
draw_centered_text(cairo_t *cr, const char *text, double x, double y, double width, double height,
		   double size, uint32_t color, cairo_font_weight_t weight)
{
	(void)weight;
	cairo_set_font_size(cr, size);
	cairo_text_extents_t extents;
	cairo_text_extents(cr, text, &extents);
	set_color(cr, color);
	cairo_move_to(cr, x + (width - extents.width) / 2 - extents.x_bearing,
		y + (height - extents.height) / 2 - extents.y_bearing);
	cairo_show_text(cr, text);
}

static const struct key_row *
active_rows(struct keyboard *keyboard, struct key_row rows[4])
{
	if (keyboard->layout == LAYOUT_NUMERIC) {
		rows[0] = (struct key_row){numeric_row_1, ARRAY_LENGTH(numeric_row_1)};
		rows[1] = (struct key_row){numeric_row_2, ARRAY_LENGTH(numeric_row_2)};
		rows[2] = (struct key_row){numeric_row_3, ARRAY_LENGTH(numeric_row_3)};
		rows[3] = (struct key_row){numeric_row_4, ARRAY_LENGTH(numeric_row_4)};
		return rows;
	}
	if (keyboard->mode == MODE_SYMBOLS) {
		rows[0] = (struct key_row){symbols_row_1, ARRAY_LENGTH(symbols_row_1)};
		rows[1] = (struct key_row){symbols_row_2, ARRAY_LENGTH(symbols_row_2)};
		rows[2] = (struct key_row){symbols_row_3, ARRAY_LENGTH(symbols_row_3)};
		rows[3] = (struct key_row){symbols_bottom, ARRAY_LENGTH(symbols_bottom)};
		return rows;
	}
	if (keyboard->mode == MODE_EMOJI) {
		rows[0] = (struct key_row){emoji_row_1, ARRAY_LENGTH(emoji_row_1)};
		rows[1] = (struct key_row){emoji_row_2, ARRAY_LENGTH(emoji_row_2)};
		rows[2] = (struct key_row){emoji_row_3, ARRAY_LENGTH(emoji_row_3)};
		rows[3] = (struct key_row){emoji_bottom, ARRAY_LENGTH(emoji_bottom)};
		return rows;
	}

	rows[0] = (struct key_row){letters_row_1, ARRAY_LENGTH(letters_row_1)};
	rows[1] = (struct key_row){letters_row_2, ARRAY_LENGTH(letters_row_2)};
	rows[2] = (struct key_row){letters_row_3, ARRAY_LENGTH(letters_row_3)};
	if (keyboard->layout == LAYOUT_EMAIL) {
		rows[3] = (struct key_row){email_bottom, ARRAY_LENGTH(email_bottom)};
	} else if (keyboard->layout == LAYOUT_URL) {
		rows[3] = (struct key_row){url_bottom, ARRAY_LENGTH(url_bottom)};
	} else {
		rows[3] = (struct key_row){default_bottom, ARRAY_LENGTH(default_bottom)};
	}
	return rows;
}

static bool
key_uses_shifted_label(struct keyboard *keyboard, const struct key *key)
{
	if (!key->shift_label) {
		return false;
	}
	bool is_letter = key->label[0] >= 'a' && key->label[0] <= 'z' && key->label[1] == '\0';
	return is_letter ? keyboard->caps_locked != keyboard->shifted : keyboard->shifted;
}

static void
destroy_keyboard_buffer(struct keyboard_buffer *buffer)
{
	struct keyboard_buffer **link = &buffer->keyboard->buffers;
	while (*link && *link != buffer) {
		link = &(*link)->next;
	}
	if (*link == buffer) {
		*link = buffer->next;
	}
	wl_buffer_destroy(buffer->buffer);
	cairo_surface_destroy(buffer->image);
	munmap(buffer->data, buffer->size);
	free(buffer);
}

static void
buffer_release(void *data, struct wl_buffer *wl_buffer)
{
	struct keyboard_buffer *buffer = data;
	buffer->busy = false;
	if (buffer->stale) {
		destroy_keyboard_buffer(buffer);
	}
}

static const struct wl_buffer_listener buffer_listener = {.release = buffer_release};

static int
create_shm_file(size_t size)
{
	char name[] = "/tmp/strux-keyboard-XXXXXX";
	int fd = mkstemp(name);
	if (fd < 0) {
		return -1;
	}
	unlink(name);
	if (ftruncate(fd, (off_t)size) < 0) {
		close(fd);
		return -1;
	}
	return fd;
}

static void draw_keyboard(struct keyboard *keyboard);

static struct keyboard_buffer *
create_keyboard_buffer(struct keyboard *keyboard, uint32_t pixel_width, uint32_t pixel_height)
{
	uint32_t stride = (uint32_t)cairo_format_stride_for_width(CAIRO_FORMAT_ARGB32, (int)pixel_width);
	size_t size = (size_t)stride * pixel_height;
	int fd = create_shm_file(size);
	if (fd < 0) {
		return NULL;
	}
	void *data = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (data == MAP_FAILED) {
		close(fd);
		return NULL;
	}
	struct wl_shm_pool *pool = wl_shm_create_pool(keyboard->shm, fd, (int32_t)size);
	struct wl_buffer *wl_buffer = wl_shm_pool_create_buffer(pool, 0, (int32_t)pixel_width,
		(int32_t)pixel_height, (int32_t)stride, WL_SHM_FORMAT_ARGB8888);
	wl_shm_pool_destroy(pool);
	close(fd);

	struct keyboard_buffer *buffer = calloc(1, sizeof(*buffer));
	if (!buffer) {
		wl_buffer_destroy(wl_buffer);
		munmap(data, size);
		return NULL;
	}
	buffer->keyboard = keyboard;
	buffer->buffer = wl_buffer;
	buffer->data = data;
	buffer->size = size;
	buffer->pixel_width = pixel_width;
	buffer->pixel_height = pixel_height;
	buffer->stride = stride;
	buffer->image = cairo_image_surface_create_for_data(data, CAIRO_FORMAT_ARGB32,
		(int)pixel_width, (int)pixel_height, (int)stride);
	if (cairo_surface_status(buffer->image) != CAIRO_STATUS_SUCCESS) {
		cairo_surface_destroy(buffer->image);
		wl_buffer_destroy(wl_buffer);
		munmap(data, size);
		free(buffer);
		return NULL;
	}
	buffer->next = keyboard->buffers;
	keyboard->buffers = buffer;
	keyboard->buffer_allocations++;
	wl_buffer_add_listener(wl_buffer, &buffer_listener, buffer);
	return buffer;
}

static void
update_animation_progress(struct keyboard *keyboard, uint64_t now_us)
{
	if (!keyboard->animation_running) {
		return;
	}
	double elapsed = (double)(now_us - keyboard->animation_started_us);
	double t = keyboard->animation_duration_us > 0 ? elapsed / keyboard->animation_duration_us : 1.0;
	if (t >= 1.0) {
		keyboard->animation_progress = keyboard->visible ? 1.0 : 0.0;
		keyboard->animation_running = false;
		return;
	}
	if (t < 0) {
		t = 0;
	}
	double eased;
	if (keyboard->visible) {
		double inverse = 1.0 - t;
		eased = 1.0 - inverse * inverse * inverse;
	} else {
		eased = t * t * t;
	}
	double target = keyboard->visible ? 1.0 : 0.0;
	keyboard->animation_progress = keyboard->animation_start_progress +
		(target - keyboard->animation_start_progress) * eased;
}

static void
start_visibility_animation(struct keyboard *keyboard, bool visible)
{
	uint64_t now_us = monotonic_microseconds();
	update_animation_progress(keyboard, now_us);
	if (visible) {
		keyboard->hide_completion_pending = false;
	} else {
		keyboard->hide_completion_pending = true;
	}
	if (keyboard->visible == visible &&
	    ((!visible && keyboard->animation_progress <= 0) ||
	     (visible && keyboard->animation_progress >= 1))) {
		if (!visible && keyboard->hide_completion_pending && keyboard->control_fd >= 0) {
			ssize_t ignored = send(keyboard->control_fd, "hidden\n", 7, MSG_NOSIGNAL);
			(void)ignored;
			keyboard->hide_completion_pending = false;
		}
		return;
	}
	keyboard->visible = visible;
	keyboard->animation_start_progress = keyboard->animation_progress;
	double distance = visible ? 1.0 - keyboard->animation_progress : keyboard->animation_progress;
	uint64_t base_duration_ms = visible ? SHOW_ANIMATION_MS : HIDE_ANIMATION_MS;
	keyboard->animation_duration_us = (uint64_t)(base_duration_ms * 1000 * distance);
	if (keyboard->animation_duration_us < 1000) {
		keyboard->animation_duration_us = 1000;
	}
	keyboard->animation_started_us = now_us;
	keyboard->animation_running = true;
	draw_keyboard(keyboard);
}

static void
frame_done(void *data, struct wl_callback *callback, uint32_t time)
{
	struct keyboard *keyboard = data;
	if (keyboard->frame_callback == callback) {
		keyboard->frame_callback = NULL;
	}
	wl_callback_destroy(callback);
	if (keyboard->animation_running) {
		draw_keyboard(keyboard);
	}
}

static const struct wl_callback_listener frame_listener = {.done = frame_done};

static void
draw_key(struct keyboard *keyboard, cairo_t *cr, const struct key *key, double x, double y, double width)
{
	if (key->type == KB_KEY_SPACER) {
		return;
	}
	if (keyboard->hitbox_count < ARRAY_LENGTH(keyboard->hitboxes)) {
		keyboard->hitboxes[keyboard->hitbox_count++] =
			(struct key_hitbox){key, x, y, width, KEY_HEIGHT};
	}

	bool active = keyboard->active_key == key;
	bool modifier_active = key->type == KB_KEY_SHIFT && (keyboard->shifted || keyboard->caps_locked);
	uint32_t background = 0xc7475569;
	if (key->type != KB_KEY_CHARACTER && key->type != KB_KEY_ENTER && key->type != KB_KEY_CURSOR) {
		background = 0xf51e293b;
	}
	if (key->type == KB_KEY_ENTER) {
		background = 0xff64748b;
	}
	if (modifier_active) {
		background = 0xff94a3b8;
	}
	if (active) {
		background = 0xff94a3b8;
	}
	rounded_rectangle(cr, x, y, width, KEY_HEIGHT, 4);
	set_color(cr, background);
	cairo_fill(cr);

	const char *label = key->label;
	if (key->type == KB_KEY_CHARACTER && key_uses_shifted_label(keyboard, key)) {
		label = key->shift_label;
	}
	uint32_t foreground = (active || modifier_active) ? 0xff020617 : 0xfff8fafc;
	enum keyboard_icon icon;
	bool has_icon = true;
	if (key->type == KB_KEY_SHIFT) {
		icon = KEYBOARD_ICON_SHIFT;
	} else if (key->type == KB_KEY_BACKSPACE) {
		icon = KEYBOARD_ICON_BACKSPACE;
	} else if (key->type == KB_KEY_ENTER) {
		icon = KEYBOARD_ICON_ENTER;
	} else if (key->type == KB_KEY_CURSOR) {
		icon = strcmp(key->label, "←") == 0 ? KEYBOARD_ICON_CURSOR_LEFT : KEYBOARD_ICON_CURSOR_RIGHT;
	} else if (key->type == KB_KEY_MODE && key->mode == MODE_EMOJI) {
		icon = KEYBOARD_ICON_EMOJI;
	} else {
		has_icon = false;
	}
	if (has_icon) {
		double icon_size = key->type == KB_KEY_BACKSPACE || key->type == KB_KEY_ENTER ? 21 : 19;
		keyboard_icon_draw(cr, icon, x + (width - icon_size) / 2,
			y + (KEY_HEIGHT - icon_size) / 2, icon_size, color_with_opacity(foreground, render_opacity));
		return;
	}
	double font_size = key->type == KB_KEY_CHARACTER ? 18 : 19;
	if (key->type == KB_KEY_MODE || key->type == KB_KEY_SPACE) {
		font_size = 13;
	}
	if (key->type == KB_KEY_SPACE) {
		double line_width = width > 160 ? 160 : width * 0.55;
		double line_x = x + (width - line_width) / 2;
		double line_y = y + KEY_HEIGHT / 2 - 4;
		set_color(cr, active ? 0xff020617 : 0xff94a3b8);
		cairo_set_line_width(cr, 1);
		cairo_move_to(cr, line_x, line_y);
		cairo_line_to(cr, line_x, line_y + 9);
		cairo_line_to(cr, line_x + line_width, line_y + 9);
		cairo_line_to(cr, line_x + line_width, line_y);
		cairo_stroke(cr);
		if (keyboard->space_dragging) {
			draw_centered_text(cr, "‹ ›", x, y, width, KEY_HEIGHT, 20, 0xff64748b, CAIRO_FONT_WEIGHT_NORMAL);
		}
		return;
	}
	draw_centered_text(cr, label, x, y, width, KEY_HEIGHT, font_size, foreground, CAIRO_FONT_WEIGHT_NORMAL);
}

static void
draw_keyboard(struct keyboard *keyboard)
{
	keyboard->redraw_requested = true;
}

static struct keyboard_buffer *
available_keyboard_buffer(struct keyboard *keyboard, uint32_t pixel_width, uint32_t pixel_height)
{
	struct keyboard_buffer *buffer;
	size_t matching_buffers = 0;
	for (buffer = keyboard->buffers; buffer; buffer = buffer->next) {
		if (!buffer->stale && buffer->pixel_width == pixel_width && buffer->pixel_height == pixel_height) {
			matching_buffers++;
			if (!buffer->busy) {
				return buffer;
			}
		}
	}
	if (matching_buffers < 2) {
		return create_keyboard_buffer(keyboard, pixel_width, pixel_height);
	}
	return NULL;
}

static void
render_keyboard(struct keyboard *keyboard)
{
	if (!keyboard->configured || keyboard->width == 0 || keyboard->height == 0) {
		return;
	}
	if (!keyboard->redraw_requested || keyboard->frame_callback) {
		return;
	}
	int scale = keyboard->target_output && keyboard->target_output->scale > 0 ? keyboard->target_output->scale : 1;
	uint32_t pixel_width = keyboard->width * (uint32_t)scale;
	uint32_t pixel_height = keyboard->height * (uint32_t)scale;
	struct keyboard_buffer *buffer = available_keyboard_buffer(keyboard, pixel_width, pixel_height);
	if (!buffer) {
		return;
	}
	uint64_t started_at = monotonic_microseconds();
	update_animation_progress(keyboard, started_at);
	if (keyboard->animation_progress < 0) {
		keyboard->animation_progress = 0;
	} else if (keyboard->animation_progress > 1) {
		keyboard->animation_progress = 1;
	}
	keyboard->visual_offset_y = (1.0 - keyboard->animation_progress) * ANIMATION_TRANSLATE_Y;
	cairo_t *cr = cairo_create(buffer->image);
	cairo_set_operator(cr, CAIRO_OPERATOR_SOURCE);
	cairo_set_source_rgba(cr, 0, 0, 0, 0);
	cairo_paint(cr);
	cairo_set_operator(cr, CAIRO_OPERATOR_OVER);
	cairo_scale(cr, scale, scale);
	cairo_translate(cr, 0, keyboard->visual_offset_y);
	render_opacity = keyboard->animation_progress;
	cairo_select_font_face(cr, "Noto Sans", CAIRO_FONT_SLANT_NORMAL, CAIRO_FONT_WEIGHT_NORMAL);
	set_color(cr, 0xff0f172a);
	cairo_paint(cr);

	set_color(cr, 0x29148fa3);
	cairo_rectangle(cr, 0, 0, keyboard->width, 1);
	cairo_fill(cr);
	set_color(cr, 0x1a94a3b8);
	cairo_rectangle(cr, 0, TOOLBAR_HEIGHT - 1, keyboard->width, 1);
	cairo_fill(cr);

	rounded_rectangle(cr, 16, 4, 46, 36, 2);
	set_color(cr, 0x33020617);
	cairo_fill(cr);
	keyboard_icon_draw(cr, KEYBOARD_ICON_DISMISS, 27, 10, 24,
		color_with_opacity(0xff94a3b8, render_opacity));

	keyboard->hitbox_count = 0;
	const char *mode_label = keyboard->mode == MODE_EMOJI ? "Emoji" :
		keyboard->mode == MODE_SYMBOLS ? "123 & symbols" : "ABC";
	double content_width = keyboard->layout == LAYOUT_NUMERIC ? NUMERIC_MAX_WIDTH : KEYBOARD_MAX_WIDTH;
	if (content_width > keyboard->width - 2 * KEYBOARD_EDGE_PADDING) {
		content_width = keyboard->width - 2 * KEYBOARD_EDGE_PADDING;
	}
	double content_x = (keyboard->width - content_width) / 2;
	if (keyboard->layout != LAYOUT_NUMERIC) {
		draw_centered_text(cr, mode_label, content_x + content_width - 96, TOOLBAR_HEIGHT, 96, STATUS_HEIGHT,
			10, 0xff94a3b8, CAIRO_FONT_WEIGHT_NORMAL);
		if (keyboard->caps_locked || keyboard->shifted) {
			draw_centered_text(cr, keyboard->caps_locked ? "Caps lock" : "Shift",
				content_x + content_width - 172, TOOLBAR_HEIGHT, 72, STATUS_HEIGHT,
				10, 0xfff1f5f9, CAIRO_FONT_WEIGHT_NORMAL);
		}
	}

	struct key_row rows[4];
	active_rows(keyboard, rows);
	double row_y = TOOLBAR_HEIGHT + (keyboard->layout == LAYOUT_NUMERIC ? 0 : STATUS_HEIGHT);
	for (size_t row_index = 0; row_index < ARRAY_LENGTH(rows); row_index++) {
		const struct key_row *row = &rows[row_index];
		double total_weight = 0;
		for (size_t index = 0; index < row->count; index++) {
			total_weight += row->keys[index].weight;
		}
		double available_width = content_width - KEY_GAP * (row->count - 1);
		double x = content_x;
		for (size_t index = 0; index < row->count; index++) {
			double key_width = available_width * row->keys[index].weight / total_weight;
			draw_key(keyboard, cr, &row->keys[index], x, row_y, key_width);
			x += key_width + KEY_GAP;
		}
		row_y += KEY_HEIGHT + KEY_GAP;
	}

	render_opacity = 1.0;
	cairo_destroy(cr);
	cairo_surface_flush(buffer->image);
	buffer->busy = true;
	keyboard->redraw_requested = false;
	wl_surface_set_buffer_scale(keyboard->surface, scale);
	wl_surface_attach(keyboard->surface, buffer->buffer, 0, 0);
	wl_surface_damage_buffer(keyboard->surface, 0, 0, INT32_MAX, INT32_MAX);
	if (keyboard->animation_running || keyboard->visible) {
		keyboard->frame_callback = wl_surface_frame(keyboard->surface);
		wl_callback_add_listener(keyboard->frame_callback, &frame_listener, keyboard);
	}
	wl_surface_commit(keyboard->surface);
	if (keyboard->hide_completion_pending && !keyboard->animation_running &&
	    keyboard->animation_progress <= 0 && keyboard->control_fd >= 0) {
		ssize_t ignored = send(keyboard->control_fd, "hidden\n", 7, MSG_NOSIGNAL);
		(void)ignored;
		keyboard->hide_completion_pending = false;
	}

	uint64_t elapsed_us = monotonic_microseconds() - started_at;
	keyboard->render_count++;
	keyboard->render_total_us += elapsed_us;
	if (elapsed_us > keyboard->render_max_us) {
		keyboard->render_max_us = elapsed_us;
	}
	if (keyboard->profile_rendering && keyboard->render_count % 30 == 0) {
		fprintf(stderr, "strux-keyboard: render avg=%" PRIu64 "us max=%" PRIu64
			"us frames=%" PRIu64 " buffers=%" PRIu64 "\n",
			keyboard->render_total_us / keyboard->render_count, keyboard->render_max_us,
			keyboard->render_count, keyboard->buffer_allocations);
	}
}

static bool
find_keysym(struct keyboard *keyboard, xkb_keysym_t keysym, xkb_keycode_t *keycode, bool *shift)
{
	xkb_keycode_t minimum = xkb_keymap_min_keycode(keyboard->xkb_keymap);
	xkb_keycode_t maximum = xkb_keymap_max_keycode(keyboard->xkb_keymap);
	for (xkb_keycode_t code = minimum; code <= maximum; code++) {
		xkb_level_index_t levels = xkb_keymap_num_levels_for_key(keyboard->xkb_keymap, code, 0);
		for (xkb_level_index_t level = 0; level < levels; level++) {
			const xkb_keysym_t *symbols;
			int count = xkb_keymap_key_get_syms_by_level(keyboard->xkb_keymap, code, 0, level, &symbols);
			for (int index = 0; index < count; index++) {
				if (symbols[index] == keysym) {
					*keycode = code;
					*shift = level > 0;
					return true;
				}
			}
		}
	}
	return false;
}

static void
emit_keycode(struct keyboard *keyboard, xkb_keycode_t keycode, uint32_t state)
{
	zwp_virtual_keyboard_v1_key(keyboard->virtual_keyboard, (uint32_t)monotonic_milliseconds(),
		keycode - 8, state);
}

static void
emit_keysym(struct keyboard *keyboard, xkb_keysym_t keysym)
{
	xkb_keycode_t keycode;
	bool shift;
	if (!find_keysym(keyboard, keysym, &keycode, &shift)) {
		return;
	}
	if (shift) {
		zwp_virtual_keyboard_v1_modifiers(keyboard->virtual_keyboard,
			keyboard->shift_modifier_mask, 0, 0, 0);
	}
	emit_keycode(keyboard, keycode, WL_KEYBOARD_KEY_STATE_PRESSED);
	emit_keycode(keyboard, keycode, WL_KEYBOARD_KEY_STATE_RELEASED);
	if (shift) {
		zwp_virtual_keyboard_v1_modifiers(keyboard->virtual_keyboard, 0, 0, 0, 0);
	}
}

static void
emit_text(struct keyboard *keyboard, const char *text)
{
	const unsigned char *cursor = (const unsigned char *)text;
	while (*cursor) {
		uint32_t codepoint;
		size_t length;
		if ((*cursor & 0x80) == 0) {
			codepoint = *cursor;
			length = 1;
		} else if ((*cursor & 0xe0) == 0xc0) {
			codepoint = ((*cursor & 0x1f) << 6) | (cursor[1] & 0x3f);
			length = 2;
		} else if ((*cursor & 0xf0) == 0xe0) {
			codepoint = ((*cursor & 0x0f) << 12) | ((cursor[1] & 0x3f) << 6) | (cursor[2] & 0x3f);
			length = 3;
		} else {
			codepoint = ((*cursor & 0x07) << 18) | ((cursor[1] & 0x3f) << 12) |
				((cursor[2] & 0x3f) << 6) | (cursor[3] & 0x3f);
			length = 4;
		}
		emit_keysym(keyboard, xkb_utf32_to_keysym(codepoint));
		cursor += length;
	}
}

static void
consume_one_shot_shift(struct keyboard *keyboard)
{
	keyboard->shifted = false;
	keyboard->last_shift_press_ms = 0;
}

static void
handle_shift_press(struct keyboard *keyboard, uint64_t now_ms)
{
	/* Caps Lock has an explicit exit: the next Shift press always turns it
	 * off instead of temporarily inverting the next character. */
	if (keyboard->caps_locked) {
		keyboard->caps_locked = false;
		keyboard->shifted = false;
		keyboard->last_shift_press_ms = 0;
		return;
	}
	if (keyboard->last_shift_press_ms != 0 &&
	    now_ms - keyboard->last_shift_press_ms <= 360) {
		keyboard->caps_locked = true;
		keyboard->shifted = false;
		keyboard->last_shift_press_ms = 0;
		return;
	}
	keyboard->shifted = !keyboard->shifted;
	keyboard->last_shift_press_ms = keyboard->shifted ? now_ms : 0;
}

static void
press_key(struct keyboard *keyboard, const struct key *key)
{
	enum click_sound sound = click_sound_for_key(key);
	if (key->type == KB_KEY_CHARACTER) {
		const char *text = key->label;
		if (key_uses_shifted_label(keyboard, key)) {
			text = key->shift_label;
		}
		emit_text(keyboard, text);
		consume_one_shot_shift(keyboard);
	} else if (key->type == KB_KEY_BACKSPACE) {
		emit_keysym(keyboard, XKB_KEY_BackSpace);
		keyboard->backspace_repeat_at_ms = monotonic_milliseconds() + BACKSPACE_REPEAT_DELAY_MS;
	} else if (key->type == KB_KEY_ENTER) {
		emit_keysym(keyboard, XKB_KEY_Return);
		consume_one_shot_shift(keyboard);
	} else if (key->type == KB_KEY_CURSOR) {
		emit_keysym(keyboard, strcmp(key->label, "←") == 0 ? XKB_KEY_Left : XKB_KEY_Right);
	} else if (key->type == KB_KEY_MODE) {
		keyboard->mode = key->mode;
		consume_one_shot_shift(keyboard);
	} else if (key->type == KB_KEY_SHIFT) {
		handle_shift_press(keyboard, monotonic_milliseconds());
	}
	request_click_sound(&keyboard->click_audio, sound);
	draw_keyboard(keyboard);
}

static const struct key *
key_at(struct keyboard *keyboard, double x, double y)
{
	for (size_t index = 0; index < keyboard->hitbox_count; index++) {
		struct key_hitbox *hitbox = &keyboard->hitboxes[index];
		if (x >= hitbox->x && x < hitbox->x + hitbox->width &&
		    y >= hitbox->y && y < hitbox->y + hitbox->height) {
			return hitbox->key;
		}
	}
	return NULL;
}

static void
touch_down(void *data, struct wl_touch *touch, uint32_t serial, uint32_t time, struct wl_surface *surface,
		   int32_t id, wl_fixed_t x, wl_fixed_t y)
{
	struct keyboard *keyboard = data;
	if (!keyboard->visible || keyboard->animation_progress < ANIMATION_INPUT_THRESHOLD) {
		return;
	}
	double logical_x = wl_fixed_to_double(x);
	double logical_y = wl_fixed_to_double(y) - keyboard->visual_offset_y;
	if (logical_y < TOOLBAR_HEIGHT && logical_x >= 8 && logical_x <= 70) {
		if (keyboard->control_fd >= 0) {
			ssize_t ignored = send(keyboard->control_fd, "dismiss\n", 8, MSG_NOSIGNAL);
			(void)ignored;
		}
		return;
	}

	const struct key *key = key_at(keyboard, logical_x, logical_y);
	if (!key) {
		return;
	}
	keyboard->active_key = key;
	keyboard->active_touch_id = id;
	keyboard->touch_start_x = logical_x;
	keyboard->touch_last_x = logical_x;
	keyboard->space_dragging = false;
	if (key->type != KB_KEY_SPACE) {
		press_key(keyboard, key);
	} else {
		draw_keyboard(keyboard);
	}
}

static void
touch_up(void *data, struct wl_touch *touch, uint32_t serial, uint32_t time, int32_t id)
{
	struct keyboard *keyboard = data;
	if (keyboard->active_touch_id != id || !keyboard->active_key) {
		return;
	}
	if (keyboard->active_key->type == KB_KEY_SPACE && !keyboard->space_dragging) {
		emit_keysym(keyboard, XKB_KEY_space);
		consume_one_shot_shift(keyboard);
		request_click_sound(&keyboard->click_audio, CLICK_SOUND_SPACE);
	}
	keyboard->active_key = NULL;
	keyboard->active_touch_id = -1;
	keyboard->space_dragging = false;
	keyboard->backspace_repeat_at_ms = 0;
	draw_keyboard(keyboard);
}

static void
touch_motion(void *data, struct wl_touch *touch, uint32_t time, int32_t id, wl_fixed_t x, wl_fixed_t y)
{
	struct keyboard *keyboard = data;
	if (keyboard->active_touch_id != id || !keyboard->active_key || keyboard->active_key->type != KB_KEY_SPACE) {
		return;
	}
	double logical_x = wl_fixed_to_double(x);
	double distance = logical_x - keyboard->touch_start_x;
	if (!keyboard->space_dragging && fabs(distance) > SPACE_DRAG_DEAD_ZONE) {
		keyboard->space_dragging = true;
	}
	if (keyboard->space_dragging) {
		int previous_steps = (int)((keyboard->touch_last_x - keyboard->touch_start_x) / SPACE_DRAG_STEP);
		int current_steps = (int)(distance / SPACE_DRAG_STEP);
		int delta = current_steps - previous_steps;
		while (delta > 0) {
			emit_keysym(keyboard, XKB_KEY_Right);
			delta--;
		}
		while (delta < 0) {
			emit_keysym(keyboard, XKB_KEY_Left);
			delta++;
		}
		keyboard->touch_last_x = logical_x;
		draw_keyboard(keyboard);
	}
}

static void touch_frame(void *data, struct wl_touch *touch) {}
static void
touch_cancel(void *data, struct wl_touch *touch)
{
	struct keyboard *keyboard = data;
	keyboard->active_key = NULL;
	keyboard->active_touch_id = -1;
	keyboard->backspace_repeat_at_ms = 0;
	draw_keyboard(keyboard);
}
static void touch_shape(void *data, struct wl_touch *touch, int32_t id, wl_fixed_t major, wl_fixed_t minor) {}
static void touch_orientation(void *data, struct wl_touch *touch, int32_t id, wl_fixed_t orientation) {}

static const struct wl_touch_listener touch_listener = {
	.down = touch_down,
	.up = touch_up,
	.motion = touch_motion,
	.frame = touch_frame,
	.cancel = touch_cancel,
	.shape = touch_shape,
	.orientation = touch_orientation,
};

static void
seat_capabilities(void *data, struct wl_seat *seat, uint32_t capabilities)
{
	struct keyboard *keyboard = data;
	if ((capabilities & WL_SEAT_CAPABILITY_TOUCH) && !keyboard->touch) {
		keyboard->touch = wl_seat_get_touch(seat);
		wl_touch_add_listener(keyboard->touch, &touch_listener, keyboard);
	} else if (!(capabilities & WL_SEAT_CAPABILITY_TOUCH) && keyboard->touch) {
		wl_touch_destroy(keyboard->touch);
		keyboard->touch = NULL;
	}
}

static void seat_name(void *data, struct wl_seat *seat, const char *name) {}
static const struct wl_seat_listener seat_listener = {.capabilities = seat_capabilities, .name = seat_name};

static void
output_geometry(void *data, struct wl_output *output, int32_t x, int32_t y, int32_t physical_width,
		int32_t physical_height, int32_t subpixel, const char *make, const char *model, int32_t transform)
{
}
static void output_mode(void *data, struct wl_output *output, uint32_t flags, int32_t width, int32_t height, int32_t refresh) {}
static void output_done(void *data, struct wl_output *output) {}
static void
output_scale(void *data, struct wl_output *output, int32_t factor)
{
	struct output_info *info = data;
	info->scale = factor;
}
static void
output_name(void *data, struct wl_output *output, const char *name)
{
	struct output_info *info = data;
	free(info->name);
	info->name = strdup(name);
}
static void output_description(void *data, struct wl_output *output, const char *description) {}

static const struct wl_output_listener output_listener = {
	.geometry = output_geometry,
	.mode = output_mode,
	.done = output_done,
	.scale = output_scale,
	.name = output_name,
	.description = output_description,
};

static void
layer_surface_configure(void *data, struct zwlr_layer_surface_v1 *surface, uint32_t serial,
		uint32_t width, uint32_t height)
{
	struct keyboard *keyboard = data;
	zwlr_layer_surface_v1_ack_configure(surface, serial);
	bool size_changed = keyboard->width != width || keyboard->height != height;
	keyboard->width = width;
	keyboard->height = height;
	keyboard->configured = true;
	if (size_changed) {
		int scale = keyboard->target_output && keyboard->target_output->scale > 0 ?
			keyboard->target_output->scale : 1;
		uint32_t pixel_width = width * (uint32_t)scale;
		uint32_t pixel_height = height * (uint32_t)scale;
		struct keyboard_buffer *buffer = keyboard->buffers;
		while (buffer) {
			struct keyboard_buffer *next = buffer->next;
			if (buffer->pixel_width != pixel_width || buffer->pixel_height != pixel_height) {
				buffer->stale = true;
				if (!buffer->busy) {
					destroy_keyboard_buffer(buffer);
				}
			}
			buffer = next;
		}
	}
	draw_keyboard(keyboard);
}

static void
layer_surface_closed(void *data, struct zwlr_layer_surface_v1 *surface)
{
	struct keyboard *keyboard = data;
	keyboard->running = false;
}

static const struct zwlr_layer_surface_v1_listener layer_surface_listener = {
	.configure = layer_surface_configure,
	.closed = layer_surface_closed,
};

static void
create_layer_surface(struct keyboard *keyboard)
{
	if (keyboard->surface || !keyboard->compositor || !keyboard->layer_shell || !keyboard->target_output) {
		return;
	}
	keyboard->surface = wl_compositor_create_surface(keyboard->compositor);
	keyboard->layer_surface = zwlr_layer_shell_v1_get_layer_surface(keyboard->layer_shell, keyboard->surface,
		keyboard->target_output->output, ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY, "strux-keyboard");
	zwlr_layer_surface_v1_add_listener(keyboard->layer_surface, &layer_surface_listener, keyboard);
	zwlr_layer_surface_v1_set_anchor(keyboard->layer_surface, ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM |
		ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT | ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT);
	zwlr_layer_surface_v1_set_size(keyboard->layer_surface, 0, KEYBOARD_HEIGHT);
	zwlr_layer_surface_v1_set_exclusive_zone(keyboard->layer_surface, KEYBOARD_HEIGHT);
	zwlr_layer_surface_v1_set_keyboard_interactivity(keyboard->layer_surface,
		ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE);
	wl_surface_commit(keyboard->surface);
}

static void
update_layer_size(struct keyboard *keyboard)
{
	if (!keyboard->layer_surface || !keyboard->surface) {
		return;
	}
	int32_t height = keyboard->layout == LAYOUT_NUMERIC ? NUMERIC_KEYBOARD_HEIGHT : KEYBOARD_HEIGHT;
	zwlr_layer_surface_v1_set_size(keyboard->layer_surface, 0, (uint32_t)height);
	zwlr_layer_surface_v1_set_exclusive_zone(keyboard->layer_surface, height);
	wl_surface_commit(keyboard->surface);
}

static void
create_virtual_keyboard(struct keyboard *keyboard)
{
	if (keyboard->virtual_keyboard || !keyboard->virtual_keyboard_manager || !keyboard->seat) {
		return;
	}
	keyboard->xkb_context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
	keyboard->xkb_keymap = xkb_keymap_new_from_names(keyboard->xkb_context, NULL, XKB_KEYMAP_COMPILE_NO_FLAGS);
	if (!keyboard->xkb_keymap) {
		return;
	}
	xkb_mod_index_t shift_index = xkb_keymap_mod_get_index(keyboard->xkb_keymap, XKB_MOD_NAME_SHIFT);
	if (shift_index != XKB_MOD_INVALID && shift_index < 32) {
		keyboard->shift_modifier_mask = (uint32_t)1 << shift_index;
	} else {
		fprintf(stderr, "strux-keyboard: keymap has no usable Shift modifier\n");
	}
	char *keymap = xkb_keymap_get_as_string(keyboard->xkb_keymap, XKB_KEYMAP_FORMAT_TEXT_V1);
	size_t size = strlen(keymap) + 1;
	int fd = create_shm_file(size);
	if (fd < 0) {
		free(keymap);
		return;
	}
	if (write(fd, keymap, size) != (ssize_t)size) {
		close(fd);
		free(keymap);
		return;
	}
	free(keymap);
	keyboard->virtual_keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(
		keyboard->virtual_keyboard_manager, keyboard->seat);
	zwp_virtual_keyboard_v1_keymap(keyboard->virtual_keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd, (uint32_t)size);
	close(fd);
}

static void
registry_global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version)
{
	struct keyboard *keyboard = data;
	if (strcmp(interface, wl_compositor_interface.name) == 0) {
		keyboard->compositor = wl_registry_bind(registry, name, &wl_compositor_interface, version < 4 ? version : 4);
	} else if (strcmp(interface, wl_shm_interface.name) == 0) {
		keyboard->shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
	} else if (strcmp(interface, wl_seat_interface.name) == 0) {
		keyboard->seat = wl_registry_bind(registry, name, &wl_seat_interface, version < 7 ? version : 7);
		wl_seat_add_listener(keyboard->seat, &seat_listener, keyboard);
	} else if (strcmp(interface, zwlr_layer_shell_v1_interface.name) == 0) {
		keyboard->layer_shell = wl_registry_bind(registry, name, &zwlr_layer_shell_v1_interface, 4);
	} else if (strcmp(interface, zwp_virtual_keyboard_manager_v1_interface.name) == 0) {
		keyboard->virtual_keyboard_manager = wl_registry_bind(registry, name,
			&zwp_virtual_keyboard_manager_v1_interface, 1);
	} else if (strcmp(interface, wl_output_interface.name) == 0) {
		struct output_info *output = calloc(1, sizeof(*output));
		output->scale = 1;
		output->output = wl_registry_bind(registry, name, &wl_output_interface, version < 4 ? version : 4);
		wl_output_add_listener(output->output, &output_listener, output);
		output->next = keyboard->outputs;
		keyboard->outputs = output;
	}
}

static void registry_global_remove(void *data, struct wl_registry *registry, uint32_t name) {}
static const struct wl_registry_listener registry_listener = {
	.global = registry_global,
	.global_remove = registry_global_remove,
};

static void
select_target_output(struct keyboard *keyboard)
{
	struct output_info *output = keyboard->outputs;
	while (output) {
		if (output->name && strcmp(output->name, keyboard->target_output_name) == 0) {
			keyboard->target_output = output;
			return;
		}
		output = output->next;
	}
}

static void
handle_control_message(struct keyboard *keyboard)
{
	char buffer[128];
	ssize_t length = read(keyboard->control_fd, buffer, sizeof(buffer) - 1);
	if (length <= 0) {
		return;
	}
	buffer[length] = '\0';
	if (strncmp(buffer, "show ", 5) == 0) {
		bool was_visible = keyboard->visible;
		enum keyboard_layout previous_layout = keyboard->layout;
		unsigned long purpose = strtoul(buffer + 5, NULL, 10);
		/* text-input-v3 purposes: digits=2, number=3, phone=4, url=5,
		 * email=6, pin=9. */
		if (purpose == 2 || purpose == 3 || purpose == 4 || purpose == 9) {
			keyboard->layout = LAYOUT_NUMERIC;
		} else if (purpose == 5) {
			keyboard->layout = LAYOUT_URL;
		} else if (purpose == 6) {
			keyboard->layout = LAYOUT_EMAIL;
		} else {
			keyboard->layout = LAYOUT_DEFAULT;
		}
		keyboard->mode = MODE_LETTERS;
		if (!was_visible || previous_layout != keyboard->layout) {
			update_layer_size(keyboard);
		}
		if (!was_visible) {
			start_visibility_animation(keyboard, true);
		} else {
			draw_keyboard(keyboard);
		}
	} else if (strncmp(buffer, "hide", 4) == 0) {
		keyboard->active_key = NULL;
		consume_one_shot_shift(keyboard);
		keyboard->caps_locked = false;
		keyboard->mode = MODE_LETTERS;
		keyboard->backspace_repeat_at_ms = 0;
		start_visibility_animation(keyboard, false);
	}
}

static int
run_keyboard(struct keyboard *keyboard)
{
	keyboard->running = true;
	keyboard->active_touch_id = -1;
	keyboard->display = wl_display_connect(NULL);
	if (!keyboard->display) {
		return 1;
	}
	keyboard->registry = wl_display_get_registry(keyboard->display);
	wl_registry_add_listener(keyboard->registry, &registry_listener, keyboard);
	wl_display_roundtrip(keyboard->display);
	wl_display_roundtrip(keyboard->display);
	select_target_output(keyboard);
	if (!keyboard->target_output || !keyboard->compositor || !keyboard->shm || !keyboard->layer_shell ||
	    !keyboard->seat || !keyboard->virtual_keyboard_manager) {
		fprintf(stderr, "strux-keyboard: required Wayland globals or output '%s' unavailable\n",
			keyboard->target_output_name);
		return 1;
	}
	create_virtual_keyboard(keyboard);
	create_layer_surface(keyboard);
	start_click_audio(&keyboard->click_audio);
	wl_display_flush(keyboard->display);

	int display_fd = wl_display_get_fd(keyboard->display);
	while (keyboard->running) {
		wl_display_dispatch_pending(keyboard->display);
		/* Send key/modifier requests before doing any Cairo work. This keeps
		 * input delivery independent of the cost of painting key feedback. */
		wl_display_flush(keyboard->display);
		render_keyboard(keyboard);
		wl_display_flush(keyboard->display);
		struct pollfd poll_fds[2] = {
			{.fd = display_fd, .events = POLLIN},
			{.fd = keyboard->control_fd, .events = POLLIN},
		};
		int timeout = keyboard->backspace_repeat_at_ms ? 20 : -1;
		int result = poll(poll_fds, keyboard->control_fd >= 0 ? 2 : 1, timeout);
		if (result < 0 && errno != EINTR) {
			break;
		}
		if (poll_fds[0].revents & POLLIN) {
			if (wl_display_dispatch(keyboard->display) < 0) {
				break;
			}
		}
		if (keyboard->control_fd >= 0 && poll_fds[1].revents & POLLIN) {
			handle_control_message(keyboard);
		}
		uint64_t now = monotonic_milliseconds();
		if (keyboard->backspace_repeat_at_ms && now >= keyboard->backspace_repeat_at_ms &&
		    keyboard->active_key && keyboard->active_key->type == KB_KEY_BACKSPACE) {
			emit_keysym(keyboard, XKB_KEY_BackSpace);
			keyboard->backspace_repeat_at_ms = now + BACKSPACE_REPEAT_INTERVAL_MS;
		}
		/* Flush the just-enqueued key before rendering the pressed/released
		 * state. Commit at most once per compositor frame. */
		wl_display_flush(keyboard->display);
		render_keyboard(keyboard);
		wl_display_flush(keyboard->display);
	}
	stop_click_audio(&keyboard->click_audio);
	return 0;
}

static int
run_self_test(void)
{
	struct keyboard keyboard = {.layout = LAYOUT_URL, .mode = MODE_LETTERS};
	keyboard.xkb_context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
	keyboard.xkb_keymap = xkb_keymap_new_from_names(
		keyboard.xkb_context, NULL, XKB_KEYMAP_COMPILE_NO_FLAGS);
	if (!keyboard.xkb_keymap) {
		fprintf(stderr, "strux-keyboard self-test: unable to compile keymap\n");
		return 1;
	}
	xkb_mod_index_t shift_index = xkb_keymap_mod_get_index(keyboard.xkb_keymap, XKB_MOD_NAME_SHIFT);
	xkb_keycode_t question_keycode;
	bool question_needs_shift = false;
	bool valid = shift_index != XKB_MOD_INVALID && shift_index < 32 &&
		find_keysym(&keyboard, XKB_KEY_question, &question_keycode, &question_needs_shift) &&
		question_needs_shift && strcmp(url_bottom[2].shift_label, "?") == 0;

	/* Shift state transitions: one press is one-shot, a second prompt press
	 * locks caps, and one press while locked turns caps off immediately. */
	handle_shift_press(&keyboard, 1000);
	valid = valid && keyboard.shifted && !keyboard.caps_locked;
	consume_one_shot_shift(&keyboard);
	valid = valid && !keyboard.shifted && !keyboard.caps_locked &&
		keyboard.last_shift_press_ms == 0;
	handle_shift_press(&keyboard, 2000);
	handle_shift_press(&keyboard, 2200);
	valid = valid && !keyboard.shifted && keyboard.caps_locked &&
		keyboard.last_shift_press_ms == 0;
	handle_shift_press(&keyboard, 3000);
	valid = valid && !keyboard.shifted && !keyboard.caps_locked &&
		keyboard.last_shift_press_ms == 0;

	keyboard.shifted = true;
	valid = valid && key_uses_shifted_label(&keyboard, &url_bottom[2]);
	consume_one_shot_shift(&keyboard);
	keyboard.caps_locked = true;
	valid = valid && !key_uses_shifted_label(&keyboard, &url_bottom[2]) &&
		key_uses_shifted_label(&keyboard, &letters_row_1[0]);
	valid = valid && click_sound_for_key(&letters_row_1[0]) == CLICK_SOUND_KEY &&
		click_sound_for_key(&letters_row_1[10]) == CLICK_SOUND_KEY &&
		click_sound_for_key(&letters_row_3[0]) == CLICK_SOUND_MODIFIER &&
		click_sound_for_key(&default_bottom[0]) == CLICK_SOUND_MODIFIER &&
		click_sound_for_key(&default_bottom[3]) == CLICK_SOUND_SPACE &&
		click_sound_for_key(&default_bottom[7]) == CLICK_SOUND_NONE;
	struct click_audio click_test = {.volume = 1.0};
	generate_click_samples(&click_test, CLICK_SOUND_KEY, 500, 0.6, 0.065);
	int16_t click_peak = 0;
	for (size_t index = 0; index < CLICK_SAMPLE_COUNT; index++) {
		int16_t magnitude = click_test.samples[CLICK_SOUND_KEY][index] < 0 ?
			-click_test.samples[CLICK_SOUND_KEY][index] : click_test.samples[CLICK_SOUND_KEY][index];
		if (magnitude > click_peak) {
			click_peak = magnitude;
		}
	}
	valid = valid && click_peak > 0 && click_peak <= (int16_t)lround(INT16_MAX * 0.12) &&
		CLICK_DURATION_MS <= 24 && CLICK_MAX_PENDING == 2;
	click_test.enabled = true;
	if (pipe2(click_test.pipe_fds, O_NONBLOCK | O_CLOEXEC) == 0) {
		atomic_store(&click_test.ready, true);
		request_click_sound(&click_test, CLICK_SOUND_KEY);
		request_click_sound(&click_test, CLICK_SOUND_MODIFIER);
		request_click_sound(&click_test, CLICK_SOUND_SPACE);
		uint8_t queued[3] = {0};
		ssize_t queued_count = read(click_test.pipe_fds[0], queued, sizeof(queued));
		valid = valid && atomic_load(&click_test.pending) == CLICK_MAX_PENDING &&
			queued_count == CLICK_MAX_PENDING && queued[0] == CLICK_SOUND_KEY &&
			queued[1] == CLICK_SOUND_MODIFIER;
		close(click_test.pipe_fds[0]);
		close(click_test.pipe_fds[1]);
	} else {
		valid = false;
	}
	keyboard.animation_progress = 0;
	keyboard.visible = false;
	start_visibility_animation(&keyboard, true);
	update_animation_progress(&keyboard,
		keyboard.animation_started_us + keyboard.animation_duration_us / 2);
	valid = valid && keyboard.animation_progress > 0.8 && keyboard.animation_progress < 1.0;
	update_animation_progress(&keyboard,
		keyboard.animation_started_us + keyboard.animation_duration_us);
	valid = valid && !keyboard.animation_running && keyboard.animation_progress == 1.0;
	start_visibility_animation(&keyboard, false);
	update_animation_progress(&keyboard,
		keyboard.animation_started_us + keyboard.animation_duration_us);
	valid = valid && !keyboard.animation_running && keyboard.animation_progress == 0.0 &&
		KEYBOARD_HEIGHT == 353 && NUMERIC_KEYBOARD_HEIGHT == 324;
	fprintf(stderr, "strux-keyboard self-test: %s\n", valid ? "passed" : "failed");
	xkb_keymap_unref(keyboard.xkb_keymap);
	xkb_context_unref(keyboard.xkb_context);
	return valid ? 0 : 1;
}

int
main(int argc, char **argv)
{
	struct keyboard keyboard = {.control_fd = -1, .layout = LAYOUT_DEFAULT, .mode = MODE_LETTERS};
	bool self_test = false;
	for (int index = 1; index < argc; index++) {
		if (strcmp(argv[index], "--output") == 0 && index + 1 < argc) {
			keyboard.target_output_name = strdup(argv[++index]);
		} else if (strcmp(argv[index], "--self-test") == 0) {
			self_test = true;
		}
	}
	if (self_test) {
		return run_self_test();
	}
	const char *control_fd = getenv("STRUX_KEYBOARD_CONTROL_FD");
	if (control_fd) {
		keyboard.control_fd = atoi(control_fd);
	}
	const char *profile_rendering = getenv("STRUX_KEYBOARD_PROFILE");
	keyboard.profile_rendering = profile_rendering && strcmp(profile_rendering, "0") != 0;
	if (!keyboard.target_output_name) {
		fprintf(stderr, "usage: strux-keyboard --output NAME\n");
		return 2;
	}
	return run_keyboard(&keyboard);
}
