# Lifecycle Scripts

A BSP customizes the build by attaching shell scripts to **hooks** in the build pipeline — points before and after each built-in step. This page explains the hook model: where the hooks are, what environment your scripts run in, how script caching decides whether to run them, and how paths in their configuration resolve. For a hands-on walkthrough of writing a script, see the [scripts guide](/bsp/guide/scripts.md).

## The mental model

`strux build` runs a fixed pipeline of built-in steps: frontend → application → cage → wpe → client → kernel → bootloader → rootfs → bundling. Strux knows how to do each of these generically; it does **not** know how to assemble the final disk image for your specific board, install your vendor drivers, or convert your splash logo into the format your bootloader wants. That's what lifecycle scripts are for.

Every script is declared in `bsp.yaml` under `bsp.scripts`, with a `location` (the script file) and a `step` (the hook to run it at):

```yaml
scripts:
  - location: ./scripts/make-image.sh
    step: make_image
    description: "Create QEMU disk image"
```

Before and after each built-in step, Strux runs every script registered for that hook, in the order they appear in `bsp.yaml`. The built-in step in the middle may be skipped by the [build cache](/concepts/caching.md); the hooks around it are still evaluated (each script has its own cache, described below).

```txt
before_build
  before_frontend     → [frontend]    → after_frontend
  before_application  → [application] → after_application
  before_cage         → [cage]        → after_cage
  before_wpe          → [wpe]         → after_wpe
  before_client       → [client]      → after_client
  before_kernel       → [kernel]      → after_kernel        (only if custom_kernel: true)
  before_bootloader   → [bootloader]  → after_bootloader    (only if bootloader.enabled: true)
  before_rootfs       → [rootfs]      → after_rootfs
                        [rootfs post-processing]
  before_bundle
  make_image
after_build
```

## The hooks

Most hooks come in `before_*` / `after_*` pairs around a pipeline step, plus a handful of special ones. The complete list with exact ordering is in the [build steps reference](/bsp/reference/build-steps.md); here is the shape of it:

| Hook | Runs |
|---|---|
| `before_build` / `after_build` | Very first and very last hooks of the whole pipeline |
| `before_frontend` / `after_frontend` | Around web frontend compilation |
| `before_application` / `after_application` | Around `main.go` compilation |
| `before_cage` / `after_cage` | Around the Cage compositor build |
| `before_wpe` / `after_wpe` | Around the WPE WebKit extension build |
| `before_client` / `after_client` | Around the on-device strux client binary build |
| `before_kernel` / `after_kernel` | Around the kernel build — only when `boot.kernel.custom_kernel: true` |
| `after_kernel_extract` | Between kernel source fetch+patch and configure+compile |
| `custom_kernel` | *Replaces* the built-in kernel build entirely |
| `before_bootloader` / `after_bootloader` | Around the bootloader build — only when `boot.bootloader.enabled: true` |
| `custom_bootloader` | *Replaces* the built-in bootloader build entirely |
| `before_rootfs` / `after_rootfs` | Around base root filesystem creation |
| `before_bundle` | After rootfs post-processing, right before image creation |
| `make_image` | Creates the final disk image — nearly every BSP defines this |
| `flash_script_tool` / `flash_script` | **Not run during build.** Run on the host by [`strux flash`](/bsp/guide/flash-scripts.md) |

::: tip rootfs?
The **root filesystem** (rootfs) is the Linux file tree the device boots into — `/usr`, `/etc`, your app, everything. Strux assembles it as a Debian system inside Docker, then "post-processing" installs your binaries and overlay files into it.
:::

Three details about the kernel and bootloader hooks are worth knowing:

- The entire kernel hook group only exists when `boot.kernel.custom_kernel: true`; the bootloader group only when `boot.bootloader.enabled: true`. On a BSP like qemu, where both are false, none of these hooks run.
- A `custom_kernel` or `custom_bootloader` script replaces the built-in build, but the surrounding `before_*` / `after_*` hooks still run. With `bootloader.type: custom` (or `none`), the built-in bootloader build is also skipped, even without a `custom_bootloader` script — the Rockchip boards use `type: custom` plus a `custom_bootloader` script to build a vendor U-Boot fork.
- `after_kernel_extract` only fires when the built-in kernel build actually runs (it sits between the fetch+patch phase and the compile phase). If the kernel step is served from cache, or replaced by `custom_kernel`, this hook is skipped. The HT109 BSP uses it to drop vendor drivers into the freshly extracted kernel source before compilation.

## Execution environment

Build-time scripts do **not** run on your machine directly. Strux reads the script file and executes its content with `/bin/bash -c` inside the `strux-builder` Docker container — the same privileged container all built-in build steps use, with your project mounted at `/project`. This means:

- The script runs as root inside Debian Linux, regardless of your host OS. Tools like `genimage`, `mkfs.ext4`, `dtc`, and cross-compilers are available there.
- Host paths mean nothing inside the container. Always use the environment variables Strux provides — `PROJECT_FOLDER` is `/project`, `PROJECT_DIST_CACHE_FOLDER` is `/project/dist/cache/{bsp}`, `PROJECT_DIST_OUTPUT_FOLDER` is `/project/dist/output/{bsp}`, and so on. The full list is in the [environment variables reference](/bsp/reference/environment-variables.md).
- Because the container is run with `--privileged`, scripts can loop-mount images and chroot — that's how `make-image.sh` scripts build disk images.

Strux also passes context as environment variables: `BSP_NAME`, `STEP` (the current hook name), `HOST_ARCH` and `TARGET_ARCH`, `STRUX_VERSION`, `PROJECT_NAME`, `PROJECT_VERSION`, `STRUX_UPDATE_ENABLED`, splash configuration (`SPLASH_ENABLED`, `SPLASH_LOGO`, `SPLASH_COLOR`) and the display size (`DISPLAY_WIDTH`, `DISPLAY_HEIGHT`).

The two flash hooks are the exception: they run **on the host**, outside Docker, because they need access to your USB ports and SD card readers. See [flash scripts](/bsp/guide/flash-scripts.md).

## Script caching

Each script has its own cache entry, independent of the built-in step cache. The model combines an **existence check** on outputs with a **hash check** on inputs:

```yaml
- location: ./scripts/build-bootloader-rockchip.sh
  step: custom_bootloader
  cached_generated_artifacts:     # outputs: skip only if these all exist
    - cache/bootloader/u-boot.bin
    - cache/bootloader/idbloader.img
  depends_on:                     # inputs: re-run if any of these change
    - ./dts/rk3576-hd215-uboot.dts
    - cache/kernel/rk3576-hd215-linux.dtb
```

A script is **skipped** only when all of the following hold:

1. `--clean` was not passed. `strux build --clean` deletes `dist/cache/{bsp}/` and forces every script to run.
2. The script declares at least one entry in `cached_generated_artifacts`. **A script with no declared artifacts runs on every build** — that's the right behavior for cheap idempotent scripts, and the reason `make_image` scripts often declare nothing.
3. Every declared artifact exists on disk.
4. A cache entry from a previous run exists, and the SHA256 hash of the **script file itself** matches it. Editing the script always triggers a re-run; you never need to list the script in `depends_on`.
5. Every file in `depends_on` exists and its hash matches the recorded one. A changed, missing, or never-recorded dependency triggers a re-run.

When a script runs, Strux records the script hash, all dependency hashes, and the artifact list in the cache manifest at `dist/cache/{bsp}/.build-cache.json`.

::: warning Dependencies must be files
`depends_on` entries are hashed as individual files. An entry that points to a directory cannot be hashed, so the script re-runs on every build. List the specific files you depend on.
:::

This two-sided design matters for chaining scripts: declaring another script's output (for example `cache/bootloader/spl/u-boot-spl.bin`) as your `depends_on` makes your script re-run exactly when the upstream script produced something new.

## Path resolution

`cached_generated_artifacts` and `depends_on` use a small prefix convention, resolved per-BSP:

| Prefix | Resolves to | Use for |
|---|---|---|
| `cache/` | `dist/cache/{bsp}/` | Intermediate build artifacts |
| `output/` | `dist/output/{bsp}/` | Final build products |
| `./` | `bsp/{bsp}/` (the BSP directory) — `depends_on` only | Your DTS files, patches, blobs, configs |
| anything else | `dist/` | Rarely needed |

So `cache/rootfs-post.tar.gz` is the post-processed rootfs tarball in this BSP's cache, and `./boot/extlinux.conf` is a file inside the BSP folder. The same rules, with examples, are in the [path resolution reference](/bsp/reference/path-resolution.md).

## Where to go next

- [Writing lifecycle scripts](/bsp/guide/scripts.md) — the practical guide: a first script, choosing hooks, debugging.
- [Build steps reference](/bsp/reference/build-steps.md) — every hook, in exact execution order.
- [Environment variables reference](/bsp/reference/environment-variables.md) — everything available to your scripts.
- [Build pipeline](/concepts/build-pipeline.md) and [caching](/concepts/caching.md) — how the built-in steps and their cache work.
