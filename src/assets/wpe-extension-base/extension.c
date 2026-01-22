#include <glib.h>
#include <gio/gio.h>
#include <stdio.h>
#include <string.h>
#include <wpe/webkit-web-process-extension.h>
#include <jsc/jsc.h>
#include <json-glib/json-glib.h>

#define SOCKET_PATH "/tmp/strux-ipc.sock"

// Sync socket connection (for fields and initialization)
static GSocketConnection *sync_connection = NULL;
static GOutputStream *sync_output = NULL;
static GInputStream *sync_input = NULL;
static GMutex sync_mutex;

// Async socket connection (for method calls)
static GSocketConnection *async_connection = NULL;
static GOutputStream *async_output = NULL;
static GDataInputStream *async_data_input = NULL;
static GMutex async_mutex;
static GQueue *async_queue = NULL;
static gboolean async_inflight = FALSE;

static guint call_counter = 0;

// Pending promise tracking
typedef struct {
    JSCValue *resolve;
    JSCValue *reject;
    JSCContext *context;
} PendingPromise;

// Async read context (no buffer needed - GDataInputStream handles it)
typedef struct {
    gchar *call_id;
} AsyncReadContext;

static GHashTable *pending_promises = NULL;  // Maps call_id -> PendingPromise
static GMutex promises_mutex;

typedef struct {
    gchar *message;
    gchar *call_id;
    JSCValue *resolve;
    JSCValue *reject;
    JSCContext *context;
} AsyncRequest;

// Forward declarations
static void free_pending_promise (gpointer data);
static void free_async_request (AsyncRequest *req);
static gboolean connect_async_ipc (void);
static void async_read_callback (GObject *source_object, GAsyncResult *res, gpointer user_data);
static void start_next_async_request (void);

static void
free_async_request (AsyncRequest *req)
{
    if (!req) return;
    g_free(req->message);
    g_free(req->call_id);
    if (req->resolve) g_object_unref(req->resolve);
    if (req->reject) g_object_unref(req->reject);
    if (req->context) g_object_unref(req->context);
    g_free(req);
}

static void
start_next_async_request (void)
{
    g_mutex_lock(&async_mutex);
    if (async_inflight || !async_queue || async_queue->length == 0) {
        g_mutex_unlock(&async_mutex);
        return;
    }

    AsyncRequest *req = g_queue_pop_head(async_queue);
    async_inflight = TRUE;
    g_mutex_unlock(&async_mutex);

    if (!connect_async_ipc()) {
        JSCValue *error_obj = jsc_value_new_string(req->context, "Failed to connect to IPC");
        (void)jsc_value_function_call(req->reject, JSC_TYPE_VALUE, error_obj, G_TYPE_NONE);
        g_object_unref(error_obj);
        free_async_request(req);

        g_mutex_lock(&async_mutex);
        async_inflight = FALSE;
        g_mutex_unlock(&async_mutex);
        start_next_async_request();
        return;
    }

    // Store pending promise
    g_mutex_lock(&promises_mutex);
    PendingPromise *promise = g_new(PendingPromise, 1);
    promise->resolve = g_object_ref(req->resolve);
    promise->reject = g_object_ref(req->reject);
    promise->context = g_object_ref(req->context);
    g_hash_table_insert(pending_promises, g_strdup(req->call_id), promise);
    g_mutex_unlock(&promises_mutex);

    gchar *msg_with_newline = g_strdup_printf("%s\n", req->message);
    GError *error = NULL;
    gsize bytes_written;

    if (!g_output_stream_write_all(async_output, msg_with_newline, strlen(msg_with_newline),
                                    &bytes_written, NULL, &error)) {
        fprintf(stderr, "Strux Extension: Failed to write: %s\n", error->message);
        g_error_free(error);
        g_free(msg_with_newline);

        JSCValue *error_obj = jsc_value_new_string(req->context, "Failed to write message");
        (void)jsc_value_function_call(req->reject, JSC_TYPE_VALUE, error_obj, G_TYPE_NONE);
        g_object_unref(error_obj);

        g_mutex_lock(&promises_mutex);
        g_hash_table_remove(pending_promises, req->call_id);
        g_mutex_unlock(&promises_mutex);

        free_async_request(req);
        g_mutex_lock(&async_mutex);
        async_inflight = FALSE;
        g_mutex_unlock(&async_mutex);
        start_next_async_request();
        return;
    }
    g_free(msg_with_newline);

    AsyncReadContext *ctx = g_new(AsyncReadContext, 1);
    ctx->call_id = g_strdup(req->call_id);

    g_data_input_stream_read_line_async(async_data_input, G_PRIORITY_DEFAULT, NULL,
                                         async_read_callback, ctx);

    free_async_request(req);
}

// Connect to the sync IPC socket
static gboolean
connect_sync_ipc (void)
{
    GSocketClient *client;
    GSocketAddress *address;
    GError *error = NULL;

    if (sync_connection != NULL)
        return TRUE;

    client = g_socket_client_new();
    address = g_unix_socket_address_new(SOCKET_PATH);

    sync_connection = g_socket_client_connect(client, G_SOCKET_CONNECTABLE(address), NULL, &error);

    g_object_unref(address);
    g_object_unref(client);

    if (error) {
        fprintf(stderr, "Strux Extension: Failed to connect sync IPC socket: %s\n", error->message);
        g_error_free(error);
        return FALSE;
    }

    sync_output = g_io_stream_get_output_stream(G_IO_STREAM(sync_connection));
    sync_input = g_io_stream_get_input_stream(G_IO_STREAM(sync_connection));

    fprintf(stderr, "Strux Extension: Connected sync IPC socket\n");
    return TRUE;
}

// Connect to the async IPC socket
static gboolean
connect_async_ipc (void)
{
    GSocketClient *client;
    GSocketAddress *address;
    GError *error = NULL;

    if (async_connection != NULL)
        return TRUE;

    client = g_socket_client_new();
    address = g_unix_socket_address_new(SOCKET_PATH);

    async_connection = g_socket_client_connect(client, G_SOCKET_CONNECTABLE(address), NULL, &error);

    g_object_unref(address);
    g_object_unref(client);

    if (error) {
        fprintf(stderr, "Strux Extension: Failed to connect async IPC socket: %s\n", error->message);
        g_error_free(error);
        return FALSE;
    }

    async_output = g_io_stream_get_output_stream(G_IO_STREAM(async_connection));
    GInputStream *async_input = g_io_stream_get_input_stream(G_IO_STREAM(async_connection));

    // Wrap input stream with GDataInputStream for async line reading
    async_data_input = g_data_input_stream_new(async_input);

    fprintf(stderr, "Strux Extension: Connected async IPC socket\n");
    return TRUE;
}

// Callback for async read completion
static void
async_read_callback (GObject *source_object, GAsyncResult *res, gpointer user_data)
{
    AsyncReadContext *ctx = (AsyncReadContext*)user_data;
    GError *error = NULL;
    gsize length;

    // Read line dynamically allocates the buffer for us
    gchar *line = g_data_input_stream_read_line_finish(G_DATA_INPUT_STREAM(source_object),
                                                         res, &length, &error);

    if (!line || error) {
        // Handle error
        g_mutex_lock(&promises_mutex);
        PendingPromise *promise = g_hash_table_lookup(pending_promises, ctx->call_id);
        if (promise) {
            JSCValue *error_obj = jsc_value_new_string(promise->context,
                error ? error->message : "Failed to read response");
            (void)jsc_value_function_call(promise->reject, JSC_TYPE_VALUE, error_obj, G_TYPE_NONE);
            g_object_unref(error_obj);
            g_hash_table_remove(pending_promises, ctx->call_id);
        }
        g_mutex_unlock(&promises_mutex);

        if (error) g_error_free(error);
        if (line) g_free(line);
        g_free(ctx->call_id);
        g_free(ctx);
        return;
    }

    // Parse response and resolve/reject promise
    JsonParser *parser = json_parser_new();
    if (json_parser_load_from_data(parser, line, -1, &error)) {
        JsonNode *response_root = json_parser_get_root(parser);
        JsonObject *response_obj = json_node_get_object(response_root);

        g_mutex_lock(&promises_mutex);
        PendingPromise *promise = g_hash_table_lookup(pending_promises, ctx->call_id);

        if (!promise) {
            fprintf(stderr, "Strux Extension: Promise %s not found (page may have reloaded)\n", ctx->call_id);
            g_mutex_unlock(&promises_mutex);
            g_object_unref(parser);
            g_free(line);
            g_free(ctx->call_id);
            g_free(ctx);

            g_mutex_lock(&async_mutex);
            async_inflight = FALSE;
            g_mutex_unlock(&async_mutex);
            start_next_async_request();
            return;
        }

        if (promise) {
            if (json_object_has_member(response_obj, "error")) {
                const gchar *error_msg = json_object_get_string_member(response_obj, "error");
                JSCValue *error_obj = jsc_value_new_string(promise->context, error_msg);
                (void)jsc_value_function_call(promise->reject, JSC_TYPE_VALUE, error_obj, G_TYPE_NONE);
                g_object_unref(error_obj);
            } else if (json_object_has_member(response_obj, "result")) {
                JsonNode *result_node = json_object_get_member(response_obj, "result");
                JSCValue *result = NULL;

                // Convert JSON result to JSCValue
                JsonNodeType node_type = json_node_get_node_type(result_node);
                
                if (node_type == JSON_NODE_VALUE) {
                    // Handle primitive types
                    if (json_node_get_value_type(result_node) == G_TYPE_STRING) {
                        result = jsc_value_new_string(promise->context, json_node_get_string(result_node));
                    } else if (json_node_get_value_type(result_node) == G_TYPE_DOUBLE ||
                               json_node_get_value_type(result_node) == G_TYPE_INT64) {
                        result = jsc_value_new_number(promise->context, json_node_get_double(result_node));
                    } else if (json_node_get_value_type(result_node) == G_TYPE_BOOLEAN) {
                        result = jsc_value_new_boolean(promise->context, json_node_get_boolean(result_node));
                    } else {
                        result = jsc_value_new_null(promise->context);
                    }
                } else if (node_type == JSON_NODE_OBJECT || node_type == JSON_NODE_ARRAY) {
                    // Handle objects and arrays by serializing to JSON and parsing in JS
                    JsonGenerator *result_gen = json_generator_new();
                    json_generator_set_root(result_gen, result_node);
                    gchar *json_result_str = json_generator_to_data(result_gen, NULL);
                    g_object_unref(result_gen);
                    
                    fprintf(stderr, "Strux Extension: Parsing JSON object/array: %s\n", json_result_str);
                    
                    // Use JSON.parse in JavaScript to convert the JSON string to an object
                    JSCValue *global = jsc_context_get_global_object(promise->context);
                    JSCValue *json_obj = jsc_value_object_get_property(global, "JSON");
                    JSCValue *parse_func = jsc_value_object_get_property(json_obj, "parse");
                    JSCValue *json_str_val = jsc_value_new_string(promise->context, json_result_str);
                    
                    result = jsc_value_function_call(parse_func, JSC_TYPE_VALUE, json_str_val, G_TYPE_NONE);
                    
                    // Check for exceptions
                    JSCException *exception = jsc_context_get_exception(promise->context);
                    if (exception) {
                        fprintf(stderr, "Strux Extension: JSON.parse exception: %s\n", 
                                jsc_exception_get_message(exception));
                        jsc_context_clear_exception(promise->context);
                        result = jsc_value_new_undefined(promise->context);
                    } else {
                        // Debug: check what type the result is
                        fprintf(stderr, "Strux Extension: Parsed result is_object=%d is_array=%d is_undefined=%d\n",
                                jsc_value_is_object(result),
                                jsc_value_is_array(result),
                                jsc_value_is_undefined(result));
                    }
                    
                    g_object_unref(json_str_val);
                    g_object_unref(parse_func);
                    g_object_unref(json_obj);
                    g_object_unref(global);
                    g_free(json_result_str);
                } else if (node_type == JSON_NODE_NULL) {
                    result = jsc_value_new_null(promise->context);
                } else {
                    result = jsc_value_new_undefined(promise->context);
                }

                (void)jsc_value_function_call(promise->resolve, JSC_TYPE_VALUE, result, G_TYPE_NONE);
                if (result) g_object_unref(result);
            }

            g_hash_table_remove(pending_promises, ctx->call_id);
        }
        g_mutex_unlock(&promises_mutex);
    }

    g_object_unref(parser);
    g_free(line);  // Free the dynamically allocated line
    g_free(ctx->call_id);
    g_free(ctx);

    g_mutex_lock(&async_mutex);
    async_inflight = FALSE;
    g_mutex_unlock(&async_mutex);
    start_next_async_request();
}

// Send a message asynchronously (uses async connection)
static void
send_ipc_message_async (const gchar *message, const gchar *call_id, JSCValue *resolve, JSCValue *reject, JSCContext *context)
{
    AsyncRequest *req = g_new0(AsyncRequest, 1);
    req->message = g_strdup(message);
    req->call_id = g_strdup(call_id);
    req->resolve = g_object_ref(resolve);
    req->reject = g_object_ref(reject);
    req->context = g_object_ref(context);

    g_mutex_lock(&async_mutex);
    if (!async_queue) {
        async_queue = g_queue_new();
    }
    g_queue_push_tail(async_queue, req);
    gboolean should_start = !async_inflight;
    g_mutex_unlock(&async_mutex);

    if (should_start) {
        start_next_async_request();
    }
}

// Synchronous version for field access and initialization (uses sync connection)
static gchar*
send_ipc_message_sync (const gchar *message)
{
    GError *error = NULL;
    GString *response = g_string_new(NULL);
    gchar byte;
    gssize bytes_read;

    g_mutex_lock(&sync_mutex);

    if (!connect_sync_ipc()) {
        g_mutex_unlock(&sync_mutex);
        g_string_free(response, TRUE);
        return NULL;
    }

    // Send message (with newline delimiter)
    gchar *msg_with_newline = g_strdup_printf("%s\n", message);
    gsize bytes_written;

    if (!g_output_stream_write_all(sync_output, msg_with_newline, strlen(msg_with_newline),
                                    &bytes_written, NULL, &error)) {
        fprintf(stderr, "Strux Extension: Failed to write: %s\n", error->message);
        g_error_free(error);
        g_free(msg_with_newline);
        g_mutex_unlock(&sync_mutex);
        g_string_free(response, TRUE);
        return NULL;
    }
    g_free(msg_with_newline);

    // Read response byte-by-byte until newline (dynamic size)
    while (TRUE) {
        bytes_read = g_input_stream_read(sync_input, &byte, 1, NULL, &error);

        if (bytes_read <= 0) {
            if (error) {
                fprintf(stderr, "Strux Extension: Failed to read: %s\n", error->message);
                g_error_free(error);
            }
            g_mutex_unlock(&sync_mutex);
            g_string_free(response, TRUE);
            return NULL;
        }

        if (byte == '\n') {
            break;  // Found delimiter
        }

        g_string_append_c(response, byte);
    }

    g_mutex_unlock(&sync_mutex);

    // Transfer ownership of the string data
    return g_string_free(response, FALSE);  // FALSE = don't free the char*, return it
}

// JavaScript function wrapper that calls Go methods asynchronously
static JSCValue*
js_call_go_method (const gchar *method_name, GPtrArray *arguments, JSCContext *context)
{
    JsonBuilder *builder = json_builder_new();
    JsonGenerator *generator = json_generator_new();
    JsonNode *root;
    gchar *json_str;

    // Build JSON-RPC message
    json_builder_begin_object(builder);

    // Add ID
    json_builder_set_member_name(builder, "id");
    gchar *call_id = g_strdup_printf("%u", g_atomic_int_add(&call_counter, 1));
    json_builder_add_string_value(builder, call_id);

    // Add method name
    json_builder_set_member_name(builder, "method");
    json_builder_add_string_value(builder, method_name);

    // Add parameters
    json_builder_set_member_name(builder, "params");
    json_builder_begin_array(builder);

    if (arguments) {
        for (guint i = 0; i < arguments->len; i++) {
            JSCValue *arg = g_ptr_array_index(arguments, i);

            if (jsc_value_is_string(arg)) {
                gchar *str = jsc_value_to_string(arg);
                json_builder_add_string_value(builder, str);
                g_free(str);
            } else if (jsc_value_is_number(arg)) {
                gdouble num = jsc_value_to_double(arg);
                json_builder_add_double_value(builder, num);
            } else if (jsc_value_is_boolean(arg)) {
                gboolean bool_val = jsc_value_to_boolean(arg);
                json_builder_add_boolean_value(builder, bool_val);
            } else {
                json_builder_add_null_value(builder);
            }
        }
    }

    json_builder_end_array(builder);
    json_builder_end_object(builder);

    root = json_builder_get_root(builder);
    json_generator_set_root(generator, root);
    json_str = json_generator_to_data(generator, NULL);

    // Create a new Promise using JavaScript
    // We need to extract the resolve/reject callbacks, so we use a wrapper pattern
    gchar *promise_code = g_strdup_printf(
        "(function() {"
        "  let promiseResolve, promiseReject;"
        "  const promise = new Promise((resolve, reject) => {"
        "    promiseResolve = resolve;"
        "    promiseReject = reject;"
        "  });"
        "  promise.__resolve = promiseResolve;"
        "  promise.__reject = promiseReject;"
        "  return promise;"
        "})()"
    );

    JSCValue *promise_with_callbacks = jsc_context_evaluate(context, promise_code, -1);
    g_free(promise_code);

    // Extract resolve and reject functions
    JSCValue *resolve = jsc_value_object_get_property(promise_with_callbacks, "__resolve");
    JSCValue *reject = jsc_value_object_get_property(promise_with_callbacks, "__reject");

    // Send message asynchronously
    send_ipc_message_async(json_str, call_id, resolve, reject, context);

    // Clean up (call_id is now owned by async function)
    g_free(call_id);
    g_free(json_str);
    json_node_free(root);
    g_object_unref(generator);
    g_object_unref(builder);
    g_object_unref(resolve);
    g_object_unref(reject);

    return promise_with_callbacks;
}

// Variadic callback wrapper for Go methods
static JSCValue*
go_method_callback_variadic (GPtrArray *args, gpointer user_data)
{
    const gchar *method_name = (const gchar*)user_data;

    // Get context from first argument if available, or use current context
    JSCContext *context = NULL;
    if (args && args->len > 0) {
        JSCValue *first = g_ptr_array_index(args, 0);
        context = jsc_value_get_context(first);
    }

    if (!context) {
        context = jsc_context_get_current();
    }

    // Call Go backend asynchronously - returns a Promise
    JSCValue *promise = js_call_go_method(method_name, args, context);

    return promise;
}

// Get field value from Go backend
static JSCValue*
get_field_value (const gchar *field_name, JSCContext *context)
{
    JsonBuilder *builder = json_builder_new();
    JsonGenerator *generator = json_generator_new();
    JsonNode *root;
    gchar *json_str;
    gchar *response_str;
    JSCValue *result = NULL;

    // Build __getField request
    json_builder_begin_object(builder);
    json_builder_set_member_name(builder, "id");
    gchar *id = g_strdup_printf("%u", g_atomic_int_add(&call_counter, 1));
    json_builder_add_string_value(builder, id);
    g_free(id);

    json_builder_set_member_name(builder, "method");
    json_builder_add_string_value(builder, "__getField");

    json_builder_set_member_name(builder, "params");
    json_builder_begin_array(builder);
    json_builder_add_string_value(builder, field_name);
    json_builder_end_array(builder);
    json_builder_end_object(builder);

    root = json_builder_get_root(builder);
    json_generator_set_root(generator, root);
    json_str = json_generator_to_data(generator, NULL);

    response_str = send_ipc_message_sync(json_str);

    if (response_str) {
        JsonParser *parser = json_parser_new();
        GError *error = NULL;

        if (json_parser_load_from_data(parser, response_str, -1, &error)) {
            JsonNode *response_root = json_parser_get_root(parser);
            JsonObject *response_obj = json_node_get_object(response_root);

            if (json_object_has_member(response_obj, "result")) {
                JsonNode *result_node = json_object_get_member(response_obj, "result");

                // Convert JSON result to JSCValue
                JsonNodeType node_type = json_node_get_node_type(result_node);
                
                if (node_type == JSON_NODE_VALUE) {
                    // Handle primitive types
                    if (json_node_get_value_type(result_node) == G_TYPE_STRING) {
                        result = jsc_value_new_string(context, json_node_get_string(result_node));
                    } else if (json_node_get_value_type(result_node) == G_TYPE_DOUBLE ||
                               json_node_get_value_type(result_node) == G_TYPE_INT64) {
                        result = jsc_value_new_number(context, json_node_get_double(result_node));
                    } else if (json_node_get_value_type(result_node) == G_TYPE_BOOLEAN) {
                        result = jsc_value_new_boolean(context, json_node_get_boolean(result_node));
                    } else {
                        result = jsc_value_new_null(context);
                    }
                } else if (node_type == JSON_NODE_OBJECT || node_type == JSON_NODE_ARRAY) {
                    // Handle objects and arrays by serializing to JSON and parsing in JS
                    JsonGenerator *result_gen = json_generator_new();
                    json_generator_set_root(result_gen, result_node);
                    gchar *json_result_str = json_generator_to_data(result_gen, NULL);
                    g_object_unref(result_gen);
                    
                    // Use JSON.parse in JavaScript to convert the JSON string to an object
                    JSCValue *global = jsc_context_get_global_object(context);
                    JSCValue *json_obj = jsc_value_object_get_property(global, "JSON");
                    JSCValue *parse_func = jsc_value_object_get_property(json_obj, "parse");
                    JSCValue *json_str_val = jsc_value_new_string(context, json_result_str);
                    
                    result = jsc_value_function_call(parse_func, JSC_TYPE_VALUE, json_str_val, G_TYPE_NONE);
                    
                    g_object_unref(json_str_val);
                    g_object_unref(parse_func);
                    g_object_unref(json_obj);
                    g_object_unref(global);
                    g_free(json_result_str);
                } else if (node_type == JSON_NODE_NULL) {
                    result = jsc_value_new_null(context);
                }
            }
        }

        g_object_unref(parser);
        g_free(response_str);
    }

    g_free(json_str);
    json_node_free(root);
    g_object_unref(generator);
    g_object_unref(builder);

    return result ? result : jsc_value_new_undefined(context);
}

// Set field value in Go backend
static void
set_field_value (const gchar *field_name, JSCValue *value)
{
    JsonBuilder *builder = json_builder_new();
    JsonGenerator *generator = json_generator_new();
    JsonNode *root;
    gchar *json_str;
    gchar *response_str;

    // Build __setField request
    json_builder_begin_object(builder);
    json_builder_set_member_name(builder, "id");
    gchar *id = g_strdup_printf("%u", g_atomic_int_add(&call_counter, 1));
    json_builder_add_string_value(builder, id);
    g_free(id);

    json_builder_set_member_name(builder, "method");
    json_builder_add_string_value(builder, "__setField");

    json_builder_set_member_name(builder, "params");
    json_builder_begin_array(builder);
    json_builder_add_string_value(builder, field_name);

    // Add value
    if (jsc_value_is_string(value)) {
        gchar *str = jsc_value_to_string(value);
        json_builder_add_string_value(builder, str);
        g_free(str);
    } else if (jsc_value_is_number(value)) {
        gdouble num = jsc_value_to_double(value);
        json_builder_add_double_value(builder, num);
    } else if (jsc_value_is_boolean(value)) {
        gboolean bool_val = jsc_value_to_boolean(value);
        json_builder_add_boolean_value(builder, bool_val);
    } else {
        json_builder_add_null_value(builder);
    }

    json_builder_end_array(builder);
    json_builder_end_object(builder);

    root = json_builder_get_root(builder);
    json_generator_set_root(generator, root);
    json_str = json_generator_to_data(generator, NULL);

    response_str = send_ipc_message_sync(json_str);
    g_free(response_str);

    g_free(json_str);
    json_node_free(root);
    g_object_unref(generator);
    g_object_unref(builder);
}


// User data for field callbacks (includes type info)
typedef struct {
    gchar *field_name;
    gchar *field_type;
} FieldUserData;

// Setter callback for field properties with type validation
static void
field_setter_callback (JSCValue *value, gpointer user_data)
{
    FieldUserData *data = (FieldUserData*)user_data;
    JSCContext *context = jsc_value_get_context(value);

    // Validate type before setting
    gboolean type_valid = FALSE;

    if (g_strcmp0(data->field_type, "string") == 0) {
        type_valid = jsc_value_is_string(value);
    } else if (g_strcmp0(data->field_type, "int") == 0 ||
               g_strcmp0(data->field_type, "int8") == 0 ||
               g_strcmp0(data->field_type, "int16") == 0 ||
               g_strcmp0(data->field_type, "int32") == 0 ||
               g_strcmp0(data->field_type, "int64") == 0 ||
               g_strcmp0(data->field_type, "uint") == 0 ||
               g_strcmp0(data->field_type, "uint8") == 0 ||
               g_strcmp0(data->field_type, "uint16") == 0 ||
               g_strcmp0(data->field_type, "uint32") == 0 ||
               g_strcmp0(data->field_type, "uint64") == 0 ||
               g_strcmp0(data->field_type, "float32") == 0 ||
               g_strcmp0(data->field_type, "float64") == 0) {
        type_valid = jsc_value_is_number(value);
    } else if (g_strcmp0(data->field_type, "bool") == 0) {
        type_valid = jsc_value_is_boolean(value);
    } else {
        // For complex types, allow objects/arrays
        type_valid = jsc_value_is_object(value) || jsc_value_is_array(value);
    }

    if (!type_valid) {
        // Throw a JavaScript TypeError
        gchar *error_msg = g_strdup_printf(
            "TypeError: Cannot assign to field '%s': expected %s but got %s",
            data->field_name,
            data->field_type,
            jsc_value_is_string(value) ? "string" :
            jsc_value_is_number(value) ? "number" :
            jsc_value_is_boolean(value) ? "boolean" :
            jsc_value_is_function(value) ? "function" :
            jsc_value_is_array(value) ? "array" :
            jsc_value_is_object(value) ? "object" : "unknown"
        );

        JSCException *exception = jsc_exception_new(context, error_msg);
        jsc_context_throw_exception(context, exception);

        g_free(error_msg);
        g_object_unref(exception);
        return;
    }

    set_field_value(data->field_name, value);
}

// Getter callback for field properties
static JSCValue*
field_getter_callback_typed (gpointer user_data)
{
    FieldUserData *data = (FieldUserData*)user_data;
    JSCContext *context = jsc_context_get_current();

    return get_field_value(data->field_name, context);
}

// Free function for FieldUserData
static void
field_user_data_free (gpointer user_data)
{
    FieldUserData *data = (FieldUserData*)user_data;
    g_free(data->field_name);
    g_free(data->field_type);
    g_free(data);
}

// Inject a field as a JavaScript property with getter/setter
static void
inject_field_property (JSCContext *context, JSCValue *object, const gchar *field_name, const gchar *field_type)
{
    // Create user data with field name and type
    FieldUserData *user_data = g_new(FieldUserData, 1);
    user_data->field_name = g_strdup(field_name);
    user_data->field_type = g_strdup(field_type);

    // Create getter function
    JSCValue *getter = jsc_value_new_function(
        context,
        NULL,
        G_CALLBACK(field_getter_callback_typed),
        user_data,
        (GDestroyNotify)field_user_data_free,  // Free when getter is destroyed
        JSC_TYPE_VALUE,
        0,
        G_TYPE_NONE
    );

    // Create another user data for setter (since both need independent ownership)
    FieldUserData *setter_data = g_new(FieldUserData, 1);
    setter_data->field_name = g_strdup(field_name);
    setter_data->field_type = g_strdup(field_type);

    // Create setter function
    JSCValue *setter = jsc_value_new_function(
        context,
        NULL,
        G_CALLBACK(field_setter_callback),
        setter_data,
        (GDestroyNotify)field_user_data_free,
        G_TYPE_NONE,
        1,
        JSC_TYPE_VALUE
    );

    // Use Object.defineProperty via JavaScript to define the property
    JSCValue *global = jsc_context_get_global_object(context);
    JSCValue *object_constructor = jsc_value_object_get_property(global, "Object");
    JSCValue *define_property = jsc_value_object_get_property(object_constructor, "defineProperty");

    // Create property descriptor object
    JSCValue *descriptor = jsc_value_new_object(context, NULL, NULL);
    jsc_value_object_set_property(descriptor, "get", getter);
    jsc_value_object_set_property(descriptor, "set", setter);
    jsc_value_object_set_property(descriptor, "enumerable", jsc_value_new_boolean(context, TRUE));
    jsc_value_object_set_property(descriptor, "configurable", jsc_value_new_boolean(context, TRUE));

    // Call Object.defineProperty(object, field_name, descriptor)
    JSCValue *field_name_str = jsc_value_new_string(context, field_name);
    JSCValue *result = jsc_value_function_call(define_property,
        JSC_TYPE_VALUE, object,
        JSC_TYPE_VALUE, field_name_str,
        JSC_TYPE_VALUE, descriptor,
        G_TYPE_NONE);

    g_object_unref(result);
    g_object_unref(field_name_str);
    g_object_unref(descriptor);
    g_object_unref(define_property);
    g_object_unref(object_constructor);
    g_object_unref(global);
    g_object_unref(getter);
    g_object_unref(setter);
    // Note: user_data is freed by getter's GDestroyNotify, setter_data by setter's
}

// Inject Go method bindings into JavaScript
static void
inject_bindings (JSCContext *js_context)
{
    JsonBuilder *builder = json_builder_new();
    JsonGenerator *generator = json_generator_new();
    JsonNode *root;
    gchar *json_str;
    gchar *response_str;

    // Build __getBindings request
    json_builder_begin_object(builder);
    json_builder_set_member_name(builder, "id");
    json_builder_add_string_value(builder, "0");
    json_builder_set_member_name(builder, "method");
    json_builder_add_string_value(builder, "__getBindings");
    json_builder_set_member_name(builder, "params");
    json_builder_add_null_value(builder);
    json_builder_end_object(builder);

    root = json_builder_get_root(builder);
    json_generator_set_root(generator, root);
    json_str = json_generator_to_data(generator, NULL);

    response_str = send_ipc_message_sync(json_str);

    if (response_str) {
        JsonParser *parser = json_parser_new();
        GError *error = NULL;

        if (json_parser_load_from_data(parser, response_str, -1, &error)) {
            JsonNode *response_root = json_parser_get_root(parser);
            JsonObject *response_obj = json_node_get_object(response_root);

            if (json_object_has_member(response_obj, "result")) {
                JsonObject *bindings = json_object_get_object_member(response_obj, "result");

                JSCValue *global = jsc_context_get_global_object(js_context);

                // Create window.go object
                JSCValue *go_obj = jsc_value_new_object(js_context, NULL, NULL);
                jsc_value_object_set_property(global, "go", go_obj);

                // Iterate through packages (e.g., "main")
                JsonObjectIter pkg_iter;
                const gchar *pkg_name;
                JsonNode *pkg_node;

                json_object_iter_init(&pkg_iter, bindings);
                while (json_object_iter_next(&pkg_iter, &pkg_name, &pkg_node)) {
                    JsonObject *pkg_obj = json_node_get_object(pkg_node);

                    // Create window.go.main object
                    JSCValue *pkg_js_obj = jsc_value_new_object(js_context, NULL, NULL);
                    jsc_value_object_set_property(go_obj, pkg_name, pkg_js_obj);

                    // Iterate through structs (e.g., "App")
                    JsonObjectIter struct_iter;
                    const gchar *struct_name;
                    JsonNode *struct_node;

                    json_object_iter_init(&struct_iter, pkg_obj);
                    while (json_object_iter_next(&struct_iter, &struct_name, &struct_node)) {
                        JsonObject *struct_data = json_node_get_object(struct_node);

                        // Create window.go.main.App object
                        JSCValue *struct_js_obj = jsc_value_new_object(js_context, NULL, NULL);
                        jsc_value_object_set_property(pkg_js_obj, struct_name, struct_js_obj);

                        // Inject methods
                        if (json_object_has_member(struct_data, "methods")) {
                            JsonArray *methods = json_object_get_array_member(struct_data, "methods");
                            guint num_methods = json_array_get_length(methods);

                            fprintf(stderr, "Strux Extension: Injecting %u methods for %s.%s\n",
                                    num_methods, pkg_name, struct_name);

                            for (guint i = 0; i < num_methods; i++) {
                                JsonObject *method_info = json_array_get_object_element(methods, i);
                                const gchar *method_name = json_object_get_string_member(method_info, "name");

                                // Create JavaScript function with variadic callback
                                JSCValue *func = jsc_value_new_function_variadic(
                                    js_context,
                                    method_name,
                                    G_CALLBACK(go_method_callback_variadic),
                                    g_strdup(method_name),
                                    (GDestroyNotify)g_free,
                                    JSC_TYPE_VALUE
                                );

                                // Inject into window.go.main.App.MethodName
                                jsc_value_object_set_property(struct_js_obj, method_name, func);

                                fprintf(stderr, "Strux Extension: Injected window.go.%s.%s.%s()\n",
                                        pkg_name, struct_name, method_name);

                                g_object_unref(func);
                            }
                        }

                        // Inject fields as properties
                        if (json_object_has_member(struct_data, "fields")) {
                            JsonArray *fields = json_object_get_array_member(struct_data, "fields");
                            guint num_fields = json_array_get_length(fields);

                            fprintf(stderr, "Strux Extension: Injecting %u fields for %s.%s\n",
                                    num_fields, pkg_name, struct_name);

                            for (guint i = 0; i < num_fields; i++) {
                                JsonObject *field_info = json_array_get_object_element(fields, i);
                                const gchar *field_name = json_object_get_string_member(field_info, "name");
                                const gchar *field_type = json_object_get_string_member(field_info, "type");

                                inject_field_property(js_context, struct_js_obj, field_name, field_type);

                                fprintf(stderr, "Strux Extension: Injected window.go.%s.%s.%s (%s)\n",
                                        pkg_name, struct_name, field_name, field_type);
                            }
                        }

                        g_object_unref(struct_js_obj);
                    }

                    g_object_unref(pkg_js_obj);
                }

                // Handle strux namespace (window.strux.boot)
                if (json_object_has_member(bindings, "strux")) {
                    JsonObject *strux_obj = json_object_get_object_member(bindings, "strux");
                    
                    // Create window.strux object
                    JSCValue *strux_js_obj = jsc_value_new_object(js_context, NULL, NULL);
                    jsc_value_object_set_property(global, "strux", strux_js_obj);
                    
                    // Iterate through strux namespaces (e.g., "boot")
                    JsonObjectIter strux_iter;
                    const gchar *strux_namespace;
                    JsonNode *strux_namespace_node;
                    
                    json_object_iter_init(&strux_iter, strux_obj);
                    while (json_object_iter_next(&strux_iter, &strux_namespace, &strux_namespace_node)) {
                        JsonObject *namespace_data = json_node_get_object(strux_namespace_node);
                        
                        // Create window.strux.boot object
                        JSCValue *namespace_js_obj = jsc_value_new_object(js_context, NULL, NULL);
                        jsc_value_object_set_property(strux_js_obj, strux_namespace, namespace_js_obj);
                        
                        // Inject methods with strux namespace prefix
                        if (json_object_has_member(namespace_data, "methods")) {
                            JsonArray *methods = json_object_get_array_member(namespace_data, "methods");
                            guint num_methods = json_array_get_length(methods);
                            
                            fprintf(stderr, "Strux Extension: Injecting %u methods for strux.%s\n",
                                    num_methods, strux_namespace);
                            
                            for (guint i = 0; i < num_methods; i++) {
                                JsonObject *method_info = json_array_get_object_element(methods, i);
                                const gchar *method_name = json_object_get_string_member(method_info, "name");
                                
                                // Create full method name with namespace prefix for IPC
                                gchar *full_method_name = g_strdup_printf("strux.%s.%s", 
                                    strux_namespace, method_name);
                                
                                // Create JavaScript function with variadic callback
                                JSCValue *func = jsc_value_new_function_variadic(
                                    js_context,
                                    method_name,
                                    G_CALLBACK(go_method_callback_variadic),
                                    full_method_name,  // Pass full name, will be freed by GDestroyNotify
                                    (GDestroyNotify)g_free,
                                    JSC_TYPE_VALUE
                                );
                                
                                // Inject into window.strux.boot.MethodName
                                jsc_value_object_set_property(namespace_js_obj, method_name, func);
                                
                                fprintf(stderr, "Strux Extension: Injected window.strux.%s.%s()\n",
                                        strux_namespace, method_name);
                                
                                g_object_unref(func);
                            }
                        }
                        
                        g_object_unref(namespace_js_obj);
                    }
                    
                    g_object_unref(strux_js_obj);
                }

                g_object_unref(go_obj);
                g_object_unref(global);
            }
        } else {
            fprintf(stderr, "Strux Extension: Failed to parse bindings: %s\n", error->message);
            g_error_free(error);
        }

        g_object_unref(parser);
        g_free(response_str);
    }

    g_free(json_str);
    json_node_free(root);
    g_object_unref(generator);
    g_object_unref(builder);
}

// Native console output function
static void
native_console_output (const gchar *level, const gchar *message)
{
    fprintf(stderr, "[JS %s] %s\n", level, message);
}

// Native error handler callback for uncaught errors
static void
native_error_handler (const gchar *message, const gchar *source, gint line, gint column, const gchar *stack, gpointer user_data)
{
    if (stack && strlen(stack) > 0) {
        fprintf(stderr, "Strux Extension: Uncaught Error: %s\n  at %s:%d:%d\n%s\n",
                message, source, line, column, stack);
    } else {
        fprintf(stderr, "Strux Extension: Uncaught Error: %s\n  at %s:%d:%d\n",
                message, source, line, column);
    }
}

// Native handler for unhandled promise rejections
static void
native_unhandled_rejection (const gchar *reason, gpointer user_data)
{
    fprintf(stderr, "Strux Extension: Unhandled Promise Rejection: %s\n", reason);
}

// Callback for console.log interceptor
static void
console_log_callback (const gchar *message, gpointer user_data)
{
    native_console_output("LOG", message);
}

static void
console_warn_callback (const gchar *message, gpointer user_data)
{
    native_console_output("WARN", message);
}

static void
console_error_callback (const gchar *message, gpointer user_data)
{
    native_console_output("ERROR", message);
}

// Inject console interceptors
static void
inject_console_interceptors (JSCContext *context)
{
    // Create native functions for console interception
    JSCValue *log_func = jsc_value_new_function(context, "__nativeLog",
        G_CALLBACK(console_log_callback), NULL, NULL,
        G_TYPE_NONE, 1, G_TYPE_STRING);

    JSCValue *warn_func = jsc_value_new_function(context, "__nativeWarn",
        G_CALLBACK(console_warn_callback), NULL, NULL,
        G_TYPE_NONE, 1, G_TYPE_STRING);

    JSCValue *error_func = jsc_value_new_function(context, "__nativeError",
        G_CALLBACK(console_error_callback), NULL, NULL,
        G_TYPE_NONE, 1, G_TYPE_STRING);

    // Create native functions for error handling
    JSCValue *error_handler_func = jsc_value_new_function(context, "__nativeErrorHandler",
        G_CALLBACK(native_error_handler), NULL, NULL,
        G_TYPE_NONE, 5, G_TYPE_STRING, G_TYPE_STRING, G_TYPE_INT, G_TYPE_INT, G_TYPE_STRING);

    JSCValue *rejection_handler_func = jsc_value_new_function(context, "__nativeUnhandledRejection",
        G_CALLBACK(native_unhandled_rejection), NULL, NULL,
        G_TYPE_NONE, 1, G_TYPE_STRING);

    // Add to global object
    JSCValue *global = jsc_context_get_global_object(context);
    jsc_value_object_set_property(global, "__nativeLog", log_func);
    jsc_value_object_set_property(global, "__nativeWarn", warn_func);
    jsc_value_object_set_property(global, "__nativeError", error_func);
    jsc_value_object_set_property(global, "__nativeErrorHandler", error_handler_func);
    jsc_value_object_set_property(global, "__nativeUnhandledRejection", rejection_handler_func);

    // Inject JavaScript to intercept console methods and catch errors
    const gchar *intercept_code =
        "(function() {"
        "  const origLog = console.log;"
        "  const origWarn = console.warn;"
        "  const origError = console.error;"
        "  console.log = function(...args) {"
        "    __nativeLog(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));"
        "    origLog.apply(console, args);"
        "  };"
        "  console.warn = function(...args) {"
        "    __nativeWarn(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));"
        "    origWarn.apply(console, args);"
        "  };"
        "  console.error = function(...args) {"
        "    __nativeError(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));"
        "    origError.apply(console, args);"
        "  };"
        // Global error handler for uncaught exceptions
        "  window.onerror = function(message, source, lineno, colno, error) {"
        "    let stack = '';"
        "    if (error && error.stack) {"
        "      stack = error.stack;"
        "    }"
        "    __nativeErrorHandler(String(message), String(source || ''), lineno || 0, colno || 0, stack);"
        "    return false;"  // Don't prevent default browser error handling
        "  };"
        // Handler for unhandled promise rejections
        "  window.addEventListener('unhandledrejection', function(event) {"
        "    let reason = '';"
        "    if (event.reason) {"
        "      if (event.reason instanceof Error) {"
        "        reason = event.reason.message;"
        "        if (event.reason.stack) {"
        "          reason += '\\n' + event.reason.stack;"
        "        }"
        "      } else if (typeof event.reason === 'object') {"
        "        try { reason = JSON.stringify(event.reason); } catch (e) { reason = String(event.reason); }"
        "      } else {"
        "        reason = String(event.reason);"
        "      }"
        "    } else {"
        "      reason = 'Unknown rejection reason';"
        "    }"
        "    __nativeUnhandledRejection(reason);"
        "  });"
        "})();";

    (void)jsc_context_evaluate(context, intercept_code, -1);

    g_object_unref(log_func);
    g_object_unref(warn_func);
    g_object_unref(error_func);
    g_object_unref(error_handler_func);
    g_object_unref(rejection_handler_func);
    g_object_unref(global);
}

static void
window_object_cleared_callback (WebKitScriptWorld *world,
                                WebKitWebPage     *web_page,
                                WebKitFrame       *frame,
                                gpointer           user_data)
{
    JSCContext *js_context = webkit_frame_get_js_context_for_script_world(frame, world);

    // Clear all pending promises from previous page - they belong to the old context
    // and cannot be resolved/rejected anymore
    g_mutex_lock(&promises_mutex);
    if (pending_promises) {
        guint num_pending = g_hash_table_size(pending_promises);
        if (num_pending > 0) {
            fprintf(stderr, "Strux Extension: Clearing %u pending promises from previous page\n", num_pending);
        }
        g_hash_table_remove_all(pending_promises);
    }
    g_mutex_unlock(&promises_mutex);

    // Clear async queue as well - those requests were for the old context
    g_mutex_lock(&async_mutex);
    if (async_queue) {
        while (!g_queue_is_empty(async_queue)) {
            AsyncRequest *req = g_queue_pop_head(async_queue);
            free_async_request(req);
        }
    }
    async_inflight = FALSE;
    g_mutex_unlock(&async_mutex);

    // Inject console interceptors first (so we can see errors during binding injection)
    inject_console_interceptors(js_context);

    // Inject Go method bindings
    inject_bindings(js_context);

    g_object_unref(js_context);
}

static void
web_page_created_callback (WebKitWebProcessExtension *extension,
                           WebKitWebPage             *web_page,
                           gpointer                   user_data)
{
    fprintf(stderr, "Strux Extension: Page Created\n");

    WebKitScriptWorld *world = webkit_script_world_get_default();
    g_signal_connect(world, "window-object-cleared",
                     G_CALLBACK(window_object_cleared_callback),
                     NULL);
}

G_MODULE_EXPORT void
webkit_web_extension_initialize (WebKitWebProcessExtension *extension)
{
    fprintf(stderr, "Strux Extension: Initializing...\n");
    g_mutex_init(&sync_mutex);
    g_mutex_init(&async_mutex);
    g_mutex_init(&promises_mutex);

    // Initialize pending promises hash table
    pending_promises = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
        (GDestroyNotify)free_pending_promise);

    g_signal_connect(extension, "page-created",
                     G_CALLBACK(web_page_created_callback),
                     NULL);
}

// Free a pending promise
static void
free_pending_promise (gpointer data)
{
    PendingPromise *promise = (PendingPromise*)data;
    if (promise) {
        if (promise->resolve) g_object_unref(promise->resolve);
        if (promise->reject) g_object_unref(promise->reject);
        if (promise->context) g_object_unref(promise->context);
        g_free(promise);
    }
}

G_MODULE_EXPORT void
webkit_web_extension_initialize_with_user_data (WebKitWebProcessExtension *extension, GVariant *user_data)
{
    webkit_web_extension_initialize(extension);
}

G_MODULE_EXPORT void
webkit_web_process_extension_initialize (WebKitWebProcessExtension *extension)
{
    webkit_web_extension_initialize(extension);
}
