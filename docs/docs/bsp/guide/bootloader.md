# Bootloaders

This page covers the `boot.bootloader` block of `bsp.yaml`: bootloader types, the built-in U-Boot build, bootloader-level device trees, boot methods, and the vendor firmware blobs that ARM boards need before a bootloader can even run. Read [Custom Kernels](/bsp/guide/kernel.md) first — the bootloader's whole job is loading what that page builds.

## What the bootloader does

When a board powers on, its ROM loads a tiny program from a fixed location on storage. That program — the **bootloader** — initializes RAM, sets up the display for a splash screen, finds the kernel and device tree on disk, and jumps into Linux. On most ARM boards this is **U-Boot**; on x86 it's typically GRUB or systemd-boot behind UEFI.

QEMU doesn't need one at all — `strux run` hands the kernel straight to the emulator — which is why the qemu BSP ships with `enabled: false` and why you can defer this whole page until the kernel works.

## The bootloader block

The gate is `enabled`. When `false` (or the block is absent), the bootloader step is skipped entirely, including any `before_bootloader`/`after_bootloader` scripts. When `true`, the step runs and `type` decides what happens:

```yaml
  boot:
    bootloader:
      enabled: true
      type: u-boot
      version: "2017.09"
      source: https://github.com/rockchip-linux/u-boot.git#b14196eade471bbc000c368f8555f2a2a1ecc17d
      defconfig: rk3576_defconfig
      device_tree:
        dts: ./dts/rk3576-hd215-uboot.dts
      patches:
        - ./patches/uboot-rockchip-strux-bootcmd.diff
        - ./patches/uboot-drm-logo-fs-fallback.diff
      fragments:
        - |
          CONFIG_CMD_SYSBOOT=y
          CONFIG_SPLASH_SCREEN=y
          CONFIG_CMD_BMP=y
      boot_method: extlinux
      boot_config: ./boot/extlinux.conf
      blobs:
        - id: ddr
          role: ddr_init
          path: ./blobs/rk3576_ddr_lp4_2112MHz_lp5_2736MHz_v1.09.bin
          required: true
```

## Types

| Type | Status |
|---|---|
| `u-boot` | Fully implemented built-in build: fetch, configure, patch, compile. |
| `grub` | Placeholder only — the step logs a warning and produces no real artifacts yet. |
| `systemd-boot` | Accepted by the schema, but the built-in build does not implement it yet. |
| `custom` | The built-in build is skipped; your BSP scripts produce the bootloader. |
| `none` | No bootloader is built (QEMU direct boot). |

Two ways to take over the build yourself, with slightly different mechanics:

- **`type: custom`** — the built-in build script exits immediately; whatever your `before_bootloader`/`after_bootloader` scripts produce *is* the bootloader.
- **A script with `step: custom_bootloader`** — regardless of `type`, registering this script replaces the built-in build with your script (the `before_`/`after_` hooks still run around it).

All three hardware example BSPs use the custom route, because Rockchip's vendor U-Boot fork has its own packaging steps (`idbloader.img` assembly, FIT image generation) that the generic build doesn't know about. Their `scripts/build-bootloader-rockchip.sh` still reads `source`, `defconfig`, `patches`, `fragments`, and `blobs` from `bsp.yaml` — so the configuration stays declarative even when the build is custom.

## The built-in U-Boot build

With `type: u-boot`, the step works through these stages, all in `dist/cache/<bsp>/`:

1. **Fetch** — `source` is a git URL with an optional `#branch`/`#tag`/`#commit` ref, or a tarball URL (`.tar.gz`, `.tar.xz`, `.tar.bz2`, `.tgz`; tarballs are cached). The checkout lives at `bootloader-source/`. `version` is a declarative label; `source` determines what's fetched.
2. **Stage blobs** — see [Vendor boot blobs](#vendor-boot-blobs) below.
3. **Install device trees** — see [Device trees at the bootloader level](#device-trees-at-the-bootloader-level).
4. **Patch** — `patches` are applied with `patch -p1`, dry-run first (a failing patch fails the build; an already-applied patch is skipped). Paths are relative to the BSP folder.
5. **Configure** — `make <defconfig>` (the name of a file in U-Boot's `configs/`; required for the built-in build), then `fragments` are appended to the build's `.config` and re-synced with `olddefconfig`. Fragments work like kernel fragments: inline multiline strings of `CONFIG_*` lines, or file paths (`./configs/foo.config`). Later fragments win. The kernel comment syntax `# CONFIG_FOO is not set` disables options.
6. **Compile** — cross-compiled for your `arch`, with any blob `make_var`s passed on the make command line.

The outputs land in `dist/cache/<bsp>/bootloader/`: `u-boot.bin`, plus `u-boot.itb` and `u-boot.img` when the board config produces them, the `spl/` directory (the **SPL** is U-Boot's tiny first-stage loader), and the final `.config` for reference. Your `make_image` script places these into the disk image at the offsets your SoC's boot ROM expects.

## Device trees at the bootloader level

U-Boot uses a device tree of its own — separate from the kernel's — to drive the hardware *it* touches: the storage controller it loads from, the PMIC it programs, the panel it splashes on. `device_tree` under the bootloader configures it, and it supports two modes.

### Standard mode

```yaml
      device_tree:
        dts: ./dts/rk3288-hd215-uboot-rockchip.dts
        dtsi:
          - ./dts/rk3288-hd215-uboot-rockchip-u-boot.dtsi
```

Your DTS files are copied into the U-Boot source tree (`arch/arm/dts/` for both `arm` and `arm64`), registered in U-Boot's DTS Makefile, and built by U-Boot itself — so `#include`s of U-Boot's SoC dtsi files resolve normally. Strux also pins the configuration to your trees (`CONFIG_DEFAULT_DEVICE_TREE`, `CONFIG_OF_LIST`, `CONFIG_SPL_OF_LIST`) and passes `DEVICE_TREE=<name>` to make.

The extra keys:

- `dtsi` — include files copied alongside your DTS so its `#include "..."` lines resolve. The `hd215-rk3288` BSP uses this for the `-u-boot.dtsi` file carrying U-Boot-specific properties.
- `include_paths` — directories whose `.dts`/`.dtsi` files are all copied into U-Boot's dts directory before the build.

### Standalone mode

```yaml
      device_tree:
        dts: ./dts/rk3576-board-full.dts
        standalone: true
```

For a DTS that is *complete* — no includes, for example one decompiled from a running vendor system. Strux compiles it directly with `dtc`, bypassing U-Boot's device tree build entirely, and passes the result to make as `EXT_DTB=<path>`. U-Boot only supports one external DTB, so the first entry wins.

The `hd215-rk3576` BSP shows a related real-world pattern worth knowing: its U-Boot DTS only covers what the SPL needs, while U-Boot proper gets the *kernel's* DTB injected via `EXT_DTB` by the custom build script — mirroring how the board's factory loader works. Whether your board wants its configuration in the U-Boot DTS or the kernel DTB is a property of the vendor U-Boot fork; the vendor image is your reference.

## Vendor boot blobs

On many SoCs, U-Boot is not actually the first code to run. The boot ROM first needs SoC-specific binaries that vendors ship only in binary form: DDR memory training firmware, ARM Trusted Firmware (BL31), a TEE/OP-TEE image (BL32). These are the **boot blobs** — you typically extract them from the vendor's SDK or `rkbin` repository, commit them to the BSP's `blobs/` folder, and declare them:

```yaml
      blobs:
        - id: ddr
          role: ddr_init
          path: ./blobs/rk3576_ddr_lp4_2112MHz_lp5_2736MHz_v1.09.bin
          required: true
        - id: bl31
          role: bl31
          path: ./blobs/rk3576_bl31_v1.20.elf
          make_var: BL31
          required: true
        - id: optee
          role: bl32
          path: ./blobs/rk3576_bl32_v1.06.bin
          make_var: TEE
          required: true
```

Each blob:

| Key | Required | Description |
|---|---|---|
| `id` | yes | Your identifier for the blob. |
| `role` | yes | What it is in the boot chain. The example BSPs use `ddr_init`, `bl31`, `bl32`; any string is accepted. |
| `path` | yes | Where the file lives. `./` resolves to the BSP folder; `cache/` and `output/` resolve to the BSP's dist folders. |
| `required` | no | If `true`, a missing file fails the build instead of warning. |
| `sha256` | no | Checksum verified before use — recommended for binaries you can't rebuild. |
| `make_var` | no | Pass the blob's path to the U-Boot make invocation as `<make_var>=<path>`. |

During the build, blobs are staged to `dist/cache/<bsp>/bootloader/blobs/<role>/<id>` with a `manifest.tsv`, so custom packaging scripts can find them by role. For the make command line, `make_var` is explicit control; without it, the roles `bl31` and `bl32`/`tee` map automatically to U-Boot's `BL31=` and `TEE=` variables.

The Rockchip example makes the chain concrete: the boot ROM loads the DDR init blob plus U-Boot's SPL (packaged together as `idbloader.img`), which loads a FIT image (`u-boot.itb`) containing BL31, OP-TEE, and U-Boot proper — which finally boots Linux. The `package-rockchip.sh` scripts in the example BSPs assemble exactly that.

## Boot method and boot config

`boot_method` declares *how the bootloader finds the kernel*, and `boot_config` points at the template file for it:

```yaml
      boot_method: extlinux
      boot_config: ./boot/extlinux.conf
```

| Method | Meaning |
|---|---|
| `extlinux` | U-Boot's "distro boot": it reads a plain-text menu file at `/boot/extlinux/extlinux.conf` naming the kernel, initrd, DTB, and kernel command line. |
| `script` | A compiled U-Boot script (`boot.scr`) with explicit boot commands. |
| `direct` | No boot configuration — something else loads the kernel (QEMU does this). |

These two keys are declarative: the Strux core records them, and **the BSP's own lifecycle scripts act on them**. The convention, implemented by `scripts/install-boot-config.sh` in the hardware example BSPs (registered at the `before_bundle` step), is:

- `extlinux` — copy the `boot_config` file to `/boot/extlinux/extlinux.conf` in the rootfs.
- `script` — compile the `boot_config` source with `mkimage -T script` and install it as `/boot/boot.scr`.
- `direct` — install nothing.

Copy that script into a new BSP rather than reinventing it. The `extlinux.conf` from `hd215-rk3576` shows what the file contains:

```txt
default strux
timeout 1

label strux
    kernel /boot/vmlinuz
    initrd /boot/initrd.img
    fdt /boot/dtbs/rk3576-hd215-linux.dtb
    append root=LABEL=root rootfstype=ext4 rw rootwait splash console=ttyS0,1500000
```

`kernel`, `initrd`, and `fdt` point at the artifacts your kernel build produced (installed into `/boot` by the image scripts); `append` is the kernel command line — root device, console, splash flags.

::: warning Experimental: A/B boot scripts
The example BSPs also carry a `boot/strux-ab-boot.cmd` U-Boot script and `-ab.genimage.cfg` partition layouts. These belong to the dual-rootfs A/B update system, which is experimental and only activates when updates are enabled in `strux.yaml` — the install script then switches to slot-aware boot assets instead of the plain extlinux flow. The design may change; see [Dual RootFS](/bsp/concepts/dual-rootfs.md) before depending on it.
:::

## Splash screens

A kiosk should show your logo from the first second, and that's a bootloader job. The fragments in the example BSPs (`CONFIG_SPLASH_SCREEN=y`, `CONFIG_CMD_BMP=y`, `CONFIG_BMP_24BPP=y`, `CONFIG_HIDE_LOGO_VERSION=y`) enable U-Boot's BMP splash support, and an `after_bootloader` script (`install-boot-logo.sh`) converts the project's splash PNG to BMP for it — BSP scripts receive `SPLASH_ENABLED`, `SPLASH_LOGO`, and `SPLASH_COLOR` from `strux.yaml`, plus `DISPLAY_WIDTH`/`DISPLAY_HEIGHT`, for exactly this. The patch `uboot-drm-logo-fs-fallback.diff`, shared by all three hardware BSPs, teaches the Rockchip U-Boot to load the logo from the rootfs.

## Where to go next

- [Writing a BSP](/bsp/guide/writing-a-bsp.md) — where the bootloader fits in the bring-up sequence.
- [Lifecycle Scripts](/bsp/concepts/lifecycle-scripts.md) — `before_bootloader`, `after_bootloader`, `custom_bootloader`.
- [Flash Scripts](/bsp/guide/flash-scripts.md) — getting the assembled image onto the board.
- [bsp.yaml Reference](/bsp/reference/bsp-yaml.md) — every bootloader key in one table.
- [Example BSPs](/bsp/guide/examples.md) — three real Rockchip bootloader setups to crib from.
