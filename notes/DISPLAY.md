# Strux OS Multi-Monitor Display System

## Overview

Strux OS supports multiple independent displays, each showing a different page of your web application. The system is built on a modified Cage Wayland compositor that assigns each browser instance (Cog) to a specific physical output. Cage reads a display map at startup and spawns/kills Cog instances as monitors connect and disconnect.

```
strux.yaml                     /tmp/strux-display-map           Physical Outputs
+-----------------------+      +------------------------+       +----------------+
| display:              |      | DSI-1=http://....:8080/|       | DSI-1: /       |
|   monitors:           | ---> | DSI-1.resolution=...   | --->  | HDMI-A-1: /tv  |
|     - path: /         |      | HDMI-A-1=http://..../tv|       +----------------+
|       names: [DSI-1]  |      +------------------------+
|     - path: /tv       |              |
|       names: [HDMI-A-1|              v
+-----------------------+      Cage (per-view mode)
                               +---------------------------+
                               | Output connects:          |
                               |   1. Look up URL in map   |
                               |   2. Fork + exec          |
                               |      strux-run-cog.sh     |
                               |      <output> <url>       |
                               |   3. Assign view to output|
                               |                           |
                               | Output disconnects:       |
                               |   1. Kill Cog (SIGTERM)   |
                               |   2. Clear view assignment|
                               +---------------------------+
```

---

## Configuration

### strux.yaml

The `display` section in `strux.yaml` defines the multi-monitor layout:

```yaml
display:
  monitors:
    - path: /
      resolution: 1920x1080
      names:
        - DSI-1          # Physical output name on target hardware
        - Virtual-1      # QEMU virtual output name (for dev/testing)
      input_devices:
        - ILITEK          # Substring match for touch device names
    - path: /tv
      resolution: 1280x720
      names:
        - HDMI-A-1
        - Virtual-2
```

#### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `path` | Yes | URL path appended to the base URL (e.g., `/` or `/dashboard`) |
| `resolution` | No | Display resolution in `WIDTHxHEIGHT` format. Set via `wlr-randr` on launch. |
| `names` | No | List of output names this monitor config applies to. Supports multiple names for the same config (e.g., hardware name + QEMU virtual name). |
| `input_devices` | No | List of input device name substrings to map to this output. Used for touchscreen-to-display binding. |

#### How Output Matching Works

Each physical output has a name assigned by the DRM/KMS subsystem (e.g., `HDMI-A-1`, `DSI-1`, `DP-1`). QEMU virtual outputs are named `Virtual-1`, `Virtual-2`, etc. The `names` array lets you list all possible names for a given monitor config, so the same `strux.yaml` works on both real hardware and QEMU.

When Cage detects a new output, it looks up the output name in the display map. If found, it launches Cog with the configured URL. If not found, it shows the "Monitor Not Configured" fallback page.

#### Single-Monitor Default

If the `display` section is omitted from `strux.yaml`, the build pipeline generates a default single-monitor config using the BSP's display resolution:

```json
{"monitors":[{"path":"/","resolution":"1920x1080"}]}
```

---

## Architecture

### Data Flow: Build Time

```
strux.yaml (user config)
      |
      v
writeDisplayConfig()                    [TypeScript: steps.ts]
      |
      +---> dist/cache/{bsp}/.display-config.json    (monitor configs as JSON)
      +---> dist/cache/{bsp}/.input-map              (device:output mappings)
      |
      v
strux-build-post.sh                    [Shell: runs in Docker]
      |
      +---> /strux/.display-config.json              (copied to rootfs)
      +---> /strux/.input-map                        (copied to rootfs)
      +---> /strux/strux-run-cog.sh                  (user-modifiable Cog launcher)
      +---> /strux/.not-configured.html              (fallback page)
```

### Data Flow: Runtime

```
Strux Client (Go)
      |
      +---> LoadDisplayConfig("/strux/.display-config.json")
      |         Parses monitor configs
      |
      +---> writeDisplayMap()
      |         Writes /tmp/strux-display-map with output=url mappings
      |         Uses the correct base URL (localhost:8080 for prod,
      |         dev-server:5173 for dev mode)
      |
      +---> Launch Cage with args:
                cage -m per-view \
                     --display-map=/tmp/strux-display-map \
                     --input-map=/strux/.input-map \
                     --splash-image=/strux/logo.png
```

```
Cage Compositor
      |
      +---> Reads --display-map on startup
      |
      +---> For each output that connects (handle_new_output):
      |         1. Enable output, add to layout
      |         2. Re-map input devices (seat_remap_input_devices)
      |         3. Look up output name in display map
      |         4. Fork + exec /strux/strux-run-cog.sh <output_name> <url>
      |         5. Track child PID on cg_output struct
      |
      +---> For each output that disconnects (output_destroy):
      |         1. Kill Cog process (SIGTERM + waitpid)
      |         2. Clear assigned_output on orphaned views
      |         3. Remove output from layout
      |
      +---> For each new XDG toplevel view (view_init):
                1. Find first output with no assigned view
                2. Set view->assigned_output
                3. All subsequent positioning/fullscreen uses that output's bounds
```

### Component Diagram

```
+------------------------------------------------------------------+
|  Target Device                                                    |
|                                                                   |
|  +-----------------+     +-------------------------------------+  |
|  | Go Backend      |     | Cage Compositor                     |  |
|  | (port 8080)     |     | (Wayland + DRM/KMS)                 |  |
|  |                 |     |                                     |  |
|  | Serves frontend |     |  Output 0 (DSI-1)                  |  |
|  | with SPA        |     |  +-------------------------------+ |  |
|  | fallback        |     |  | Cog (PID 801)                 | |  |
|  |                 |     |  | URL: http://localhost:8080/    | |  |
|  | /         -> index    |  | View: assigned to DSI-1       | |  |
|  | /tv       -> index    |  +-------------------------------+ |  |
|  | /dash     -> index    |                                     |  |
|  | /style.css -> file    |  Output 1 (HDMI-A-1)               |  |
|  +-----------------+     |  +-------------------------------+ |  |
|                          |  | Cog (PID 825)                 | |  |
|  +-----------------+     |  | URL: http://localhost:8080/tv  | |  |
|  | Strux Client    |     |  | View: assigned to HDMI-A-1    | |  |
|  | (Go)            |     |  +-------------------------------+ |  |
|  |                 |     |                                     |  |
|  | Writes display  |     |  Unconfigured Output (DP-1)        |  |
|  | map, launches   |     |  +-------------------------------+ |  |
|  | Cage, handles   |     |  | Cog (PID 840)                 | |  |
|  | dev mode        |     |  | URL: file:///.not-configured  | |  |
|  +-----------------+     |  +-------------------------------+ |  |
|                          +-------------------------------------+  |
+------------------------------------------------------------------+
```

---

## Cage Modifications (C)

### Per-View Output Mode

A new output mode `CAGE_MULTI_OUTPUT_MODE_PER_VIEW` was added to Cage. In this mode, each Wayland view (window) is confined to a single output instead of spanning the entire output layout.

**server.h**:
```c
enum cg_multi_output_mode {
    CAGE_MULTI_OUTPUT_MODE_EXTEND,    // Original: span all outputs
    CAGE_MULTI_OUTPUT_MODE_LAST,      // Original: only use last output
    CAGE_MULTI_OUTPUT_MODE_PER_VIEW,  // New: one view per output
};
```

Activated with `-m per-view` on the command line.

### View-to-Output Assignment

When a new XDG toplevel is created, Cage assigns it to the correct output using **PID-based matching**. Each `cg_output` stores the PID of the Cog process it spawned (`cog_pid`). When a Wayland client creates a toplevel, Cage reads the client's PID via `wl_client_get_credentials` and matches it against the stored `cog_pid` on each output.

This is deterministic — even if two Cog instances create their toplevels in unpredictable order, each view is matched to the exact output that spawned it.

```
Cage spawns Cog for DSI-1 (PID 766) and HDMI-A-1 (PID 764)
    |
    v
Cog PID 764 creates XDG toplevel first (race condition — order varies)
    |
    +---> wl_client_get_credentials → PID 764
    +---> find_output_by_pid(764) → HDMI-A-1 (output->cog_pid == 764)
    +---> view->assigned_output = HDMI-A-1  ✓ Correct regardless of order
    |
Cog PID 766 creates XDG toplevel second
    |
    +---> wl_client_get_credentials → PID 766
    +---> find_output_by_pid(766) → DSI-1 (output->cog_pid == 766)
    +---> view->assigned_output = DSI-1  ✓ Correct regardless of order
```

#### Why PID Matching Is Necessary

An earlier approach used "first unoccupied output" assignment, which relied on Cog instances creating their toplevels in a specific order. This was a race condition: Cage spawns both Cog processes within milliseconds, each has a `sleep(1)` for resolution settling, and the order they wake up and connect to Wayland is non-deterministic. On real hardware, this caused views to appear on the wrong monitors ~50% of the time.

PID matching eliminates the race entirely. The `fork()` → `exec(strux-run-cog.sh)` → `exec(cog)` chain preserves the PID, so the Cog process that connects to Wayland has the same PID that Cage stored when it forked.

#### Implementation

**xdg_shell.c — handle_new_xdg_toplevel()**:
```c
// Get client PID for output assignment
pid_t client_pid = 0;
struct wl_client *client = wl_resource_get_client(toplevel->base->resource);
if (client) {
    wl_client_get_credentials(client, &client_pid, NULL, NULL);
}
view_assign_output(&xdg_shell_view->view, client_pid);
```

**view.c — assign_next_output(server, client_pid)**:
```c
// 1. Try PID match first (deterministic)
struct cg_output *output;
wl_list_for_each(output, &server->outputs, link) {
    if (output->cog_pid == client_pid) return output;
}

// 2. Fallback: first unoccupied output (for non-display-map scenarios)
wl_list_for_each(output, &server->outputs, link) {
    if (!output_has_view(server, output)) return output;
}

// 3. Last resort: first output
return wl_container_of(server->outputs.next, output, link);
```

The fallback chain ensures compatibility: PID matching handles display-map spawned Cogs, "first unoccupied" handles manually launched clients, and "first output" prevents crashes if all outputs are occupied.

### View Positioning

`view_position()` was modified to constrain views to their assigned output's bounding box:

```c
void view_position(struct cg_view *view) {
    struct wlr_box layout_box;
    if (view->assigned_output) {
        // Per-view: use only this output's bounds
        wlr_output_layout_get_box(layout, view->assigned_output->wlr_output, &layout_box);
    } else {
        // Default: full layout (all outputs combined)
        wlr_output_layout_get_box(layout, NULL, &layout_box);
    }
    view_maximize(view, &layout_box);
}
```

The fullscreen request handler (`xdg_shell.c`) also respects `assigned_output`.

### Cog Spawning

When a display map is provided, Cage spawns Cog instances directly:

```
handle_new_output()
    |
    +---> spawn_cog_for_output()
              |
              +---> display_map_lookup(output_name) -> URL
              +---> display_map_lookup(output_name.resolution) -> WxH
              +---> fork()
              |       |
              |       Child:
              |         1. wlr-randr --output <name> --mode <WxH>
              |         2. sleep 0.5s (resolution settle)
              |         3. exec /strux/strux-run-cog.sh <output_name> <url>
              |         4. (fallback: direct cog exec if script missing)
              |
              +---> Store child PID in output->cog_pid
```

On disconnect:

```
output_destroy()
    |
    +---> kill_cog_for_output()
    |         kill(output->cog_pid, SIGTERM)
    |         waitpid(output->cog_pid)
    |
    +---> Clear assigned_output on orphaned views
    +---> view_position_all() (reposition remaining views)
```

### CLI Arguments

```
cage [-m extend|last|per-view]
     [--display-map=PATH]        Output name -> URL mapping file
     [--input-map=PATH]          Input device -> output mapping file
     [--splash-image=PATH]       Boot splash PNG
     [-d] [-D] [-s] [-v]        (existing flags)
```

---

## Display Map File

Written by the Go client at `/tmp/strux-display-map`. Read by Cage via `--display-map`.

### Format

```
output_name=url
output_name.resolution=WIDTHxHEIGHT
```

### Example

```
DSI-1=http://localhost:8080/
DSI-1.resolution=1920x1080
HDMI-A-1=http://localhost:8080/tv
HDMI-A-1.resolution=1280x720
```

Outputs not found in this file receive the fallback URL: `file:///strux/.not-configured.html`

---

## Input Device Mapping

Touchscreens and pointer devices need to be mapped to the correct output. Without mapping, touch events on one screen could register on another.

### The Problem

Input devices are often registered before outputs exist (the DRM backend discovers connectors after seat initialization). Additionally, many embedded touchscreens don't report an `output_name` hint.

### Solution

1. **Input map file** (`/strux/.input-map`): Maps device name substrings to output names.

   ```
   ILITEK:DSI-1
   FT5x06:DSI-1
   ```

   When a device named "ILITEK ILITEK-TP" connects, the substring "ILITEK" matches, and the device is mapped to DSI-1.

2. **Deferred re-mapping**: `seat_remap_input_devices()` is called from `handle_new_output()` each time a new output appears. This re-attempts mapping for all touch/pointer devices that may have failed earlier.

3. **Fallback**: In per-view mode, unmapped devices default to the first output (typically the built-in display).

### Lookup Flow

```
Input device connects (handle_new_touch / handle_new_pointer)
    |
    +---> map_input_device_to_output(device, device->output_name)
              |
              +---> output_name is NULL?
              |       |
              |       Yes: lookup_input_map(input_map_path, device->name)
              |             Substring match device name against patterns
              |             Returns target output name (or NULL)
              |
              +---> target output name is NULL?
              |       |
              |       Yes (per-view mode): Map to first output
              |       Yes (other modes): Log warning, no mapping
              |
              +---> Find output by name in server->outputs
              +---> wlr_cursor_map_input_to_output()
```

---

## User-Modifiable Cog Launcher

### `/strux/strux-run-cog.sh`

This script is called by Cage to launch each Cog instance. It lives in `dist/artifacts/scripts/` and is written once on first build — after that, the user can modify it freely.

```bash
#!/bin/sh
#
# Arguments:
#   $1 - Output name (e.g., "HDMI-A-1", "DSI-1")
#   $2 - URL to load (e.g., "http://localhost:8080/dashboard")
#
# Environment:
#   All Cage environment variables are inherited (WAYLAND_DISPLAY, etc.)
#

OUTPUT_NAME="$1"
URL="$2"

exec cog \
  --web-extensions-dir=/usr/lib/wpe-web-extensions \
  --platform=wl \
  --enable-developer-extras=1 \
  "$URL"
```

#### Customization Examples

**Add per-output Cog flags:**
```bash
if [ "$OUTPUT_NAME" = "HDMI-A-1" ]; then
  exec cog --platform=wl --scale=2 "$URL"
else
  exec cog --platform=wl "$URL"
fi
```

**Set per-output environment variables:**
```bash
if [ "$OUTPUT_NAME" = "DSI-1" ]; then
  export WEBKIT_INSPECTOR_HTTP_SERVER="0.0.0.0:9223"
fi
exec cog --platform=wl "$URL"
```

**Replace Cog with another browser:**
```bash
exec chromium --kiosk --ozone-platform=wayland "$URL"
```

---

## SPA Routing Support

The Go backend serves the frontend with SPA (Single Page Application) fallback routing. This is critical for multi-monitor: when Cog loads `http://localhost:8080/dashboard`, the server must return `index.html` so the client-side router handles the route.

**pkg/runtime/server.go**:
```go
type spaHandler struct {
    staticDir  string
    fileServer http.Handler
}

func (h *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    path := filepath.Join(h.staticDir, filepath.Clean(r.URL.Path))

    // File exists? Serve it directly.
    info, err := os.Stat(path)
    if err == nil && !info.IsDir() {
        h.fileServer.ServeHTTP(w, r)
        return
    }

    // Directory with index.html? Serve it.
    if err == nil && info.IsDir() {
        if _, err := os.Stat(filepath.Join(path, "index.html")); err == nil {
            h.fileServer.ServeHTTP(w, r)
            return
        }
    }

    // Fallback: serve index.html for client-side routing
    http.ServeFile(w, r, filepath.Join(h.staticDir, "index.html"))
}
```

This means:
- `/style.css` → serves `./frontend/style.css` (actual file)
- `/tv` → serves `./frontend/index.html` (SPA route, handled by Vue/React router)
- `/dashboard` → serves `./frontend/index.html` (SPA route)

---

## QEMU Multi-Monitor

For development and testing, QEMU can expose multiple virtual outputs. The `strux run` / `strux dev` commands configure QEMU automatically based on the display config.

**run/index.ts**:
```typescript
const monitors = Settings.main?.display?.monitors
const monitorCount = monitors?.length ?? 1

// Video kernel args — one per virtual monitor
if (monitors && monitors.length > 1) {
    monitors.forEach((monitor, index) => {
        const resolution = monitor.resolution ?? defaultResolution
        videoArgs.push(`video=Virtual-${index + 1}:${resolution}@60`)
    })
}

// GPU device with max_outputs
const maxOutputsSuffix = monitorCount > 1 ? `,max_outputs=${monitorCount}` : ""
gpuDevice = `virtio-vga-gl,...${maxOutputsSuffix}`

// GTK display for multi-monitor (SDL only supports single window)
displayOpt = monitorCount > 1 ? "gtk,gl=on" : "sdl,gl=on"
```

Virtual outputs are named `Virtual-1`, `Virtual-2`, etc. Include these in your monitor `names` arrays so the same config works in both QEMU and on real hardware.

---

## Hotplug Events

Cage writes output connect/disconnect events to a FIFO at `/tmp/strux-output-events`. This is available for external tools or scripts that need to react to display changes.

### Format

```
CONNECTED:<output_name>
DISCONNECTED:<output_name>
```

### Example

```
CONNECTED:HDMI-A-1
DISCONNECTED:HDMI-A-1
CONNECTED:HDMI-A-1
```

The FIFO is opened non-blocking by Cage, so events are silently dropped if no reader is connected. This is informational — Cage handles Cog lifecycle internally and does not depend on an external reader.

---

## File Reference

### Build-Time Files (in `dist/`)

| File | Source | Description |
|------|--------|-------------|
| `dist/cache/{bsp}/.display-config.json` | `writeDisplayConfig()` | Monitor configs as JSON |
| `dist/cache/{bsp}/.input-map` | `writeDisplayConfig()` | Device-to-output mappings |
| `dist/artifacts/scripts/strux-run-cog.sh` | Embedded asset | User-modifiable Cog launcher |
| `dist/artifacts/not-configured.html` | Embedded asset | Fallback page for unconfigured outputs |

### Runtime Files (on rootfs)

| File | Description |
|------|-------------|
| `/strux/.display-config.json` | Display config read by Go client |
| `/strux/.input-map` | Input device mappings passed to Cage |
| `/strux/strux-run-cog.sh` | Cog launcher script called by Cage |
| `/strux/.not-configured.html` | Shown on outputs with no config entry |
| `/tmp/strux-display-map` | Runtime display map written by Go client, read by Cage |
| `/tmp/strux-output-events` | FIFO for hotplug event notifications |

### Source Files Modified

| File | Changes |
|------|---------|
| `src/assets/cage-base/server.h` | Added `PER_VIEW` mode, `display_map_path`, `input_map_path`, `output_event_fd` |
| `src/assets/cage-base/output.h` | Added `cog_pid` to `cg_output` |
| `src/assets/cage-base/view.h` | Added `assigned_output` to `cg_view` |
| `src/assets/cage-base/cage.c` | Added `--display-map`, `--input-map` CLI parsing; FIFO notification; cleanup |
| `src/assets/cage-base/output.c` | Display map lookup, Cog spawn/kill, hotplug management |
| `src/assets/cage-base/view.c` | First-unoccupied output assignment in `view_init()` |
| `src/assets/cage-base/xdg_shell.c` | Fullscreen respects `assigned_output` |
| `src/assets/cage-base/seat.c` | Input map lookup, deferred re-mapping on output connect |
| `src/assets/client-base/cage.go` | Display map writing, `--display-map` arg, removed shell command generation |
| `src/assets/client-base/config.go` | `DisplayConfig`, `DisplayMonitor` types |
| `src/assets/client-base/main.go` | `loadDisplaySettings()`, passes config to launcher |
| `src/types/main-yaml.ts` | `DisplayMonitorSchema` with `input_devices` field |
| `src/commands/build/steps.ts` | `writeDisplayConfig()` for JSON + input map |
| `src/commands/build/cache-deps.ts` | `display` key in rootfs-post cache deps |
| `src/commands/build/artifacts.ts` | Embeds `strux-run-cog.sh` and `not-configured.html` |
| `src/commands/build/index.ts` | Calls `writeDisplayConfig()` before rootfs-post |
| `src/commands/run/index.ts` | QEMU multi-monitor args (already existed) |
| `src/assets/scripts-base/strux-build-post.sh` | Copies display config, input map, scripts to rootfs |
| `pkg/runtime/server.go` | SPA fallback routing for multi-path support |

---

## Cache Invalidation

Changes to the `display` section in `strux.yaml` automatically invalidate the `rootfs-post` build step cache, triggering a rebuild that includes the updated display config. This is configured in `cache-deps.ts`:

```typescript
"rootfs-post": {
    yamlKeys: [
        // ... other keys
        { file: "strux.yaml", keyPath: "display" }
    ],
}
```
