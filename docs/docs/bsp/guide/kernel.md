# Custom Kernels

This page covers the `boot.kernel` block of `bsp.yaml`: choosing a kernel source, configuring it with a defconfig and fragments, applying patches, building device trees, and the `strux kernel` commands for iterating on configuration. It assumes you have a building BSP — if not, start with [Writing a BSP](/bsp/guide/writing-a-bsp.md).

## When you need a custom kernel

You don't always. With `custom_kernel: false` (the default in the qemu BSP), the image uses the stock Debian kernel that comes with the root filesystem — which is exactly right for QEMU and for x86 hardware that generic Debian already boots.

You need a custom kernel when:

- **The board needs a vendor kernel tree.** Most ARM single-board computers (Rockchip, Allwinner, and friends) have drivers that never made it upstream; the vendor or a community fork (Armbian, for example) maintains a tree that supports the SoC.
- **The board needs a custom device tree** describing its specific panel, touch controller, PMIC, and wiring.
- **You need kernel options Debian doesn't enable** — the USB gadget Ethernet support that `strux dev` over USB requires is a common one.

## The kernel block

This is the real configuration from the `hd215-rk3576` BSP:

```yaml
  boot:
    kernel:
      custom_kernel: true
      source: https://github.com/armbian/linux-rockchip.git#rk-6.1-rkr6.1
      version: "6.1"
      defconfig: rockchip_linux_defconfig
      fragments:
        - |
          CONFIG_CPU_RK3576=y
          CONFIG_CLK_RK3576=y
          CONFIG_ARM_ROCKCHIP_CPUFREQ=y
        - |
          CONFIG_USB_GADGET=y
          CONFIG_USB_LIBCOMPOSITE=y
          CONFIG_USB_CONFIGFS=y
          CONFIG_USB_CONFIGFS_ECM=y
          CONFIG_USB_CONFIGFS_NCM=y
          CONFIG_USB_CONFIGFS_RNDIS=y
      patches:
        - ./patches/kernel-aic8800-makefile-fix.patch
        - ./patches/kernel-hd215-mcu-poweroff.patch
      device_tree:
        dts: ./dts/rk3576-hd215-linux.dts
```

When `custom_kernel: true`, the kernel step runs as part of `strux build`: fetch source → apply patches → (your `after_kernel_extract` scripts) → configure → compile → install artifacts. Everything happens inside the builder container with the cross-compiler matching your `arch` (`aarch64-linux-gnu-` for `arm64`, `arm-linux-gnueabihf-` for `armhf`, native for `x86_64`).

## Source and version

`source` accepts two forms:

- **A git URL**, with an optional ref after `#` — a branch (`#rk-6.1-rkr6.1`), a tag, or an exact commit hash (`#b4ef083dc0c3...`). Strux tries a shallow clone first and falls back to a full clone when the ref demands it.
- **A tarball URL** ending in `.tar.gz`, `.tar.xz`, `.tar.bz2`, or `.tgz`, e.g. `https://github.com/torvalds/linux/releases/download/v6.1/linux-6.1.tar.gz`.

The source is checked out to `dist/cache/<bsp>/kernel-source/` and reused across builds; on later builds Strux just switches the existing checkout to the requested ref.

::: tip Pin your ref
The `ht109-rk3576s` BSP pins an exact commit (`...kernel.git#b4ef083dc0c3608e744deabb43dc6b781aadbe6e`) rather than a branch, with a comment explaining the patches were generated against that tip. Branches move; your patches don't. Pin a commit once the BSP works, and bump it deliberately.
:::

`version` is a declarative label for the kernel version (`"6.1"`). What actually gets fetched is determined entirely by `source` and its `#ref`.

## Configuration: defconfig + fragments

Kernel configuration is the `.config` file — thousands of `CONFIG_*` options. Strux builds it in layers:

1. **Base config.** If `bsp/<bsp>/configs/kernel.config` exists (a full saved config — see menuconfig below), it is used and refreshed with `make olddefconfig`. Otherwise Strux runs `make <defconfig>` with the `defconfig` value from `bsp.yaml`; if you omit it, the kernel's generic `defconfig` target is used.
2. **Fragments.** Each entry in `fragments` is merged on top using the kernel's own `scripts/kconfig/merge_config.sh`, in order — later fragments win.

::: tip What's a defconfig? What's a fragment?
A **defconfig** is a named configuration preset shipped inside the kernel tree (in `arch/*/configs/`) — `rockchip_linux_defconfig` enables everything Rockchip boards commonly need. A **fragment** is a small list of `CONFIG_*` lines layered on top, so you only state your deltas instead of maintaining a full multi-thousand-line config.
:::

A fragment can be either of:

- **An inline block** — a YAML multiline string of `CONFIG_*` lines, like the examples above. Great for small, self-documenting deltas.
- **A file path** — `./configs/kernel-usb.config` (relative to the BSP folder) or a bare filename ending in `.config`. Use files when a fragment gets long.

To *disable* an option from the defconfig, set it to `n` — the `hd215-rk3576` BSP does `CONFIG_LOGO=n` to suppress the Tux boot logo. The kernel's comment syntax (`# CONFIG_FOO is not set`) also works inside fragments.

::: warning Strux dev over USB needs gadget support
The USB fragment in the example above is not optional decoration: `strux dev` over a USB cable requires USB gadget Ethernet in the kernel. Enable ECM/NCM for macOS and Linux hosts, RNDIS for Windows hosts. Every hardware example BSP carries this fragment.
:::

## Capturing config interactively: menuconfig

Hunting `CONFIG_` names by hand is painful. `make menuconfig` is the kernel's interactive configuration browser, and Strux wraps it:

```bash
strux kernel menuconfig
```

This fetches the kernel source if needed, loads your current config (saved config if present, otherwise the defconfig), and opens menuconfig in the builder container — navigate with arrows, toggle with Space, search with `/`. When you exit, the full resulting config is saved to `bsp/<bsp>/configs/kernel.config`, and the next build uses it automatically.

```bash
strux kernel menuconfig --save
```

`--save` additionally runs the kernel's `savedefconfig` to produce a *minimal* config — only the deltas from defaults — at `bsp/<bsp>/configs/kernel.fragment`. That file is fragment-shaped: add it to `bsp.yaml` if you prefer keeping your configuration as defconfig + fragments instead of a full saved config:

```yaml
      fragments:
        - "./configs/kernel.fragment"
```

::: warning A saved kernel.config takes priority
Once `configs/kernel.config` exists, it replaces the `defconfig` from `bsp.yaml` as the base (fragments still apply on top). That's convenient for iteration but easy to forget: if changing `defconfig` in `bsp.yaml` seems to do nothing, a saved config is why. Delete `configs/kernel.config` to go back to defconfig-based configuration. (`strux kernel menuconfig` requires `custom_kernel: true`.)
:::

## Patches

`patches` is a list of patch files applied to the source tree after fetch, in order, with `patch -p1`. Paths are relative to the BSP folder.

```yaml
      patches:
        - ./patches/kernel-aic8800-makefile-fix.patch
        - ./patches/kernel-hd215-mcu-poweroff.patch
```

Two behaviors worth knowing:

- Each patch is dry-run first; a patch that no longer applies **fails the build** (rather than silently producing a broken kernel).
- A patch that is *already applied* (detected via a reverse dry-run) is skipped with a notice — so reusing a cached source tree across builds is safe.

For board files that are additions rather than modifications, you don't need patches at all: the `ht109-rk3576s` BSP keeps whole vendor driver directories under `drivers/` in the BSP and copies them into the kernel tree with an `after_kernel_extract` script, which runs after fetch + patch and before configuration. See [Lifecycle Scripts](/bsp/concepts/lifecycle-scripts.md).

## Device trees

A **device tree source** (`.dts`) describes the board's hardware — peripherals, addresses, pins, clocks — and compiles to a binary blob (`.dtb`) the bootloader hands to the kernel at boot. ARM boards can't boot without the right one.

```yaml
      device_tree:
        dts: ./dts/rk3576-hd215-linux.dts
```

`dts` accepts a single entry or a list, and each entry is interpreted by its path form:

- **A name with no leading `./`** (`rk3399-rock-pi-4.dts`): an *in-tree* device tree — one that already exists in the kernel's `arch/*/boot/dts/`. Strux builds exactly that `.dtb` make target. Use this when mainline or the vendor tree already supports your board.
- **A path starting with `./` or `/`** (`./dts/rk3576-hd215-linux.dts`): an *external* DTS kept in your BSP. Strux preprocesses it with the kernel's include paths (so `#include <dt-bindings/...>` and SoC `.dtsi` includes from the kernel tree resolve), compiles it with the kernel's own `dtc`, and drops the `.dtb` into the output. This is the normal case for custom boards — your DTS lives in the BSP, versioned with everything else, typically `#include`-ing the SoC dtsi from the kernel tree and describing only your board on top.
- A `.dtsi` entry in the list isn't compiled itself; its directory is added to the include path for the other entries.

Two optional companions:

```yaml
      device_tree:
        dts: ./dts/rk3576-hd215-linux.dts
        overlays:
          - ./dts/overlays/add-device.dtso
        include_paths:
          - ./dts/includes
```

- `overlays` — device tree overlay sources (`.dtso`), compiled with `dtc -@` into `.dtbo` files and copied to the output alongside the DTBs. Overlays describe optional hardware variations applied on top of a base tree.
- `include_paths` — extra directories searched when preprocessing external DTS files, for headers you keep in the BSP.

## Build outputs

Everything lands in `dist/cache/<bsp>/kernel/`, where your `make_image` (and bootloader) scripts consume it:

| Artifact | What it is |
|---|---|
| `Image` / `zImage` / `bzImage` | The kernel image (arm64 / armhf / x86_64 respectively) |
| `kernel.img` | A copy of the kernel image under a uniform name |
| `modules/` | Kernel modules, installed via `INSTALL_MOD_PATH` (i.e. a `lib/modules/...` tree) |
| `dtbs/` | Compiled device tree blobs and overlays |
| `.config` | The final merged configuration, for reference |

For example, the `hd215-rk3576` extlinux boot configuration references `dtbs/rk3576-hd215-linux.dtb`, and its custom bootloader build lists `cache/kernel/rk3576-hd215-linux.dtb` as a dependency.

## Replacing the build entirely

If the built-in fetch/config/build flow doesn't fit (a kernel with a bespoke build system, or prebuilt vendor kernels), register a script with `step: custom_kernel`. It replaces the built-in extract and build phases completely — `before_kernel` and `after_kernel` hooks still run around it. See [Lifecycle Scripts](/bsp/concepts/lifecycle-scripts.md).

## Cleaning

Kernel builds leave a lot of state in `dist/cache/<bsp>/kernel-source/`. When configuration changes don't seem to take effect, or you want a truly fresh build:

```bash
strux kernel clean                    # make mrproper: removes .config and all generated files
strux kernel clean --mode clean       # make clean: removes objects, keeps the config
strux kernel clean --mode full        # deletes the source checkout and build output entirely
```

`--mode full` means the next build re-clones the source — the heavyweight option when the tree is wedged or you've changed `source` and want no leftovers.

## Where to go next

- [Bootloaders](/bsp/guide/bootloader.md) — the other half of the boot story, including how the bootloader finds your kernel and DTB.
- [Lifecycle Scripts](/bsp/concepts/lifecycle-scripts.md) — `before_kernel`, `after_kernel_extract`, `after_kernel`, `custom_kernel`.
- [bsp.yaml Reference](/bsp/reference/bsp-yaml.md) — the kernel block, key by key.
- [Caching](/concepts/caching.md) — when the kernel step reruns and when it's skipped.
