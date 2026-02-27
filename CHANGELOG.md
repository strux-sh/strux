# Changelog

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

- **New `--no-rebuild` flag** — `strux dev --no-rebuild` skips the entire build pipeline and boots directly from an existing image. Since the Vite dev server serves the frontend live and the strux client streams the application binary on each boot, recompiling them into the rootfs is unnecessary during development. If no previous build exists, the command exits with an error directing you to run a full build first.
- `strux dev` now skips the initial build when using `--remote` mode
- Fixed SIGINT handler to use arrow functions for proper cleanup binding

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