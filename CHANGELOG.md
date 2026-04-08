# Changelog

## v0.3.0

### Minor Changes

- Added `host` as a BSP architecture option. When `arch: host` is set in `bsp.yaml`, the build targets the host machine's native architecture instead of a hardcoded value. New projects created with `strux init` now default to `arch: host` instead of baking in the specific host architecture at init time.
- Local builds (`bun run build`) now read the version from `package.json` instead of falling back to `0.0.1`. CI builds are unaffected — the `--define` flag still takes precedence.
- Cog browser is now compiled from source during the build process. The Debian-packaged Cog 0.18.5 lacks support for configuring the WebKit autoplay policy, which was added in Cog 0.19.1 (not available in any Debian repository). The build now clones Cog 0.18.5 from source, applies a backported patch that adds the `--autoplay-policy` CLI flag, and cross-compiles it alongside the WPE extension. The patched binary is installed over the Debian package version. The Cog launch script (`strux-run-cog.sh`) now passes `--autoplay-policy=allow`, permitting unmuted media autoplay without requiring a user gesture.

## v0.2.2

### Minor Changes

- New projects now include a default single-monitor display configuration in `strux.yaml` with `Virtual-1` output name. Previously the display block was entirely commented out, requiring manual setup.

## v0.2.1

### Bug Fixes

- Fixed nested struct field getters returning `undefined`. The WPE extension's `bind_children` function was passing the full dotted IPC path (e.g., `Settings.Audio.AudioOutput`) as both the `Object.defineProperty` key and the `__getField` IPC path. JavaScript treated the dotted string as a literal property name, so `App.Settings.Audio.AudioOutput` was `undefined` while `App.Settings.Audio["Settings.Audio.AudioOutput"]` held the getter. Split `inject_field_property` into `inject_field_property_with_path` which accepts separate arguments for the JS property name (short, e.g., `AudioOutput`) and the IPC field path (full, e.g., `Settings.Audio.AudioOutput`). The original `inject_field_property` is now a convenience wrapper for top-level fields where both names are the same.
- Fixed device client giving up on dev server reconnection after 5 failed attempts. The WebSocket client now retries indefinitely with exponential backoff (2s → 4s → 8s → 16s → 30s cap) instead of stopping after `maxReconnectTry` attempts. On successful reconnection, the client re-requests the current binary from the dev server so log streams and binary state are re-established.
- Fixed `Stream has outstanding operation` error on the event socket after page reload or navigation. When a page reloads, the WPE extension closes the old event socket and opens a new one. However, the old async read callback could still fire after the new connection was established. If it did, it would call `start_event_read_loop()` which started a second concurrent read on the new stream — GLib rejects this with "outstanding operation", killing the event socket. The fix checks whether the callback's source stream matches the current `event_data_input`; stale callbacks from old connections are silently discarded.
- Fixed async method calls hanging when Go methods return no result and no error. When a Go method returns `(nil, nil)`, both `result` and `error` fields are omitted from the JSON response due to `omitempty`. The WPE extension's `async_read_callback` only resolved or rejected the promise when it found one of those keys — if neither was present, the promise was never settled. Added a fallback that resolves with `undefined` when the response contains neither `result` nor `error`.
- Fixed array and object arguments being silently dropped when calling Go methods from JavaScript. The WPE extension's `js_call_go_method` only handled string, number, and boolean argument types — arrays and objects fell through to `null`. Additionally, the Go registry's `ExecuteMethod` could not convert `[]interface{}` (from JSON unmarshaling) to typed slices like `[]string`. Fixed both sides: the extension now serializes arrays/objects via `JSON.stringify` into the IPC message, and the registry now handles `[]interface{}` → `[]T` slice conversion via reflection.

### Minor Improvements

- Added `--no-chown` flag to `strux dev` and `strux build`. Skips the Docker file permission fix (`chown`) that runs after builds. Useful when iterating quickly and file ownership isn't a concern — saves a few seconds per rebuild cycle.

## v0.2.0

### New: Strux Version Checker
Strux will automatically check for new versions and notify you when a new version is available in the CLI.

### New: Bidirectional Event System (`strux.ipc`)

A new event system enables real-time, bidirectional communication between the Go backend and the JavaScript frontend — no polling, no callbacks-as-parameters, just fire-and-forget events in both directions.

**JavaScript API** (`strux.ipc`):
```javascript
// Listen for events from Go
const unsub = strux.ipc.on("download-progress", (data) => {
    updateProgressBar(data.percent);
});

// Send an event to Go
strux.ipc.send("user-action", { button: "start" });

// Remove listener (either way works)
unsub();
strux.ipc.off("download-progress", handler);
```

**Go API** (via `runtime.Init`) **NOTE: This replaces the current runtime flow**:
```go
rt, _ := runtime.Init(app)

// Listen for events from JS
rt.On("user-action", func(data interface{}) {
    fmt.Println("User did:", data)
})

// Send event to all connected frontends
rt.Emit("download-progress", map[string]int{"percent": 50})

rt.Serve() // blocks on HTTP server
```

**Architecture:**
- A dedicated third Unix socket connection ("events" channel) is established between the WPE extension and the Go runtime, separate from the existing sync and async channels
- Each socket connection now identifies itself via a handshake message (`{"type":"handshake","channel":"events"}`)
- Go→JS events are pushed over this channel and dispatched to registered JS callbacks via `g_idle_add` (thread-safe, main-loop dispatch)
- JS→Go events are sent over the same channel and dispatched to registered Go handlers in goroutines
- Event listeners are automatically cleaned up on page reload/navigation
- TypeScript type definitions are auto-generated for `strux.ipc.on()`, `strux.ipc.off()`, and `strux.ipc.send()`

**API changes:**
- `runtime.Start(app)` — unchanged, still blocks, still returns `error`. Use this if you don't need events.
- `runtime.Init(app)` — **new**, returns `(*Runtime, error)`. Use this when you need access to `Emit`/`On`/`Off`. Follow with `rt.Serve()` to start the HTTP server.
- `rt.Serve()` — **new**, starts the HTTP server (blocking). Call after `Init` and event setup.
- `rt.Emit(event, data)` — **new**, broadcasts an event to all connected JS frontends.
- `rt.On(event, handler)` — **new**, registers a Go handler for JS events. Returns a handler ID for `Off()`.
- `rt.Off(id)` — **new**, removes a handler by ID.

### New: Multi-Monitor Display Support

Strux now supports multiple independent displays, each showing a different page of your web application. Configure monitors in `strux.yaml`:

```yaml
display:
  monitors:
    - path: /
      resolution: 1920x1080
      names:
        - DSI-1
        - Virtual-1
      input_devices:
        - ILITEK
    - path: /dashboard
      resolution: 1280x720
      names:
        - HDMI-A-1
        - Virtual-2
```

**How it works:**
- Cage compositor runs in a new `per-view` mode (`-m per-view`) where each browser window is confined to a single output
- Cage reads a display map and spawns one Cog (WPE WebKit) instance per connected output, matched by output name to the configured URL
- Views are assigned to outputs using PID-based matching — deterministic regardless of process startup order
- Unconfigured outputs show a "Monitor Not Configured" fallback page
- The Go backend serves the frontend with SPA fallback routing, so paths like `/dashboard` return `index.html` for client-side routing

**Hotplug support:**
- When a monitor is disconnected, Cage kills the Cog instance for that output
- When a monitor is reconnected, Cage spawns a new Cog instance with the correct URL
- Input devices (touchscreens) are re-mapped when outputs appear

**Input device mapping:**
- The `input_devices` field maps touch/pointer devices to specific outputs using substring matching (e.g., `ILITEK` matches `ILITEK ILITEK-TP`)
- Devices are automatically re-mapped when outputs connect after input registration

**User-modifiable Cog launcher:**
- Cage calls `/strux/strux-run-cog.sh <output_name> <url>` for each output
- This script is written to `dist/artifacts/scripts/` on first build and can be customized to add Cog flags, environment variables, or swap browsers entirely

### New: Tree-Based Struct Bindings (Breaking Change)

The runtime and WPE extension now use a tree-based architecture for exposing Go structs to JavaScript. Instead of creating a separate top-level global for every struct, the binding tree mirrors your Go struct hierarchy. Only the app struct gets a `window.<StructName>` shortcut — nested structs are accessed through their parent fields.

**Before (v0.1.x):**
```javascript
const result = await window.go.main.App.Greet("Alice");
```

**Before (flat nested structs — briefly in early v0.2.0 builds):**
```javascript
// Every struct got its own global — polluted the namespace
await Audio.SetMasterVolume(80);
await Settings.GetSettings();
```

**After:**
```javascript
// App struct is the only top-level shortcut
const result = await App.Greet("Alice");
App.Title = "New Title";

// Nested structs are accessed through the field path
await App.Settings.Audio.SetMasterVolume(80);
await App.Settings.Audio.SetAudioOutputTo("HDMI");
const vol = App.Settings.Audio.MasterVolume; // field getter
```

The `window.go.main.App` path still works as an alias. The generated `strux.d.ts` includes method signatures on nested struct interfaces, so TypeScript understands the full tree.

**How it works:**
- The Go runtime builds a tree from the app struct by recursively walking struct-typed fields. Each node holds its methods, primitive fields, and children (nested struct fields).
- The `__getBindings` IPC response includes a `children` key on each struct node, mapping field names to their child struct data. Nested structs are no longer separate top-level entries in the package.
- The WPE extension recursively processes `children`, creating nested JS objects (e.g., `App.Settings.Audio`) with methods and field getters/setters bound to dotted IPC paths.
- Methods use full field-path names for IPC dispatch (e.g., `Settings.Audio.SetMasterVolume`). Fields use dotted paths for `__getField`/`__setField` (e.g., `Settings.Audio.MasterVolume`).
- The runtime's `getField`/`setField` traverse the struct hierarchy to resolve dotted paths.

**Why this is breaking:** If you were relying on nested structs being available as top-level globals (e.g., `window.Audio`), they no longer are. Access them through the app struct's field path instead.

### New: `--local-runtime` Flag

Build and dev commands now accept `--local-runtime <path>` to use a local copy of the Strux Go runtime instead of the published GitHub module. This is useful for testing runtime changes (like the new event system) without publishing a release.

```bash
strux build qemu --local-runtime ../strux-os-bun-rewrite
strux dev --local-runtime ../strux-os-bun-rewrite
```

How it works:
- The local strux repo is mounted read-only into the Docker container at `/strux-runtime`
- Inside the container, `go mod edit -replace` injects a temporary replace directive before building
- The project's `go.mod` and `go.sum` are backed up and restored via a shell `trap EXIT`, so host files are never modified — even if the build fails or is interrupted
- Relative paths (e.g., `../`) are resolved to absolute paths before being passed to Docker

**How it works:**
- The Go runtime (`pkg/runtime`) recursively walks struct-typed fields on the app struct and discovers their exported methods via reflection, registering them alongside the app's own methods
- The introspection tool (`strux-introspect`) now collects methods on all known structs — including those defined in external packages (e.g., a `settings/` subdirectory) — and includes them in the JSON output under each struct's definition
- The `strux types` type generator produces method signatures on struct interfaces, not just fields
- The WPE extension already supports multiple struct bindings, so no C-side changes were needed

**Limitations:**
- Method names must be unique across all structs (the runtime stores them in a flat map). If two structs define a method with the same name, the last one discovered wins.
- Only methods are exposed on nested structs, not individual field getters/setters. Nested struct fields are accessible through the parent field (e.g., `App.Settings` returns the full object).

### New: Named Type Alias Resolution

The introspection tool now resolves named type aliases (e.g., `type AudioOutput string`) to their underlying primitive type instead of emitting `any`. This means Go patterns like:

```go
type AudioOutput string

const (
    AudioOutputHDMI    AudioOutput = "hdmi"
    AudioOutputSpeaker AudioOutput = "speaker"
)

func (a *Audio) SetAudioOutputTo(output AudioOutput) { ... }
```

Will generate `SetAudioOutputTo(output: string): Promise<void>` in TypeScript instead of `SetAudioOutputTo(output: any)`. This works for any `type X <primitive>` pattern across both the main package and external packages.

### New: Config Tab in Dev TUI

The `strux dev` terminal interface now includes a **Config** tab with quick actions for managing Strux components and the device, accessible via the tab bar (Left/Right arrows).

**Strux Component Management:**
- **Restore Strux Artifacts to Built-in Version** — Deletes `dist/artifacts/` and rewrites all embedded files (plymouth, init scripts, systemd services, client Go source, cage source, WPE extension source) from the CLI's built-in defaults. Useful when you want to reset user-modified artifacts back to their original state.
- **Rebuild Strux Components and Transfer To Device** — Rebuilds the Cage compositor, WPE extension, and Strux client binary inside Docker, then streams each binary to the connected device over WebSocket along with all Strux scripts (`init.sh`, `strux.sh`, `strux-network.sh`, `strux-run-cog.sh`) from `dist/artifacts/scripts/`, and reboots. This eliminates the need to reflash the entire image when iterating on Strux's own components or scripts.

**System Tools:**
- **Restart Strux Service** — Sends a `systemctl restart strux` command to the connected device.
- **Reboot System** — Sends a reboot command to the connected device.

**Device-side protocol additions:**
- New `new-component` WebSocket event streams component binaries and scripts (base64-encoded) with a target filesystem path. Supported component types: `cage`, `wpe-extension`, `client`, and `script`. The Go client writes to a temp file, verifies SHA256, and performs an atomic rename.
- New `component-ack` event for the device to acknowledge each component update.
- New `restart-service` and `reboot` events for remote system control.
- Incremental rebuilds from the Config tab (and the existing Go hot-reload path) skip per-step Docker file permission fixes and run a single `chownProjectFiles()` pass at the end.

We plan on adding additional information and tooling to this part of the terminal interface in the future.

### TUI Performance

- Reduced flicker in the dev TUI by batching rapid state updates. The store now coalesces multiple updates within the same microtask into a single React re-render, instead of clearing and redrawing the terminal for each individual log line or spinner update.
- Changed log line React keys from content-based (`${index}-${line}`) to index-based, preventing unnecessary DOM unmount/remount cycles when lines scroll.

### Optimizations

- Moved custom package installation (both repository packages and `.deb` files) from the `rootfs-base` build step to `rootfs-post`. Previously, any change to `rootfs.packages` in `strux.yaml` or `bsp.rootfs.packages` in `bsp.yaml` would invalidate the base rootfs cache, triggering a full debootstrap + system package rebuild. Packages are now installed early in the post-processing step instead, so adding or removing a package only rebuilds the much faster `rootfs-post` step. The cache dependency graph has been updated accordingly — `rootfs-base` now only depends on `bsp.arch`, while `rootfs-post` tracks both package lists.
- Skip file permission fix (`chown`) when all build steps are cached. Previously, `strux dev` and `strux build` would always spawn a Docker container at the end of the build to fix file ownership — even when every step was cached and no Docker commands actually ran. The build pipeline now tracks whether any step or BSP script executed, and only runs the `chown` pass when something actually produced files.
- Fixed WebKit Inspector port collision with multiple monitors. Previously, `WEBKIT_INSPECTOR_HTTP_SERVER` was set as an environment variable on the Cage compositor process. All Cog browser instances spawned by Cage inherited the same port, causing only the first monitor's inspector to bind successfully. The inspector port is now assigned per-Cog instance via the `strux-run-cog.sh` launcher script using an atomic counter — each Cog gets `base_port + N` (e.g., 9223, 9224, 9225). QEMU port forwarding now forwards all inspector ports automatically based on the number of configured monitors. The device also reports its IP and inspector port assignments back to the dev server via a new `device-info` WebSocket event, and the **Config** tab in the dev TUI now displays the device IP address alongside clickable inspector URLs for each monitor path.

### Bug Fixes

- Fixed `strux dev` file watcher triggering redundant rebuilds and spawning multiple Docker containers simultaneously. The chokidar watcher was not ignoring `.git/` directories, so git operations would trigger rebuilds. Additionally, rapid file saves or changes during an active build would each kick off a new build in parallel. Added `.git/` to the ignored directories, introduced a 300ms debounce to batch rapid file changes, and added a build queue that prevents concurrent builds — if changes arrive during a build, they are queued and executed after the current build finishes.
- Fixed a weird bug where `strux dev` and `strux dev --remote` was leaving orphaned Docker containers running after exit, causing runaway CPU usage and system overheating. The file watcher (chokidar) was never closed during shutdown, allowing it to trigger new Docker-based rebuilds even while cleanup was in progress. Additionally, the Vite dev server Docker container used bash as PID 1, which ignores SIGTERM — so killing the `docker run` wrapper process did not actually stop the container. The fix closes the file watcher before any other cleanup, adds a shutdown guard to prevent rebuild triggers during exit, names the Vite container (`strux-vite-dev`) so it can be explicitly stopped with `docker stop`, cleans up leftover containers from previous crashed sessions on startup, registers signal handlers before the file watcher to eliminate a race condition, and increases the exit delay to give Docker containers time to terminate.

## v0.1.3

### Bug Fixes

- Fixed rootfs overlay breaking symlinked directories on modern Debian. Debian 12+ uses merged-usr layout where `/bin`, `/lib`, and `/sbin` are symlinks to their `/usr/` counterparts (e.g., `/lib -> usr/lib`). The `rsync -a` command used to apply BSP and project rootfs overlays would replace these symlinks with real directories, breaking the rootfs and causing chroot operations to fail with `No such file or directory`. Added `--keep-dirlinks` (`-K`) flag to rsync so it follows existing destination symlinks to directories instead of replacing them.

## v0.1.2

This version solves a few bugs:

- Fixed external DTS compilation failing on ARM64 kernels. The kernel DTS preprocessor (`cpp`) and device tree compiler (`dtc`) were only given `arch/arm64/boot/dts/` as an include path, but ARM64 kernels organize DTS files into vendor subdirectories (e.g., `rockchip/`, `allwinner/`, `amlogic/`). This caused `#include "rk3576.dtsi"` and similar includes to fail with "No such file or directory". The build script now automatically discovers and adds all vendor subdirectories under `arch/arm64/boot/dts/` to the include paths. This was not an issue on ARM32 where DTS files live flat in `arch/arm/boot/dts/`.
- Fixed mDNS host discovery in the strux client connecting to fallback hosts instead of discovered hosts. The fallback hosts were added to the list before mDNS-discovered hosts, so the connection loop would always try (and succeed with) the fallback first. mDNS hosts are now prioritized over fallback hosts. Additionally, mDNS discovery now waits for the network interface to obtain an IP address before browsing, as the device's network link often comes up during the discovery window but doesn't have an IP yet, causing mDNS to find zero hosts.
- Added GStreamer plugins for video and audio playback support. The rootfs now includes `gstreamer1.0-plugins-bad` (AAC decoding, WebVTT subtitles) and `gstreamer1.0-gl` (hardware-accelerated video rendering via GL video sink). Previously, only `plugins-base` and `plugins-good` were installed, which caused video playback to fail in WPE WebKit.
- Fixed BSP rootfs overlay not being applied during the `rootfs-post` build step. The `yq` commands reading `bsp.rootfs.overlay` and `rootfs.overlay` paths from YAML config files were missing the `-r` (raw output) flag, causing the returned paths to include literal double quotes (e.g., `"./overlay"` instead of `./overlay`). This caused the overlay directory lookup to fail silently with a warning.

### Documentation
We also begin working on documentation for Strux in this version.

## v0.1.1
In this version, we made a few bug fixes:

- In the `strux dev` terminal interface, when using the Remote Terminal, CTRL+C keypresses were not being passed to the terminal. In v0.1.1, we fix this issue.
- Fixed issue #4, where changing the logo as defined in a `strux.yaml` file still uses the cached logo when it should replace it.


## v0.1.0

This is the first minor release of Strux and represents a major step forward. The build system has been significantly rearchitected with proper custom kernel and bootloader support, a new CLI command, smarter caching, and numerous hardware compatibility improvements.

### New: Custom Cage Environment Variables

BSP authors can now specify custom environment variables for the Cage Wayland compositor via `bsp.yaml`. This is useful for hardware-specific tunables like `WLR_RENDERER=vulkan`, GPU driver flags, or other wlroots/WebKit settings.

```yaml
bsp:
  cage:
    env:
      - WLR_RENDERER=vulkan
      - CUSTOM_FLAG=1
```

The env vars are written to `/strux/.cage-env` during the rootfs-post build step and loaded by the strux client at Cage launch time. Changes to `bsp.cage.env` automatically invalidate the rootfs-post cache.

### New: `strux kernel` Command

A new top-level `strux kernel` command has been added with two subcommands:

- **`strux kernel menuconfig`** — Opens an interactive kernel configuration menu (`make menuconfig`) inside Docker with full TTY support. Use `--save` to also export a minimal config fragment.
- **`strux kernel clean`** — Cleans kernel build artifacts. Supports `--mode mrproper` (default), `--mode clean`, and `--mode full`.

These commands automatically read the BSP name from `strux.yaml` and validate configuration before running.

### New: Custom Kernel Build System

The kernel build has been completely rewritten and split into two phases:

- **Extract phase** — Downloads/extracts kernel source, applies patches, and stops. This enables BSP scripts to hook in via the new `after_kernel_extract` lifecycle event.
- **Build phase** — Configures and compiles the kernel from the already-extracted source.

BSP authors can also provide a `custom_kernel` script step in `bsp.yaml` to completely replace the built-in kernel build with their own logic.

Additional kernel improvements:
- Multi-DTS support — `bsp.yaml` `device_tree.dts` now accepts an array of DTS files, not just a single string
- DTSI (include) file support — Files with `.dtsi` extension are detected and handled as includes
- Extra include path directories for DTS compilation
- Smarter patch application with dry-run detection to skip already-applied patches
- Kernel installation (both default Debian kernel and custom kernel) has been moved from `rootfs-base` to `rootfs-post`. This means kernel changes no longer trigger a full base rootfs rebuild (debootstrap + all packages), dramatically speeding up iteration when working on kernel configuration

### New: Custom Bootloader (U-Boot) Build System

The bootloader build script has been rewritten from scratch. Similar to the kernel, BSP authors can provide a `custom_bootloader` script step to replace the built-in build entirely.

- Tarball caching to avoid re-downloading U-Boot source on every build
- Multi-DTS/DTSI file support matching the kernel's new capabilities
- Two DTS modes: **standalone** (compiled externally with `dtc`, passed via `EXT_DTB`) and **standard** (copied into U-Boot tree and registered in Makefile)
- DTSI include file support with configurable include paths
- Expanded blob path resolution supporting `cache/` and `output/` prefixes
- Improved patch application with dry-run already-applied detection
- Out-of-tree build directory support via `O=`
- `BOOTLOADER_MAKE_VARS` passthrough for custom make variables
- Removed hardcoded RK3288 sanity check

### Smarter Build Caching

The caching system has been significantly enhanced:

- New `yamlFileDependencies` system that tracks individual files referenced in `bsp.yaml` (defconfig, fragments, patches, DTS files, overlays, blobs) instead of hashing entire directories
- Four tracking modes: `file`, `file-list`, `file-or-inline-list`, `file-list-in-objects`
- File removal detection — missing files now produce a stable hash instead of being silently ignored, so removing a patch or DTS file correctly invalidates the cache
- `rootfs-base` and `rootfs-post` now properly declare dependencies on `kernel` and `bootloader` steps
- Docker `chown` has been rearchitected: instead of running `chown -R` after every single build step, a new `skipChown` flag defers permission fixing to a single `chownProjectFiles()` call at the end of the pipeline. The chown itself now uses `find` to prune `.git` directories and `kernel-source` cache, avoiding extremely slow permission fixups on large source trees

### New: BSP Script Enhancements

- New `BSP_FOLDER` environment variable available in all BSP scripts (`/project/bsp/{bsp}`)
- New splash screen configuration env vars: `SPLASH_ENABLED`, `SPLASH_LOGO`, `SPLASH_COLOR`
- New display resolution env vars: `DISPLAY_WIDTH`, `DISPLAY_HEIGHT`
- New `after_kernel_extract` lifecycle hook for modifying kernel source before compilation

### New: Interactive Docker Support

The `Runner` utility now supports `runInteractiveScriptInDocker()` with full TTY passthrough (`-it`), enabling interactive tools like `menuconfig` to run inside the build container.

### Hardware & Boot Improvements

- **Automatic GPU detection** — Replaced hardcoded Intel/AMD/virtio GPU driver case statements with automatic KMS-capable GPU detection via sysfs connector entries
- **Serial console** — Changed fallback order to prefer `/dev/console` (respects the `console=` kernel parameter), then falls back to architecture-specific devices
- **Client logging** — Client output now logs to `/tmp/strux-client.log` and is tailed to the serial console alongside the backend log
- **Cage compositor** — Added `WLR_LIBINPUT_NO_DEVICES=1` to prevent errors when no input devices are present
- **Systemd service** — Removed `network-online.target` dependency so the service starts without waiting for network

### Cage Cross-Compilation Fixes

- Fixed pkg-config path resolution for cross-compilation by adding `/usr/share/pkgconfig` for arch-independent packages (xproto, xau, xdmcp, etc.)
- Created a pkg-config wrapper script that hardcodes correct paths for cross-architecture builds
- Added extensive debug logging and validation for meson cross-compilation setup
- Improved error reporting with meson log output on build failure

### Docker Builder Image

Added ~30 new packages to the builder image to support the expanded kernel and bootloader build capabilities, including: `autoconf`, `automake`, `libtool`, `ccache`, `libfdt-dev`, `libslirp-dev`, Python development packages (`python3-dev`, `python3-cryptography`, `python3-pyelftools`, etc.), `acpica-tools`, `expect`, `imagemagick`, `adb`/`fastboot`, and more.

### BSP YAML Schema Changes

- `boot.kernel.device_tree.dts` — Now accepts `string | string[]`
- New `BootloaderDeviceTreeSchema` with fields: `dts` (string or array), `dtsi`, `include_paths`, `standalone`
- New script steps added to `ScriptStepSchema`: `after_kernel_extract`, `custom_kernel`, `custom_bootloader`
- Bootloader `type` expanded from `grub | u-boot` to `grub | u-boot | systemd-boot | custom | none`
- New bootloader fields: `boot_method`, `boot_config`, `blobs` (with `BootBlobSchema`)
- New `BootBlobSchema` for firmware blobs: `id`, `role`, `path`, `required`, `sha256`, `make_var`

### Dev Mode

- **New `--no-rebuild` flag** — `strux dev --no-rebuild` skips the entire build pipeline and boots directly from an existing image. Since the Vite dev server serves the frontend live and the strux client streams the application binary on each boot, recompiling them into the rootfs is unnecessary during development. The Go application is still recompiled if source changes are detected, since the binary is streamed to the device on boot. If no previous build exists, the command exits with an error directing you to run a full build first.
- `strux dev` now skips the initial build when using `--remote` mode
- Fixed SIGINT handler to use arrow functions for proper cleanup binding

### Bug Fixes

- Fixed `strux types` not discovering methods defined in files other than `main.go`. The Go introspection tool (`strux-introspect`) was using `parser.ParseFile()` which only parsed the single specified file. Changed to `parser.ParseDir()` so all `.go` files in the same package directory are parsed, matching how Go itself compiles packages. Methods and structs defined in separate files (e.g., `handlers.go`, `routes.go`) on the App struct are now correctly included in the generated `.d.ts` types.
- Fixed `strux types` using a heuristic (first struct with methods) to determine the app struct. The introspection tool now performs AST analysis to find the struct passed to `runtime.Start()`, matching the actual runtime behavior. Supports variable references (`runtime.Start(app)` where `app := &MyKiosk{}`), inline composite literals (`runtime.Start(&App{})`), and aliased imports (`rt "github.com/strux-dev/strux/pkg/runtime"`). Falls back to `"App"` if no `runtime.Start()` call is found.
- Fixed `strux types` generating `any` for types from external packages. When methods return or accept types from other packages (e.g., `security.TorStatus`), the introspection tool now recursively resolves the full type dependency graph. It resolves import paths via `go list`, parses external package source, extracts struct definitions, and follows nested references across packages and same-package dependencies. For example, if `security.TorStatus` contains a `network.Circuit` field, which contains a `Connection` field (same package), which contains a `crypto.KeyInfo` field — all four structs are resolved with their full field definitions. Circular import chains are handled gracefully (Go wouldn't compile them anyway). The qualified Go type names are mapped to unqualified TypeScript interfaces in the generated `.d.ts`.
- Fixed `strux build <bsp>` ignoring the CLI-provided BSP name. `MainYAMLValidator.validateAndLoad()` was unconditionally overwriting `Settings.bspName` with the `bsp:` field from `strux.yaml`, causing all build steps to use the wrong BSP when the CLI argument differed from the project default.
- Fixed `rootfs-post` always rebuilding even when fully cached. The step unconditionally listed `kernel` in its upstream dependencies, but the kernel build is conditional (`custom_kernel: true`). When the kernel step was skipped, no cache entry existed for it, causing the cache check to always trigger a rebuild.
- Fixed BSP lifecycle scripts not receiving `PRESELECTED_BSP` environment variable. User-defined BSP scripts (e.g., `install-boot-config.sh`) that followed the same pattern as built-in scripts would always fall back to reading the BSP name from `strux.yaml` instead of using the CLI-selected BSP.

### Upgrade Notes

This release includes significant changes to the build pipeline. If upgrading from v0.0.x:

1. Remove the old Docker builder image to pick up the new packages:
   ```
   docker image rm strux-builder
   ```
2. Delete `dist/artifacts/scripts` and `dist/artifacts/systemd` so they get regenerated with the new versions
3. If you use a custom kernel or bootloader, review the updated `bsp.yaml` template for the new multi-DTS and phase configuration options
4. Build caches from previous versions will be automatically invalidated

---

## v0.0.19
This version contains a major overhaul:

### Major Changes
We've moved away from the testing branch, Debian Forky as there were too many issues with it. Instead, we're basing Strux on Debian 13 Trixie, the latest stable branch
that has support until 2030.

In order to take advantage of this build, you'll need to remove the old `strux-builder` docker image, as we now use Debian Trixie for building as well

```
# docker image rm strux-builder
```

### Additional Changes
- We fixed an issue where verbose mode did not output to the new `strux dev` terminal interface
- This fixes the issue related to #6, where intel 
- We now bundle the version of Cage (custom version) and our WPE extension directly into our CLI tool and have it copied over during `strux init`
- We downgraded Cage to use version 0.2.0, as Debian trixie uses wlroots 0.18, which that version of Cage is compatible with

## v0.0.18
We fixed issues with the Docker runner and shell running logic that caused the project to exit before outputting errors to the console. 
This prevented users from seeing build errors in the build process when running `strux dev`.

There was also an error in the default .gitignore in the main image, where go.sum files were excluded from git. Go.sum files should always be added.

## v0.0.17
In this version, we attempt to fix an issue (#5) where Cog doesn't launch in Strux OS. It appears that the issue is related to system proxy mode settings and dbus. 

Modifications:
- Added additional flags to `src/assets/client-base/cage.go` to change the GSettings (which in turn prevents contacting dconf/dbus) to use memory-backed mode.
- Modified `systemd` scripts `strux.service` to remove old remnants from older versions of Strux where we were using a dev watcher service
- Reverted default `inspector:` yaml flags that we changed in v0.0.16 to prevent the use of inspector when creating a new Strux project.

To use this new version of Strux, you'll need to delete `dist/artifacts/client` and `dist/artifacts/systemd` so that Strux can recreate it.
You can also safely re-enable the dev inspector.

## v0.0.16
This version of Strux disables the Strux WPE Inspector by default on new Strux projects. This prevents the issue that keeps resurging (#5).

If you haven't already on an older project, you'll need to add the following to your `strux.yaml`:

```yaml
dev:
    inspector:
        enabled: false
        port: 9223
```