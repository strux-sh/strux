# Strux Project Agent Guide

Use this file as project-local guidance for agents working in a Strux OS application repository.

## What Strux Is

Strux OS builds kiosk-style Linux images for single-purpose devices. A Strux project usually contains:

- A Go backend in `main.go`, exposed to the frontend through the Strux runtime.
- A frontend in `frontend/`, typically React, Vue, or vanilla JavaScript.
- A main project config in `strux.yaml`.
- One or more Board Support Packages under `bsp/<name>/`.
- Optional root filesystem overlays in `overlay/` and `bsp/<name>/overlay/`.

The build pipeline runs in Docker and assembles a minimal Linux rootfs with the app, frontend bundle, Strux client, Cage compositor, WPE WebKit/Cog browser, optional kernel and bootloader artifacts, and a BSP-specific final image.

Strux is alpha-stage software. Prefer small, explicit changes and verify by building the target BSP.

## Common Commands

- `strux init <name> --template vue --arch arm64` - create a project.
- `strux build <bsp>` - build a production image for a BSP, such as `qemu`.
- `strux build <bsp> --clean` - rebuild with the BSP cache cleared.
- `strux build <bsp> --dev` - build an image that can connect to `strux dev`.
- `strux run` - run the QEMU image. This expects a working `bsp/qemu`.
- `strux run --debug` - run QEMU with system output visible.
- `strux dev` - start local dev mode with QEMU and hot reload.
- `strux dev --remote` - serve a dev session to real hardware instead of starting QEMU.
- `strux types` - regenerate TypeScript definitions from exported Go fields and methods.
- `strux usb add` and `strux usb list` - manage QEMU USB passthrough.
- `strux kernel menuconfig --save` - edit and save kernel config for the selected BSP.
- `strux kernel clean --mode mrproper|clean|full` - clean kernel artifacts.

Project-specific package commands may also exist under `frontend/` or the repo root. Inspect `package.json`, `go.mod`, and existing scripts before adding new tooling.

## Expected Project Layout

```text
.
├── strux.yaml
├── main.go
├── go.mod
├── frontend/
├── assets/
│   └── logo.png
├── overlay/
└── bsp/
    ├── qemu/
    │   ├── bsp.yaml
    │   ├── overlay/
    │   └── scripts/
    │       └── make-image.sh
    └── <target-board>/
        ├── bsp.yaml
        ├── overlay/
        ├── scripts/
        ├── configs/
        ├── dts/
        └── patches/
```

Keep `bsp/qemu/` unless the project intentionally does not support local QEMU testing. `strux run` and normal local development depend on it.

Generated build output lives under `dist/`:

- `dist/cache/<bsp>/` - BSP-specific build cache and compiled artifacts.
- `dist/output/<bsp>/` - final image outputs.
- `dist/artifacts/` - user-editable generated artifacts such as init scripts, systemd units, Plymouth assets, client sources, Cage sources, and WPE extension sources. Changes here are preserved and can affect future builds.

Do not casually edit `dist/cache/` or `dist/output/`. For persistent customization, use configs, overlays, BSP scripts, or `dist/artifacts/` when that is the intended extension point.

## Main Config: strux.yaml

`strux.yaml` selects the active BSP and defines project-wide settings.

Important fields:

- `strux_version`: Strux version the project targets.
- `name`: project name.
- `bsp`: default BSP folder name under `bsp/`.
- `hostname`: device hostname.
- `display.monitors`: route frontend paths to display outputs and optional touch input devices.
- `boot.splash`: splash logo and background color.
- `rootfs.overlay`: global filesystem overlay copied into the image.
- `rootfs.packages`: project-wide APT package names or `.deb` paths.
- `qemu`: local testing settings, USB passthrough, and extra QEMU flags.
- `build.host_packages`: packages installed in the Docker build environment.
- `dev.server`: dev server discovery and fallback hosts.
- `dev.inspector`: WebKit inspector forwarding in dev builds.

Example display config:

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
    - path: /tv
      resolution: 1920x1080
      names:
        - HDMI-A-1
        - Virtual-2
```

Use `names` for real DRM connector names on hardware and `Virtual-*` names for QEMU. Use `input_devices` to map touch or pointer devices to a monitor by device-name substring.

## Go Runtime Rules

The Go app usually starts the Strux runtime from `main.go`.

- Public fields and methods on the app struct are exposed to the frontend.
- Run `strux types` or `strux build` after changing exported Go APIs so `frontend/src/strux.d.ts` stays aligned.
- Keep long-running device work in Go where practical, and keep frontend calls explicit.
- Use runtime events for asynchronous updates from backend to frontend.

Frontend code can hide the boot splash after it is ready:

```ts
await strux.boot.HideSplash()
```

Call this only after critical UI assets and initial state are ready.

## BSP Basics

A BSP is a target-specific folder at `bsp/<name>/`. It defines architecture, display defaults, packages, overlays, bootloader/kernel settings, and lifecycle scripts.

Minimal BSP shape:

```yaml
strux_version: 0.0.1
bsp:
  name: qemu
  description: "QEMU virtual machine for testing"
  arch: arm64
  hostname: my-device

  display:
    resolution: 1920x1080

  cage:
    env:
      - WLR_DRM_NO_MODIFIERS=1
      - WLR_NO_HARDWARE_CURSORS=1

  scripts:
    - location: ./scripts/make-image.sh
      step: make_image
      description: "Create disk image"
      cached_generated_artifacts:
        - output/rootfs.ext4
      depends_on:
        - cache/rootfs-base.tar.gz
        - cache/rootfs-post.tar.gz

  boot:
    bootloader:
      enabled: false
    kernel:
      custom_kernel: false

  rootfs:
    overlay: ./overlay
    packages:
      - curl
      - wget
```

Supported target architecture values are typically `arm64`, `x86_64`, and `armhf`.

## Creating A New BSP

When adding hardware support:

1. Copy a known-working BSP into `bsp/<new-board>/`.
2. Update `bsp.name`, `description`, `arch`, `hostname`, and `display.resolution`.
3. Keep `bsp/qemu/` intact for local testing.
4. Put board-only filesystem files in `bsp/<new-board>/overlay/`.
5. Put global app/device overlay files in project `overlay/`.
6. Add board packages under `bsp.rootfs.packages`; add project packages under `strux.yaml` `rootfs.packages`.
7. Add kernel configs under `bsp/<new-board>/configs/`, device trees under `dts/`, and patches under `patches/`.
8. Add scripts under `bsp/<new-board>/scripts/`, then register them in `bsp.yaml`.
9. Make `make_image` produce final outputs in `dist/output/<bsp>/`.
10. Build with `strux build <new-board> --clean` when validating structural changes.

Prefer BSP-local paths beginning with `./` for BSP-owned files. In BSP script dependencies, `./foo` resolves relative to `bsp/<name>/`.

## BSP Script Hooks

BSP scripts are declared in `bsp.yaml` under `bsp.scripts`. They run inside the Strux Docker build environment.

Available hook steps:

- `before_build`, `after_build`
- `before_frontend`, `after_frontend`
- `before_application`, `after_application`
- `before_cage`, `after_cage`
- `before_wpe`, `after_wpe`
- `before_client`, `after_client`
- `before_kernel`, `after_kernel_extract`, `custom_kernel`, `after_kernel`
- `before_bootloader`, `custom_bootloader`, `after_bootloader`
- `before_rootfs`, `after_rootfs`
- `before_bundle`, `make_image`
- `flash_script_tool`
- `flash_script`

Use `custom_kernel` to replace Strux's built-in kernel build. Use `custom_bootloader` to replace the built-in bootloader build. `flash_script_tool` and `flash_script` are host-side flashing workflows and are not part of the normal Docker build.

Declare cache behavior:

```yaml
scripts:
  - location: ./scripts/install-firmware.sh
    step: after_rootfs
    description: "Install board firmware"
    cached_generated_artifacts:
      - cache/firmware-installed.marker
    depends_on:
      - ./firmware/
      - ./scripts/install-firmware.sh
      - cache/rootfs-base.tar.gz
```

If `cached_generated_artifacts` is omitted, the script runs every time its hook is reached. If all cached artifacts exist and dependencies have not changed, Strux can skip the script.

Path rules for script metadata:

- `cache/foo` resolves to `dist/cache/<bsp>/foo`.
- `output/foo` resolves to `dist/output/<bsp>/foo`.
- `./foo` resolves to `bsp/<bsp>/foo`.
- Other paths resolve relative to `dist/`.

## Script Environment

BSP scripts can rely on these environment variables:

- `BSP_NAME`: selected BSP name.
- `PRESELECTED_BSP`: selected BSP name.
- `PROJECT_FOLDER`: project root.
- `PROJECT_DIST_FOLDER`: `dist/`.
- `PROJECT_DIST_CACHE_FOLDER`: `dist/cache/<bsp>/`.
- `PROJECT_DIST_OUTPUT_FOLDER`: `dist/output/<bsp>/`.
- `PROJECT_DIST_FLASH_FOLDER`: `dist/flash/<bsp>/`.
- `FLASH_DIR`: alias for `PROJECT_DIST_FLASH_FOLDER`.
- `PROJECT_DIST_ARTIFACTS_FOLDER`: `dist/artifacts/`.
- `SHARED_CACHE_DIR`: shared `dist/cache/`.
- `BSP_CACHE_DIR`: alias for the BSP cache folder.
- `HOST_ARCH`: host architecture.
- `TARGET_ARCH`: target architecture.
- `STEP`: current lifecycle step.
- `STRUX_VERSION`: active Strux version.
- `SPLASH_ENABLED`, `SPLASH_LOGO`, `SPLASH_COLOR`: splash config when set.
- `DISPLAY_WIDTH`, `DISPLAY_HEIGHT`: parsed BSP display resolution when set.

Good script practices:

- Use `#!/bin/bash` and `set -eo pipefail`.
- Add an error trap that prints the failing command and line.
- Emit progress as `STRUX_PROGRESS: message`.
- Write final image outputs under `$PROJECT_DIST_OUTPUT_FOLDER`.
- Read inputs from `$PROJECT_DIST_CACHE_FOLDER`, `$PROJECT_DIST_ARTIFACTS_FOLDER`, and `$PROJECT_FOLDER`.
- Avoid hard-coding `/project` if an environment variable exists.

## Root Filesystem Overlays

Strux applies overlays during rootfs post-processing.

- BSP overlay: `bsp.<name>.rootfs.overlay`, usually `./overlay`, resolved relative to the BSP when it starts with `./`.
- Project overlay: `strux.yaml` `rootfs.overlay`, usually `./overlay`, resolved from the project root.

Use overlays for files that must appear in the target rootfs, such as:

- `etc/systemd/system/*.service`
- `etc/ssh/sshd_config`
- `etc/udev/rules.d/*.rules`
- firmware or configuration files
- app-specific directories

The project overlay is global and should be device-agnostic when possible. BSP overlays should contain hardware-specific files.

## Packages And Host Packages

Use `rootfs.packages` for packages installed in the target OS image. Values can be repository package names or `.deb` file paths.

Use `build.host_packages` for packages needed by build scripts inside the Docker build environment.

Do not confuse host build packages with target runtime packages. For example, `dtc` needed to compile a device tree during build belongs in host packages; a runtime service dependency belongs in rootfs packages.

## Kernel And Bootloader

Use built-in kernel support when possible:

```yaml
boot:
  kernel:
    custom_kernel: true
    source: https://github.com/torvalds/linux.git
    version: 6.1
    defconfig: ./configs/kernel.config
    fragments:
      - ./configs/usb.config
      - |
        CONFIG_INPUT_EVDEV=y
    patches:
      - ./patches/fix-panel.patch
    device_tree:
      dts: ./dts/board.dts
      overlays:
        - ./dts/overlays/panel.dtso
      include_paths:
        - ./dts/includes
```

Use bootloader support when required by the board:

```yaml
boot:
  bootloader:
    enabled: true
    type: u-boot
    source: https://github.com/u-boot/u-boot.git
    version: 2025.10
    defconfig: my_board_defconfig
    fragments:
      - ./configs/u-boot.config
    patches:
      - ./patches/u-boot.patch
    device_tree:
      dts: ./dts/board-u-boot.dts
      dtsi:
        - ./dts/board-common.dtsi
      include_paths:
        - ./dts/includes
```

If the hardware requires a vendor boot flow, use `custom_kernel` or `custom_bootloader` scripts and document the expected outputs in `cached_generated_artifacts`.

## Image Creation

The `make_image` script is responsible for producing bootable artifacts for the BSP.

For QEMU, a common pattern is:

- Extract `$PROJECT_DIST_CACHE_FOLDER/rootfs-post.tar.gz`.
- Copy `$PROJECT_DIST_CACHE_FOLDER/vmlinuz` and `initrd.img` to `$PROJECT_DIST_OUTPUT_FOLDER`.
- Create `$PROJECT_DIST_OUTPUT_FOLDER/rootfs.ext4`.
- Format and populate the ext4 image.

For physical boards, `make_image` may need to:

- Create a partitioned disk image.
- Install a bootloader at board-specific offsets.
- Copy firmware blobs.
- Create boot and rootfs partitions.
- Write `extlinux.conf`, U-Boot scripts, GRUB config, or board vendor files.

Keep board-specific image logic inside the BSP, not in app code.

## Development And Debugging

- Start with `strux build qemu --clean` to prove the app builds locally.
- Use `strux run --debug` when the VM boots but the UI does not appear.
- Use `strux dev --debug --vite` when debugging hot reload or frontend issues.
- Use `strux dev --remote` with a `--dev` image for physical hardware iteration.
- Configure `dev.server.fallback_hosts` with the development machine IP when mDNS is unreliable.
- Enable `dev.inspector.enabled` to forward WebKit inspector ports in dev mode.
- For multi-display setups, verify DRM connector names on real hardware and keep QEMU `Virtual-*` fallbacks.

## Agent Working Rules

- Read `strux.yaml` and the target `bsp/<name>/bsp.yaml` before changing build or device behavior.
- Preserve `bsp/qemu/` unless explicitly asked to remove QEMU support.
- Keep BSP-specific changes in the BSP folder.
- Keep app-wide runtime files in project-level config, `main.go`, `frontend/`, or `overlay/`.
- Prefer declarative YAML, overlays, and BSP scripts over editing generated caches.
- Use `cached_generated_artifacts` and `depends_on` for expensive or stateful BSP scripts.
- Do not modify generated files in `dist/cache/` or `dist/output/` as a durable fix.
- After changing exported Go APIs, regenerate or verify TypeScript types.
- After changing BSP structure, run or recommend `strux build <bsp> --clean`.
- After changing frontend or Go app behavior, run the fastest relevant frontend, Go, or Strux check available in the project.
- Document hardware assumptions in `bsp/<name>/README.md` when adding a new board.
