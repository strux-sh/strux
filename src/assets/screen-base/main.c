/*
 * strux-screen: Remote screen capture daemon for Strux OS
 *
 * Captures frames from a Cage Wayland compositor output using wlr-screencopy,
 * encodes to H.264 via GStreamer, and outputs encoded frames over a Unix socket.
 *
 * Usage: strux-screen --output HDMI-A-1 [--fps 30]
 *                     [--socket /tmp/strux-screen-HDMI-A-1.sock]
 */

#include <errno.h>
#include <getopt.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

#include <gst/gst.h>

#include "capture.h"
#include "input.h"
#include "pipeline.h"

/* --- Configuration --- */

static struct {
    const char *output_name;
    const char *socket_path;
    int fps;
    bool running;
} config = {
    .output_name = NULL,
    .socket_path = NULL,
    .fps = 30,
    .running = true,
};

/* --- Unix socket server --- */

/* Message header for binary frame messages on the Unix socket.
 * Control messages use newline-delimited JSON. */

#define MSG_TYPE_CONTROL 0
#define MSG_TYPE_FRAME   1

struct frame_header {
    uint32_t length;      /* Total payload length (after this header) */
    uint8_t  msg_type;    /* MSG_TYPE_CONTROL or MSG_TYPE_FRAME */
    uint64_t timestamp_ns;
    uint8_t  is_keyframe;
} __attribute__((packed));

static int server_fd = -1;
static int client_fd = -1;

static int socket_server_init(const char *path)
{
    /* Remove existing socket */
    unlink(path);

    server_fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (server_fd < 0) {
        perror("[strux-screen] socket");
        return -1;
    }

    struct sockaddr_un addr = {0};
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);

    if (bind(server_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("[strux-screen] bind");
        close(server_fd);
        return -1;
    }

    if (listen(server_fd, 1) < 0) {
        perror("[strux-screen] listen");
        close(server_fd);
        return -1;
    }

    fprintf(stderr, "[strux-screen] Listening on %s\n", path);
    return 0;
}

/* Send a binary frame message to the connected client */
static int socket_send_frame(const uint8_t *data, size_t size,
                             uint64_t timestamp_ns, bool is_keyframe)
{
    if (client_fd < 0)
        return -1;

    struct frame_header hdr = {
        .length = (uint32_t)size,
        .msg_type = MSG_TYPE_FRAME,
        .timestamp_ns = timestamp_ns,
        .is_keyframe = is_keyframe ? 1 : 0,
    };

    /* Send header */
    ssize_t n = write(client_fd, &hdr, sizeof(hdr));
    if (n < 0) {
        if (errno == EPIPE || errno == ECONNRESET) {
            fprintf(stderr, "[strux-screen] Client disconnected\n");
            close(client_fd);
            client_fd = -1;
            return -1;
        }
        return -1;
    }

    /* Send payload */
    size_t sent = 0;
    while (sent < size) {
        n = write(client_fd, data + sent, size - sent);
        if (n < 0) {
            if (errno == EPIPE || errno == ECONNRESET) {
                close(client_fd);
                client_fd = -1;
                return -1;
            }
            return -1;
        }
        sent += n;
    }

    return 0;
}

/* Send a JSON control message to the connected client */
static int socket_send_control(const char *json)
{
    if (client_fd < 0)
        return -1;

    size_t len = strlen(json);
    uint32_t total_len = (uint32_t)(len + 1); /* include newline */

    struct frame_header hdr = {
        .length = total_len,
        .msg_type = MSG_TYPE_CONTROL,
        .timestamp_ns = 0,
        .is_keyframe = 0,
    };

    ssize_t n = write(client_fd, &hdr, sizeof(hdr));
    if (n < 0)
        return -1;

    n = write(client_fd, json, len);
    if (n < 0)
        return -1;

    char nl = '\n';
    write(client_fd, &nl, 1);

    return 0;
}

/* Accept a client connection (non-blocking check) */
static void socket_accept_client(void)
{
    if (client_fd >= 0)
        return; /* Already have a client */

    /* Use non-blocking accept */
    fd_set fds;
    FD_ZERO(&fds);
    FD_SET(server_fd, &fds);
    struct timeval tv = {0, 0}; /* Non-blocking */

    if (select(server_fd + 1, &fds, NULL, NULL, &tv) > 0) {
        client_fd = accept(server_fd, NULL, NULL);
        if (client_fd >= 0) {
            fprintf(stderr, "[strux-screen] Client connected\n");
        }
    }
}

/* Read control commands from client (non-blocking). Returns a buffered
 * command first if one is already complete, so callers can drain the queue
 * with repeated calls. */
static char *socket_read_command(void)
{
    if (client_fd < 0)
        return NULL;

    static char buf[4096];
    static size_t buf_pos = 0;

    /* A complete command may already be buffered from a previous read */
    char *newline = memchr(buf, '\n', buf_pos);

    if (!newline) {
        fd_set fds;
        FD_ZERO(&fds);
        FD_SET(client_fd, &fds);
        struct timeval tv = {0, 0};

        if (select(client_fd + 1, &fds, NULL, NULL, &tv) <= 0)
            return NULL;

        ssize_t n = read(client_fd, buf + buf_pos, sizeof(buf) - buf_pos - 1);
        if (n <= 0) {
            if (n == 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) {
                fprintf(stderr, "[strux-screen] Client disconnected\n");
                close(client_fd);
                client_fd = -1;
                buf_pos = 0;
            }
            return NULL;
        }

        buf_pos += n;
        newline = memchr(buf, '\n', buf_pos);
    }

    if (newline) {
        *newline = '\0';
        char *cmd = strdup(buf);
        size_t remaining = buf_pos - (newline - buf + 1);
        memmove(buf, newline + 1, remaining);
        buf_pos = remaining;
        return cmd;
    }

    return NULL;
}

static void socket_cleanup(void)
{
    if (client_fd >= 0) {
        close(client_fd);
        client_fd = -1;
    }
    if (server_fd >= 0) {
        close(server_fd);
        server_fd = -1;
    }
    if (config.socket_path)
        unlink(config.socket_path);
}

/* --- Signal handling --- */

static void handle_signal(int sig)
{
    (void)sig;
    config.running = false;
}

/* --- Encoded frame callback --- */

static uint64_t encoded_frame_count = 0;

static void on_encoded_frame(const uint8_t *data, size_t size,
                             uint64_t timestamp_ns, bool is_keyframe,
                             void *user_data)
{
    (void)user_data;
    encoded_frame_count++;
    if (encoded_frame_count <= 5 || encoded_frame_count % 100 == 0) {
        fprintf(stderr, "[strux-screen] Encoded frame #%lu: %zu bytes, keyframe=%d\n",
                encoded_frame_count, size, is_keyframe);
    }
    socket_send_frame(data, size, timestamp_ns, is_keyframe);
}

/* --- Frame capture callback --- */

static struct pipeline_context pipeline;
static bool pipeline_initialized = false;
static bool streaming = false;

static void on_frame_captured(struct capture_context *ctx, void *data,
                              uint32_t width, uint32_t height,
                              uint32_t stride, uint32_t format,
                              uint64_t timestamp_ns)
{
    (void)timestamp_ns;

    if (!streaming)
        return;

    /* Initialize pipeline on first frame (we now know dimensions) */
    if (!pipeline_initialized) {
        memset(&pipeline, 0, sizeof(pipeline));
        pipeline.on_encoded_frame = on_encoded_frame;

        if (pipeline_init(&pipeline, width, height, config.fps, format) < 0) {
            fprintf(stderr, "[strux-screen] Failed to initialize pipeline\n");
            config.running = false;
            return;
        }
        pipeline_initialized = true;

        /* Force first keyframe */
        pipeline_force_keyframe(&pipeline);

        /* Send ready event */
        char info[256];
        snprintf(info, sizeof(info),
                 "{\"type\":\"ready\",\"width\":%u,\"height\":%u,"
                 "\"encoder\":\"%s\",\"fps\":%d}",
                 width, height,
                 pipeline.encoder_name ? pipeline.encoder_name : "unknown",
                 config.fps);
        socket_send_control(info);
    }

    size_t size = stride * height;
    pipeline_push_frame(&pipeline, data, size, format);
}

/* --- Virtual input --- */

static struct input_context input_ctx;
static bool input_initialized = false;

/* Extract a numeric JSON field ("key" includes quotes and colon, e.g.
 * "\"x\":"). Good enough for the flat, trusted command messages the client
 * sends; not a general JSON parser. */
static double json_number(const char *json, const char *key, double fallback)
{
    const char *p = strstr(json, key);
    if (!p)
        return fallback;
    return strtod(p + strlen(key), NULL);
}

static bool json_true(const char *json, const char *key)
{
    const char *p = strstr(json, key);
    if (!p)
        return false;
    p += strlen(key);
    while (*p == ' ')
        p++;
    return strncmp(p, "true", 4) == 0;
}

static bool handle_input_command(const char *cmd)
{
    if (strstr(cmd, "\"input-pointer-motion\"")) {
        double x = json_number(cmd, "\"x\":", -1.0);
        double y = json_number(cmd, "\"y\":", -1.0);
        if (input_initialized && x >= 0.0 && y >= 0.0)
            input_pointer_motion(&input_ctx, x, y);
        return true;
    }
    if (strstr(cmd, "\"input-pointer-button\"")) {
        if (input_initialized)
            input_pointer_button(&input_ctx,
                                 (uint32_t)json_number(cmd, "\"button\":", 0),
                                 json_true(cmd, "\"pressed\":"));
        return true;
    }
    if (strstr(cmd, "\"input-pointer-axis\"")) {
        if (input_initialized)
            input_pointer_axis(&input_ctx,
                               strstr(cmd, "\"horizontal\"") != NULL,
                               json_number(cmd, "\"value\":", 0.0));
        return true;
    }
    if (strstr(cmd, "\"input-keyboard-key\"")) {
        if (input_initialized)
            input_keyboard_key(&input_ctx,
                               (uint32_t)json_number(cmd, "\"keycode\":", 0),
                               json_true(cmd, "\"pressed\":"));
        return true;
    }
    if (strstr(cmd, "\"input-keyboard-modifiers\"")) {
        if (input_initialized)
            input_keyboard_modifiers(&input_ctx,
                (uint32_t)json_number(cmd, "\"depressed\":", 0),
                (uint32_t)json_number(cmd, "\"latched\":", 0),
                (uint32_t)json_number(cmd, "\"locked\":", 0),
                (uint32_t)json_number(cmd, "\"group\":", 0));
        return true;
    }
    return false;
}

/* --- Screenshot handling --- */

static void handle_screenshot(struct capture_context *capture_ctx)
{
    /* Capture a single frame */
    if (capture_frame(capture_ctx) < 0) {
        socket_send_control("{\"type\":\"error\","
                            "\"message\":\"Screenshot capture failed\"}");
        return;
    }

    size_t jpeg_size = 0;
    uint8_t *jpeg = pipeline_screenshot(&pipeline,
                                        capture_ctx->data,
                                        capture_ctx->stride * capture_ctx->height,
                                        capture_ctx->width,
                                        capture_ctx->height,
                                        capture_ctx->format,
                                        &jpeg_size);

    if (!jpeg || jpeg_size == 0) {
        socket_send_control("{\"type\":\"error\","
                            "\"message\":\"Screenshot encoding failed\"}");
        return;
    }

    /* Base64 encode the JPEG */
    size_t b64_size = 4 * ((jpeg_size + 2) / 3);
    char *b64 = malloc(b64_size + 1);
    if (!b64) {
        free(jpeg);
        return;
    }

    /* Simple base64 encoder */
    static const char b64_table[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t i, j;
    for (i = 0, j = 0; i < jpeg_size; i += 3, j += 4) {
        uint32_t n = ((uint32_t)jpeg[i]) << 16;
        if (i + 1 < jpeg_size) n |= ((uint32_t)jpeg[i + 1]) << 8;
        if (i + 2 < jpeg_size) n |= jpeg[i + 2];

        b64[j]     = b64_table[(n >> 18) & 0x3F];
        b64[j + 1] = b64_table[(n >> 12) & 0x3F];
        b64[j + 2] = (i + 1 < jpeg_size) ? b64_table[(n >> 6) & 0x3F] : '=';
        b64[j + 3] = (i + 2 < jpeg_size) ? b64_table[n & 0x3F] : '=';
    }
    b64[j] = '\0';

    /* Send as JSON control message */
    size_t msg_size = b64_size + 256;
    char *msg = malloc(msg_size);
    if (msg) {
        snprintf(msg, msg_size,
                 "{\"type\":\"screenshot\",\"data\":\"%s\","
                 "\"width\":%u,\"height\":%u}",
                 b64, capture_ctx->width, capture_ctx->height);
        socket_send_control(msg);
        free(msg);
    }

    free(b64);
    free(jpeg);
}

/* --- Main --- */

static void print_usage(const char *prog)
{
    fprintf(stderr,
        "Usage: %s --output <name> [--fps <rate>] [--socket <path>]\n"
        "\n"
        "Options:\n"
        "  --output <name>   Wayland output name (e.g., HDMI-A-1)\n"
        "  --fps <rate>      Target frame rate (default: 30)\n"
        "  --socket <path>   Unix socket path (default: /tmp/strux-screen-<output>.sock)\n"
        "  --help            Show this help\n",
        prog);
}

int main(int argc, char *argv[])
{
    static struct option long_options[] = {
        {"output", required_argument, 0, 'o'},
        {"fps",    required_argument, 0, 'f'},
        {"socket", required_argument, 0, 's'},
        {"help",   no_argument,       0, 'h'},
        {0, 0, 0, 0}
    };

    int opt;
    while ((opt = getopt_long(argc, argv, "o:f:s:h", long_options, NULL)) != -1) {
        switch (opt) {
        case 'o':
            config.output_name = optarg;
            break;
        case 'f':
            config.fps = atoi(optarg);
            if (config.fps < 1 || config.fps > 60) {
                fprintf(stderr, "FPS must be between 1 and 60\n");
                return 1;
            }
            break;
        case 's':
            config.socket_path = optarg;
            break;
        case 'h':
            print_usage(argv[0]);
            return 0;
        default:
            print_usage(argv[0]);
            return 1;
        }
    }

    if (!config.output_name) {
        fprintf(stderr, "Error: --output is required\n");
        print_usage(argv[0]);
        return 1;
    }

    /* Default socket path */
    char socket_path_buf[256];
    if (!config.socket_path) {
        snprintf(socket_path_buf, sizeof(socket_path_buf),
                 "/tmp/strux-screen-%s.sock", config.output_name);
        config.socket_path = socket_path_buf;
    }

    /* Initialize GStreamer */
    gst_init(&argc, &argv);

    /* Set up signal handlers */
    signal(SIGINT, handle_signal);
    signal(SIGTERM, handle_signal);
    signal(SIGPIPE, SIG_IGN);

    /* Initialize Wayland capture */
    struct capture_context capture_ctx;

    if (capture_init(&capture_ctx, config.output_name) < 0) {
        fprintf(stderr, "[strux-screen] Failed to initialize capture\n");
        return 1;
    }

    /* Set callbacks AFTER init (init does memset) */
    capture_ctx.on_frame = on_frame_captured;
    capture_ctx.user_data = NULL;

    fprintf(stderr, "[strux-screen] Capture initialized for output: %s\n",
            config.output_name);

    /* Initialize virtual input injection (non-fatal if unsupported) */
    if (input_init(&input_ctx, &capture_ctx) == 0) {
        input_initialized = true;
        fprintf(stderr, "[strux-screen] Virtual input ready "
                        "(pointer=%d keyboard=%d)\n",
                input_ctx.pointer_ok, input_ctx.keyboard_ok);
    } else {
        fprintf(stderr, "[strux-screen] Virtual input unavailable; "
                        "remote input disabled\n");
    }

    /* Initialize Unix socket server */
    if (socket_server_init(config.socket_path) < 0) {
        capture_destroy(&capture_ctx);
        return 1;
    }

    /* Main loop: wait for client, then stream */
    fprintf(stderr, "[strux-screen] Waiting for client connection...\n");

    struct timespec frame_interval;
    frame_interval.tv_sec = 0;
    frame_interval.tv_nsec = 1000000000L / config.fps;

    while (config.running) {
        /* Accept new client if none connected */
        socket_accept_client();

        /* Drain all pending commands (input events arrive faster than the
         * frame loop iterates) */
        char *cmd;
        while ((cmd = socket_read_command()) != NULL) {
            if (handle_input_command(cmd)) {
                /* handled */
            } else if (strstr(cmd, "\"start\"") || strstr(cmd, "start")) {
                fprintf(stderr, "[strux-screen] Starting stream\n");
                streaming = true;
                if (pipeline_initialized)
                    pipeline_force_keyframe(&pipeline);
            } else if (strstr(cmd, "\"stop\"") || strstr(cmd, "stop")) {
                fprintf(stderr, "[strux-screen] Stopping stream\n");
                streaming = false;
            } else if (strstr(cmd, "\"screenshot\"") || strstr(cmd, "screenshot")) {
                fprintf(stderr, "[strux-screen] Taking screenshot\n");
                handle_screenshot(&capture_ctx);
            }
            free(cmd);
        }

        /* Capture and encode frames when streaming */
        if (streaming && client_fd >= 0) {
            if (capture_frame(&capture_ctx) < 0) {
                /* Retry on next iteration */
                struct timespec retry_sleep = {0, 10000000L}; /* 10ms */
                nanosleep(&retry_sleep, NULL);
                continue;
            }
        } else {
            /* Not streaming — sleep to avoid busy loop */
            nanosleep(&frame_interval, NULL);
        }
    }

    /* Cleanup */
    fprintf(stderr, "[strux-screen] Shutting down\n");

    if (pipeline_initialized)
        pipeline_destroy(&pipeline);
    if (input_initialized)
        input_destroy(&input_ctx);
    capture_destroy(&capture_ctx);
    socket_cleanup();
    gst_deinit();

    return 0;
}
