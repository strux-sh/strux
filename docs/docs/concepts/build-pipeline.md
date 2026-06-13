# Build Pipeline

When you run `strux build`, the CLI executes a fixed sequence of steps, each one a shell script running inside the strux-builder Docker container. This page walks through every step: what it consumes, what it produces, and when it's skipped. For the caching logic that decides whether a step runs at all, see [Caching](/concepts/caching.html).

## The step order

```txt
before_build (BSP hook)
  1. frontend        → dist/cache/frontend/
  2. application     → dist/cache/{bsp}/app/main
  3. cage            → dist/cache/{bsp}/cage
  4. wpe             → dist/cache/{bsp}/libstrux-extension.so + cog
  5. screen          → dist/cache/{bsp}/screen
  6. client          → dist/cache/{bsp}/client
  7. kernel          → dist/cache/{bsp}/kernel/        (only if custom_kernel)
  8. bootloader      → dist/cache/{bsp}/bootloader/    (only if enabled)
  9. rootfs-base     → dist/cache/{bsp}/rootfs-base.tar.gz
 10. rootfs-post     → dist/cache/{bsp}/rootfs-post.tar.gz
 11. make_image      → dist/output/{bsp}/...           (BSP script)
 12. update bundle   → .struxb file                    (only if auto_bundle)
after_build (BSP hook)
```

Around almost every step, the BSP can register **lifecycle scripts** — `before_frontend`, `after_kernel`, and so on — that run at that exact point in the sequence. That's how board-specific work (installing vendor drivers, building a vendor bootloader, packing a Rockchip image) plugs into the generic pipeline without modifying it. See [Lifecycle Scripts](/bsp/concepts/lifecycle-scripts.html) for the full hook list.

Before any step runs, the CLI validates `strux.yaml` and the selected `bsp.yaml`, prepares the `dist/` directory structure, copies embedded assets to `dist/artifacts/` (see [Artifacts](/concepts/artifacts.html)), and makes sure the strux-builder Docker image is up to date. If the Docker image had to be rebuilt, every cached step is invalidated.

## 1. Frontend

Runs `npm install` and `npm run build` in your `frontend/` directory, then copies the build output to `dist/cache/frontend/`.

This is the only step whose output goes in the *shared* cache rather than the per-BSP cache: a built web app is just files, identical for every CPU architecture, so it's reused across boards.

## 2. Application

Compiles your `main.go` (and the rest of your Go module) for the target architecture into `dist/cache/{bsp}/app/main`. If the BSP declares [runtime extensions](/bsp/guide/runtime-extensions.html) under `bsp.runtime.extensions`, their Go packages are compiled in too — that's why this step is per-BSP even though your code doesn't change between boards.

## 3. Cage

Compiles the Cage Wayland compositor from the sources in `dist/artifacts/cage/` (Strux's modified fork — splash rendering, multi-monitor, input mapping; see [Display Stack](/concepts/display-stack.html)) using Meson, producing `dist/cache/{bsp}/cage`. The build also writes a `.cage-env` file from the BSP's `bsp.cage.env` and `bsp.cage.hide_cursor` settings, which later ends up on the device as `/strux/.cage-env`.

## 4. WPE

Two builds in one step:

- The **Strux web extension** (`dist/artifacts/wpe-extension/extension.c`) — the C library that injects `window.strux` into your pages — is compiled with CMake to `dist/cache/{bsp}/libstrux-extension.so`.
- A **patched Cog** browser shell: Cog 0.18.5 is cloned from upstream, an autoplay-policy backport patch is applied (so unmuted media can autoplay in kiosks), and the result is compiled to `dist/cache/{bsp}/cog`.

Both are cross-compiled when the target architecture differs from the host.

## 5. Screen

Compiles `strux-screen`, the screen-capture daemon used for remote viewing, from `dist/artifacts/screen/` to `dist/cache/{bsp}/screen`. This step has no BSP hooks yet.

::: warning Experimental
We're currently working on remote utilities so that you can access your device's screens in the field remotely. This will enable better troubleshooting capabilities without requiring further tools. This feature is not completely implemented yet.
:::

## 6. Client

Compiles the Strux client — the on-device Go program that launches Cage and handles dev-mode connectivity — from `dist/artifacts/client/` to `dist/cache/{bsp}/client`.

Even when this step is cached, the CLI still refreshes the dev-mode configuration: in dev builds it rewrites `.dev-env.json` (so inspector and dev-server settings from `strux.yaml` always take effect), and in production builds it removes it.

## 7. Kernel — only if `custom_kernel`

**Skipped entirely unless** the BSP sets `bsp.boot.kernel.custom_kernel: true`. Without it, the image uses Debian's stock kernel package instead — that's what the qemu BSP does.

::: tip What's a defconfig?
A **defconfig** is a named baseline kernel configuration shipped with the kernel source (e.g. `rockchip_linux_defconfig`). **Fragments** are small config snippets applied on top, and a **device tree** (DTS) is a data file describing the board's hardware to the kernel.
:::

The built-in kernel build runs in two phases:

1. **Extract** — fetch the kernel source (Git repository or tarball URL from `bsp.boot.kernel.source`) and apply the BSP's patches. The `after_kernel_extract` hook runs here, so BSP scripts can drop extra drivers into the source tree before configuration.
2. **Build** — apply the defconfig and fragments, compile the kernel, modules, and device tree, and install the results to `dist/cache/{bsp}/kernel/`.

A BSP can replace the built-in build entirely by registering a script on the `custom_kernel` step; the `before_kernel`/`after_kernel` hooks still run around it.

## 8. Bootloader — only if enabled

**Skipped entirely unless** the BSP sets `bsp.boot.bootloader.enabled: true`. QEMU boots the kernel directly, so the qemu BSP leaves this off; real ARM boards typically need U-Boot.

::: tip What's a bootloader?
The **bootloader** is the first code the board runs from power-on. It initializes RAM and loads the Linux kernel. **U-Boot** is the standard one for ARM single-board computers; **GRUB** is common on x86.
:::

The built-in build fetches the bootloader source, applies patches, fragments, and device trees, stages any vendor firmware blobs declared in `bsp.boot.bootloader.blobs`, and compiles into `dist/cache/{bsp}/bootloader/`. Two escape hatches:

- A script on the `custom_bootloader` step replaces the built-in build (used by Rockchip boards that need the vendor U-Boot tree).
- If `bsp.boot.bootloader.type` is `custom` or `none`, the built-in build is skipped even with `enabled: true` — the BSP's own scripts are expected to provide the boot chain.

## 9. RootFS base

Builds the base Debian root filesystem with `debootstrap` (Debian "trixie"), then installs the fixed system stack inside it: systemd, the Mesa graphics drivers, Wayland, WPE WebKit, Cog, fonts, and media support. The result is archived as `dist/cache/{bsp}/rootfs-base.tar.gz`.

This is the slowest step on a first build (it downloads a Debian system) and one of the most aggressively cached: it only depends on the target architecture and the build script itself, so it almost never reruns.

## 10. RootFS post

Takes the base tarball and layers everything project-specific on top:

- Installs your packages from `rootfs.packages` (in `strux.yaml`) and `bsp.rootfs.packages` — both repository names and local `.deb` files.
- Applies overlays: first the BSP's `bsp.rootfs.overlay`, then your project's `rootfs.overlay`, copied verbatim into the filesystem.
- Copies in the compiled binaries: your backend (`/strux/main`), the client, Cage, the patched Cog, the web extension, the screen daemon, and the built frontend (`/strux/frontend`).
- Copies the display configuration (`/strux/.display-config.json`, generated fresh from `strux.yaml` before this step on every build) and the input device map.
- Installs and enables the systemd services, sets the hostname, installs the kernel (custom or Debian stock), and builds the Plymouth splash theme and initramfs from your logo.

Output: `dist/cache/{bsp}/rootfs-post.tar.gz`, plus the kernel and initramfs images used for booting.

## 11. Image creation

Creating the actual bootable image is **always the BSP's job** — partition layouts and boot flows are too board-specific to generalize. The `before_bundle` hook runs, then every BSP script registered on the `make_image` step. For QEMU that's a script producing a `rootfs.ext4`; for a Rockchip board it's a full GPT disk image with the boot chain in the right sectors. Output lands in `dist/output/{bsp}/`.

## 12. Update bundle — only if auto-bundle is on

If `strux.yaml` has both `update.enabled: true` and `update.auto_bundle: true`, the build ends by producing a signed `.struxb` update bundle — a tarball containing the rootfs image, a manifest, and an RSA signature — ready to ship to devices over the air. See [Updates](/guide/updates.html).

Finally, the `after_build` hook runs and the CLI writes `dist/output/{bsp}/.build-info.json` with the build mode, timestamp, BSP name, and versions.

## Where to go next

- [Caching](/concepts/caching.html) — how steps get skipped on incremental builds.
- [Lifecycle Scripts](/bsp/concepts/lifecycle-scripts.html) — hooking BSP scripts into the pipeline.
- [Building](/guide/building.html) — running builds day to day.
