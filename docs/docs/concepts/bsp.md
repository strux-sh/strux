# Board Support Packages

A Board Support Package (BSP) is a folder in your project that teaches Strux how to build for one specific piece of hardware. Your app code stays the same across boards; the BSP supplies everything hardware-specific. This page explains what a BSP owns and how your project uses one — if you want to *write* a BSP for a new board, start with the [BSP Development guide](/bsp/guide/introduction.html).

## The mental model

Think of the [build pipeline](/concepts/build-pipeline.html) as a machine with empty slots: which CPU architecture? which kernel? which bootloader? how does the final disk image get assembled? A BSP is the set of answers for one board, packaged as a directory under `bsp/`:

```txt
my-kiosk/
├── strux.yaml
├── main.go
├── frontend/
└── bsp/
    ├── qemu/             # ships with every project — local testing
    │   ├── bsp.yaml
    │   └── scripts/
    └── hd215-rk3576/     # added for real hardware
        ├── bsp.yaml
        ├── scripts/      # lifecycle + make_image + flash scripts
        ├── dts/          # device tree sources
        ├── patches/      # kernel / bootloader patches
        ├── blobs/        # vendor firmware binaries
        ├── overlay/      # files copied into the OS filesystem
        └── runtime/      # Go runtime extensions
```

Everything is driven by the `bsp.yaml` at the root of the folder, validated against a strict schema (see the [bsp.yaml reference](/bsp/reference/bsp-yaml.html)).

## What a BSP owns

| Area | `bsp.yaml` keys | What it means for your app |
|------|-----------------|----------------------------|
| Architecture | `bsp.arch` | Everything is cross-compiled for this CPU: your Go backend, Cage, Cog, the client. `arm64`, `x86_64`, `armhf`, or `host`. |
| Kernel | `bsp.boot.kernel` | Stock Debian kernel, or a custom one with its own source, defconfig, fragments, patches, and device tree. |
| Bootloader | `bsp.boot.bootloader` | Whether one is built at all, which one (U-Boot, GRUB...), and the vendor firmware blobs early boot needs. |
| Build scripts | `bsp.scripts` | Shell scripts hooked into [pipeline lifecycle steps](/bsp/concepts/lifecycle-scripts.html) — including the mandatory `make_image` step that produces the bootable image, and `flash_script` used by `strux flash`. |
| Packages & overlay | `bsp.rootfs` | Board-specific Debian packages (Wi-Fi firmware, ALSA, Bluetooth...) and files overlaid onto the filesystem. Your project's own `rootfs` section in `strux.yaml` is applied on top. |
| Runtime extensions | `bsp.runtime.extensions` | Go packages compiled into your backend that add board-specific APIs (e.g. Wi-Fi management on a board that has Wi-Fi). Your frontend sees them as part of the same typed `strux` API. See [Runtime Extensions](/bsp/guide/runtime-extensions.html). |
| Display & compositor | `bsp.display`, `bsp.cage` | The panel's native resolution, compositor environment variables, and cursor hiding. See [Display Stack](/concepts/display-stack.html). |
| Defaults | `bsp.hostname` | Device hostname (your `strux.yaml` can override it). |

A BSP also declares which Strux API versions it has been tested with (`bsp.runtime.compatible_strux_api`); the CLI checks this against your project's runtime version at build time and refuses mismatches with a clear error.

## How a project selects a BSP

One line in `strux.yaml`:

```yaml
bsp: qemu
```

The name must match a folder under `bsp/` containing a `bsp.yaml`. Commands that take a BSP argument can override this per invocation, which is how you build for hardware without editing config:

```bash
strux build              # uses the bsp: key → qemu
strux build hd215-rk3576 # builds for the hardware board instead
```

## Per-BSP build folders

Each BSP gets its own cache and output directories:

```txt
dist/cache/hd215-rk3576/   # compiled binaries, kernel, rootfs tarballs, .build-cache.json
dist/output/hd215-rk3576/  # the bootable image
dist/cache/qemu/
dist/output/qemu/
```

Nothing is shared between boards except the built frontend (`dist/cache/frontend/`), which is plain files and architecture-independent. The practical upshot: switching boards never invalidates anything, and you can keep a fast QEMU loop going while hardware images build on the side. See [Caching](/concepts/caching.html).

## Why the qemu BSP must stay

Every project scaffolded by `strux init` includes a `bsp/qemu/` — a virtual "board" targeting the QEMU emulator. It's what makes `strux dev` and `strux run` work on your laptop: no custom kernel, no bootloader, just a minimal `make_image` script that produces a `rootfs.ext4` QEMU can boot.

::: warning Keep the qemu BSP
Don't delete `bsp/qemu/`, even after you've moved to real hardware. It's your fastest dev loop and your control case when debugging — if something works in QEMU but not on the board, you've narrowed the problem to the hardware BSP.
:::

## Real-world examples

The differences between BSPs show what the abstraction carries:

- **`qemu`** — `arch: arm64`, `custom_kernel: false`, `bootloader.enabled: false`. One script on `make_image`. The whole BSP is a single YAML file and one shell script.
- **`hd215-rk3576`** (a Rockchip RK3576 panel PC) — custom kernel from the Armbian Rockchip tree with board patches and a custom device tree; U-Boot with Rockchip DDR/BL31/OP-TEE firmware blobs; `hide_cursor: true` for a touch-only display; runtime extensions for network and Wi-Fi APIs; a long list of firmware and audio packages.
- **`hd215-rk3288`** — same product family, older SoC: `arch: armhf` and different compositor environment tweaks, with the same project code on top.

We're constantly working to add new boards and to support new BSPs, and you're always welcome to create your own BSPs and host them on GitHub. In the future, we are going to have a website / bsp manager to keep track of BSPs and to allow you to publish your own BSPs and obtain new versions of existing ones.

## Where to go next

- [Writing a BSP](/bsp/guide/writing-a-bsp.html) — build support for a new board, step by step.
- [bsp.yaml reference](/bsp/reference/bsp-yaml.html) — every key, exhaustively.
- [Lifecycle Scripts](/bsp/concepts/lifecycle-scripts.html) — how BSP scripts hook into the build.
- [Flashing](/guide/flashing.html) — getting a built image onto the board.
