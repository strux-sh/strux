# Build Steps & Lifecycle Hooks

The exact order of the build pipeline, what each step does, when conditional steps run, and the full list of `before_*` / `after_*` hook values your BSP scripts can attach to. For the mental model behind the pipeline, see [Build Pipeline](/concepts/build-pipeline.md); for how to write hook scripts, see the [Scripts guide](/bsp/guide/scripts.md).

## Pipeline order

Steps run in this order on every `strux build` (and the build phase of `strux dev`). Each cacheable step is skipped when the [build cache](/concepts/caching.md) detects no changes to its inputs; its surrounding hooks still run (subject to their own [script caching](/bsp/concepts/lifecycle-scripts.md)).

| # | Step | What it does | Runs when | Hooks around it |
| --- | --- | --- | --- | --- |
| 1 | `frontend` | Regenerates TypeScript API types, then compiles the web frontend (Vue/React/vanilla) with Vite. | Always | `before_frontend` / `after_frontend` |
| 2 | `application` | Compiles your `main.go` backend for the target architecture. | Always | `before_application` / `after_application` |
| 3 | `cage` | Compiles the Cage Wayland compositor. | Always | `before_cage` / `after_cage` |
| 4 | `wpe` | Compiles the WPE WebKit extension and the patched Cog browser launcher. | Always | `before_wpe` / `after_wpe` |
| 5 | `screen` | Compiles the screen capture daemon (`strux-screen`). | Always | none |
| 6 | `client` | Compiles the on-device Strux client binary; writes (dev) or removes (production) the dev environment config. | Always | `before_client` / `after_client` |
| 7 | `kernel` | Two phases: fetch + patch the kernel source (`extract`), then configure, compile, and install it. | Only when `boot.kernel.custom_kernel: true` | `before_kernel`, `after_kernel_extract` (between the phases), `after_kernel` |
| 8 | `bootloader` | Builds the bootloader (U-Boot, GRUB, ...). | Only when `boot.bootloader.enabled: true`; the built-in build additionally requires `type` to be set and not `custom` or `none` | `before_bootloader` / `after_bootloader` |
| 9 | `rootfs-base` | Creates the minimal Debian base root filesystem with debootstrap. | Always | `before_rootfs` / `after_rootfs` |
| 10 | `rootfs-post` | Post-processes the rootfs: installs your binaries, kernel, packages, overlays, splash, and display config into it. The display config is written just before this step. | Always | none (followed by `before_bundle`) |
| 11 | `before_bundle` | Hook-only stage between rootfs post-processing and image creation. | Always | — |
| 12 | `make_image` | Runs the BSP's `make_image` script(s) to produce the final disk image. There is no built-in image step — the BSP must provide this. | Always (if the BSP defines a `make_image` script) | — |
| 13 | update bundle | Generates the signed Strux rootfs update bundle from the built image. | Only when `strux.yaml` has `update.enabled: true` and `update.auto_bundle: true` — see [Updates](/guide/updates.md) | — |
| 14 | `after_build` | Hook-only stage after everything completes. | Always | — |

`before_build` hooks run before step 1, right after configuration validation and artifact preparation.

::: tip Conditional steps and caching
When `custom_kernel` is `false` or `bootloader.enabled` is `false`, the corresponding step is treated as intentionally skipped — it does not poison the cache for later steps. Setting `bootloader.type: custom` keeps the bootloader stage enabled (hooks and `custom_bootloader` scripts run) but skips Strux's built-in build.
:::

## Replacing built-in steps

Two hook values don't wrap a built-in step — they **replace** it:

| Hook | Replaces | Behavior |
| --- | --- | --- |
| `custom_kernel` | The built-in kernel build (both the extract and build phases) | Your script runs instead. `before_kernel` and `after_kernel` still run around it; `after_kernel_extract` does **not** run, since the built-in extract phase is skipped. Requires `boot.kernel.custom_kernel: true`. |
| `custom_bootloader` | The built-in bootloader build | Your script runs instead. `before_bootloader` and `after_bootloader` still run around it. Requires `boot.bootloader.enabled: true`. |

## All valid hook values

The complete set of values accepted by `scripts[].step` in [bsp.yaml](/bsp/reference/bsp-yaml.md#bsp-scripts):

| Step value | Fires |
| --- | --- |
| `before_build` | Very first, before any compilation. |
| `before_frontend` | Before frontend compilation. |
| `after_frontend` | After frontend compilation. |
| `before_application` | Before `main.go` compilation. |
| `after_application` | After `main.go` compilation. |
| `before_cage` | Before Cage compositor compilation. |
| `after_cage` | After Cage compilation. |
| `before_wpe` | Before WPE WebKit extension compilation. |
| `after_wpe` | After WPE extension compilation. |
| `before_client` | Before Strux client compilation. |
| `after_client` | After Strux client compilation. |
| `before_kernel` | Before kernel source fetch. Conditional: `custom_kernel: true`. |
| `after_kernel_extract` | After kernel source fetch + patching, before configuration and compilation — e.g. to install a boot logo into the source tree. Conditional: `custom_kernel: true` and no `custom_kernel` script. |
| `custom_kernel` | Replaces the built-in kernel build. Conditional: `custom_kernel: true`. |
| `after_kernel` | After the kernel build (built-in or custom). Conditional: `custom_kernel: true`. |
| `before_bootloader` | Before the bootloader build. Conditional: `bootloader.enabled: true`. |
| `custom_bootloader` | Replaces the built-in bootloader build. Conditional: `bootloader.enabled: true`. |
| `after_bootloader` | After the bootloader build (built-in or custom). Conditional: `bootloader.enabled: true`. |
| `before_rootfs` | Before base root filesystem creation. |
| `after_rootfs` | After base root filesystem creation. |
| `before_bundle` | After rootfs post-processing, before `make_image`. |
| `make_image` | Creates the final disk image for the target device. |
| `after_build` | Very last, after everything completes. |
| `flash_script_tool` | Not part of the build. Run on the **host** by `strux flash`, before `flash_script` — e.g. to download a vendor flashing tool. See [Flash Scripts](/bsp/guide/flash-scripts.md). |
| `flash_script` | Not part of the build. Run on the **host** by `strux flash` to write the image to a device. See [Flash Scripts](/bsp/guide/flash-scripts.md). |

Multiple scripts may share the same step; they run in the order they appear in `bsp.yaml`.

## Where scripts run

All build-time scripts run inside the `strux-builder` Docker container with your project mounted at `/project`. The two `flash_*` steps run directly on your host machine. Either way, scripts get a standard set of environment variables — see [Environment Variables](/bsp/reference/environment-variables.md).
