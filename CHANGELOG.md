# Changelog

## v0.2.0

### Bug Fixes

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