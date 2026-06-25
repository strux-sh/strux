# BSP Development

This track is for developers bringing Strux up on new hardware — taking a board that ships with a vendor Linux image (or nothing at all) and turning it into a supported Strux target. If you've never done embedded board bring-up before, start here: each page explains the embedded concepts as you meet them.

## What is a BSP?

A **Board Support Package (BSP)** is a folder in a Strux project that tells the build pipeline everything device-specific about one hardware target: which CPU architecture to compile for, which kernel and bootloader to build, which firmware files the board needs, which Debian packages to install, and how to assemble the final disk image.

Everything that is *not* board-specific — your frontend, your Go backend, the Cage compositor, WPE WebKit, the Debian root filesystem — is built by Strux the same way for every board. The BSP supplies the rest.

::: tip New to these terms?
The **kernel** is the core of Linux — it talks to the hardware. The **bootloader** is the small program that runs first when the board powers on and loads the kernel. The **root filesystem (rootfs)** is everything else: the `/usr`, `/etc`, `/home` tree your OS runs from. These docs explain each one in depth when you get to it.
:::

A project can hold any number of BSPs side by side, one folder each under `bsp/`. The `bsp` field in `strux.yaml` selects the default, and `strux build <bsp>` builds a specific one. Every project starts with a `qemu` BSP for local development; you add hardware BSPs next to it.

## What's in a BSP folder

The only required file is `bsp.yaml`. Everything else is convention — but it's a useful convention, shared by all the example BSPs. Here is the layout of `hd215-rk3576`, a real BSP for a Rockchip RK3576 board:

```txt
bsp/hd215-rk3576/
├── bsp.yaml          # The BSP configuration — the only required file
├── scripts/          # Lifecycle scripts (custom bootloader build, image creation, flashing)
├── boot/             # Boot configuration templates (extlinux.conf, U-Boot boot script)
├── configs/          # Saved kernel configuration (kernel.config)
├── dts/              # Device tree sources for the kernel and bootloader
├── patches/          # Kernel and U-Boot patches
├── blobs/            # Vendor firmware binaries (DDR init, ARM Trusted Firmware, TEE)
├── image/            # genimage partition layout configs
├── overlay/          # Files copied verbatim into the root filesystem
└── runtime/          # Go runtime extensions (board-specific backend APIs)
```

A minimal BSP — like the `qemu` one — is just `bsp.yaml` plus a single `scripts/make-image.sh`.

## The bsp.yaml file

The file has two top-level keys: `strux_version` (the Strux version the BSP was written against) and `bsp`, which holds the actual configuration:

```yaml
strux_version: 0.3.0
bsp:
  name: hd215-rk3576
  description: "Medeiros IT HD215 RK3576 Board"
  arch: arm64
  hostname: hd215
  display:
    resolution: 1920x1080
  cage:
    hide_cursor: true
    env:
      - WLR_DRM_NO_MODIFIERS=1
  scripts: []        # Lifecycle scripts (see below)
  boot:
    bootloader: { enabled: false }
    kernel: { custom_kernel: false }
  rootfs:
    overlay: ./overlay
    packages: [curl, wget]
  runtime:
    extensions: []
```

What each section does:

| Key | Required | Description |
|---|---|---|
| `name` | yes | BSP identifier. Should match the folder name. |
| `description` | yes | Human-readable description. |
| `arch` | yes | Target CPU architecture: `host`, `arm64` (or `aarch64`), `x86_64` (or `amd64`), or `armhf` (also `armv7`/`arm`). Controls the cross-compiler for every build step. |
| `hostname` | yes | The device's network hostname. |
| `display` | no | `resolution: "WIDTHxHEIGHT"` — the panel's native mode. Exposed to BSP scripts as `DISPLAY_WIDTH`/`DISPLAY_HEIGHT`. |
| `cage` | no | Compositor tuning: `env` (a list of `NAME=value` strings written to the device's cage environment file) and `hide_cursor` (sets `STRUX_HIDE_CURSOR=1` for touch-only devices). |
| `scripts` | no | Lifecycle scripts that hook into (or replace) build steps. See [Lifecycle Scripts](/bsp/concepts/lifecycle-scripts.md). |
| `boot.kernel` | no | Custom kernel configuration. `custom_kernel: false` uses the stock Debian kernel from the rootfs. See [Custom Kernels](/bsp/guide/kernel.md). |
| `boot.bootloader` | no | Bootloader configuration. `enabled: false` means no bootloader is built (fine for QEMU). See [Bootloaders](/bsp/guide/bootloader.md). |
| `rootfs` | no | `overlay` (a folder copied verbatim into the root filesystem) and `packages` (extra Debian packages to install). |
| `runtime` | no | `extensions` (board-specific Go APIs added to the Strux runtime) and `compatible_strux_api` (the Strux API versions this BSP has been tested with). See [Runtime Extensions](/bsp/guide/runtime-extensions.md). |

The full key-by-key reference, with every field and type, is at [bsp.yaml Reference](/bsp/reference/bsp-yaml.md).

::: tip A note on `cage.env`
The values in the `qemu` BSP — `WLR_DRM_NO_MODIFIERS=1`, `WLR_NO_HARDWARE_CURSORS=1` — are wlroots display-stack workarounds that real boards often need too. The `ht109-rk3576s` tablet BSP uses `STRUX_OUTPUT_TRANSFORM=90` here to rotate a portrait panel into landscape. See [Display Stack](/concepts/display-stack.md).
:::

## How a BSP plugs into the build pipeline

`strux build <bsp>` runs a fixed sequence of steps inside the `strux-builder` Docker container: frontend → application → cage → wpe → client → kernel → bootloader → rootfs → final image. The BSP shapes this pipeline in three ways:

1. **Configuration.** `arch` selects the cross-compiler; `rootfs.packages` and `rootfs.overlay` feed the rootfs steps; `boot.kernel` and `boot.bootloader` configure their steps.
2. **Conditional steps.** The kernel step only runs when `boot.kernel.custom_kernel: true`, and the bootloader step only runs when `boot.bootloader.enabled: true`. A QEMU-only BSP skips both.
3. **Lifecycle scripts.** Every entry in `scripts` declares a `location` and a `step` — a hook like `before_rootfs`, `after_bootloader`, or `make_image`. Strux runs the script inside Docker at that point in the pipeline, with environment variables describing the build (`BSP_NAME`, `TARGET_ARCH`, `PROJECT_DIST_CACHE_FOLDER`, and more — see [Environment Variables](/bsp/reference/environment-variables.md)). Three special steps *replace* built-in behavior instead of hooking around it: `custom_kernel`, `custom_bootloader`, and `make_image`.

The `make_image` step deserves emphasis: **Strux builds a root filesystem tarball, but the BSP turns it into a bootable disk image.** Only the BSP knows the board's partition layout, where the bootloader lives, and what the flashing tool expects. Every BSP needs at least one `make_image` script.

Scripts participate in the [build cache](/concepts/caching.md): declare `cached_generated_artifacts` and `depends_on` on a script, and Strux skips it when its outputs exist and no dependency has changed. The path shorthand (`cache/` → `dist/cache/{bsp}/`, `output/` → `dist/output/{bsp}/`, `./` → the BSP folder) is documented in [Path Resolution](/bsp/reference/path-resolution.md).

## The recommended path

Don't write a BSP from a blank file. The path that works:

1. **Start from the qemu BSP.** Copy `bsp/qemu/` to `bsp/<your-board>/`, rename it, and get `strux build <your-board>` producing an image with no custom kernel and no bootloader. This proves the pipeline, your packages, and your overlay before any hardware is involved.
2. **Add the kernel.** Switch on `custom_kernel`, point `source` at the kernel tree your board needs (often a vendor fork), and get it compiling with the right device tree. See [Custom Kernels](/bsp/guide/kernel.md).
3. **Add the bootloader.** Enable the bootloader, supply the defconfig, patches, and any vendor boot blobs. See [Bootloaders](/bsp/guide/bootloader.md).
4. **Make it flashable.** Write the `make_image` script for the board's partition layout, then a `flash_script` so `strux flash` works. See [Flash Scripts](/bsp/guide/flash-scripts.md).

The [Writing a BSP](/bsp/guide/writing-a-bsp.md) guide walks this exact path with real values.

## Where to go next

- [Writing a BSP](/bsp/guide/writing-a-bsp.md) — the from-scratch walkthrough.
- [Custom Kernels](/bsp/guide/kernel.md) — sources, defconfigs, fragments, patches, device trees.
- [Bootloaders](/bsp/guide/bootloader.md) — U-Boot builds, boot methods, vendor blobs.
- [Lifecycle Scripts](/bsp/concepts/lifecycle-scripts.md) — every hook, in pipeline order.
- [Runtime Extensions](/bsp/guide/runtime-extensions.md) — exposing board hardware (WiFi, sensors) to the app.
- [Example BSPs](/bsp/guide/examples.md) — the real BSPs these docs draw from.
- [bsp.yaml Reference](/bsp/reference/bsp-yaml.md) — every key, exhaustively.
