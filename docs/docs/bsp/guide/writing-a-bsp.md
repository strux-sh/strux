# Writing a BSP

This guide walks you from an empty folder to a BSP that builds a flashable image for real hardware. The strategy: get a minimal BSP building first, then add packages, an overlay, scripts, a custom kernel, and a bootloader — one layer at a time, with a working build after each layer. The examples use real values from the `hd215-rk3576` BSP (a Rockchip RK3576 board).

## Prerequisites

- A working Strux project — if you don't have one, do [Getting Started](/guide/getting-started.html) first.
- Read the [BSP introduction](/bsp/guide/introduction.html) so the vocabulary here (lifecycle steps, path shorthand) is familiar.
- For the hardware layers: your board's documentation, and ideally a vendor Linux image that already boots — it tells you which kernel tree, device tree, and firmware blobs the board needs.

## 1. Start minimal

Create the folder and the smallest valid `bsp.yaml`. The fastest way is to copy the `qemu` BSP your project already has and edit it — its `bsp.yaml` is heavily commented and doubles as a reference. Trimmed down, you need this:

```yaml
strux_version: 0.3.0
bsp:
  name: hd215-rk3576
  description: "Medeiros IT HD215 RK3576 Board"
  arch: arm64
  hostname: hd215
  display:
    resolution: 1920x1080

  scripts:
    - location: ./scripts/make-image.sh
      step: make_image
      description: "Create disk image"
```

Five fields are required: `strux_version`, `name`, `description`, `arch`, and `hostname`. `arch: arm64` selects the AArch64 cross-toolchain for every build step — most modern ARM boards are `arm64`; older 32-bit boards (like the RK3288) are `armhf`.

Notice what's *absent*: no `boot` section at all. With no `custom_kernel: true` and no `bootloader.enabled: true`, the kernel and bootloader steps are skipped entirely. That's deliberate — prove the easy 90% of the pipeline before touching the hard 10%.

### The make_image script

Strux builds your app, the compositor, the browser engine, and a Debian root filesystem — and leaves the result as a tarball at `dist/cache/<bsp>/rootfs-post.tar.gz`. Turning that tarball into a bootable disk image is the BSP's job, because only the BSP knows the board's partition layout. That's the `make_image` step.

For the first pass, copy `bsp/qemu/scripts/make-image.sh` — it extracts the rootfs tarball and writes a plain ext4 image:

```bash
#!/bin/bash
set -eo pipefail

progress() {
    echo "STRUX_PROGRESS: $1"
}

progress "Extracting root filesystem tarball..."
ROOTFS_DIR="/tmp/rootfs"
mkdir -p "$ROOTFS_DIR"
tar -xzf "$PROJECT_DIST_CACHE_FOLDER/rootfs-post.tar.gz" -C "$ROOTFS_DIR"

ROOTFS_SIZE=$(du -sm "$ROOTFS_DIR" | cut -f1)
IMAGE_SIZE=$((ROOTFS_SIZE + ROOTFS_SIZE / 5 + 200))

progress "Creating ext4 image..."
ROOTFS_OUTPUT="$PROJECT_DIST_OUTPUT_FOLDER/rootfs.ext4"
dd if=/dev/zero of="$ROOTFS_OUTPUT" bs=1M count=${IMAGE_SIZE}
mkfs.ext4 -F "$ROOTFS_OUTPUT"
mkdir -p /tmp/ext4mount
mount -o loop "$ROOTFS_OUTPUT" /tmp/ext4mount
cp -a "$ROOTFS_DIR"/* /tmp/ext4mount/
umount /tmp/ext4mount
```

The script runs inside the `strux-builder` Docker container with your project mounted at `/project`. Strux injects environment variables so you never hard-code paths: `PROJECT_DIST_CACHE_FOLDER` is this BSP's cache (`dist/cache/<bsp>/`), `PROJECT_DIST_OUTPUT_FOLDER` is its output (`dist/output/<bsp>/`). Lines printed as `STRUX_PROGRESS: ...` show up as live status in the CLI. The full variable list is in [Environment Variables](/bsp/reference/environment-variables.html).

### Build it

```bash
strux build hd215-rk3576
```

The first build is slow (it compiles the browser stack); after that the [cache](/concepts/caching.html) keeps rebuilds to seconds. When it finishes you have an image in `dist/output/hd215-rk3576/`. It won't boot the board yet — there's no board kernel and no bootloader — but the pipeline, your scripts, and the rootfs are now proven.

## 2. Add packages

Board hardware usually needs userspace support: firmware packages, WiFi tools, audio. Declare them under `rootfs`:

```yaml
  rootfs:
    packages:
      - curl
      - wget
      - firmware-brcm80211
      - alsa-utils
      - pulseaudio
      - network-manager
      - wpasupplicant
      - iw
      - bluez
      - rfkill
```

These are Debian package names, installed into the root filesystem during the rootfs step. Board-specific packages belong here in the BSP — not in your project-wide configuration — so each board only carries what it needs.

## 3. Add an overlay

An **overlay** is a folder whose contents are copied verbatim onto the root filesystem, preserving paths — `overlay/etc/asound.conf` ends up at `/etc/asound.conf` on the device. It's how you ship config files, systemd units, and firmware blobs that no Debian package provides.

```yaml
  rootfs:
    overlay: ./overlay
    packages:
      # ...
```

The `hd215-rk3576` overlay is a good model of what belongs here:

```txt
overlay/
├── etc/asound.conf                          # ALSA routing for the board codec
├── etc/pulse/system.pa                      # PulseAudio config
├── etc/systemd/system/alsa-init.service     # Board-specific services
├── usr/local/bin/alsa-init.sh
└── usr/lib/firmware/aic8800/...             # Vendor WiFi firmware files
```

Note that the project also has its own overlay folder for app-level files; the BSP overlay is specifically for board-level files. See [Customizing the OS](/guide/customizing-the-os.html).

## 4. Add lifecycle scripts

`make_image` is just one of many hooks. Any script entry names a `step`, and Strux runs it at that point in the pipeline — `before_build`, `after_frontend`, `before_rootfs`, `after_bootloader`, and so on. The full list with execution order is in [Build Steps](/bsp/reference/build-steps.html), and the mechanics in [Lifecycle Scripts](/bsp/concepts/lifecycle-scripts.html).

The important feature to learn early is **script caching**. By default a script runs on every build. Declare what it produces and what it reads, and Strux skips it when nothing changed:

```yaml
  scripts:
    - location: ./scripts/install-vendor-drivers.sh
      step: after_kernel_extract
      description: "Install vendor drivers into the kernel tree"
      depends_on:
        - ./scripts/install-vendor-drivers.sh
        - ./drivers/

    - location: ./scripts/make-image.sh
      step: make_image
      description: "Create RK3576 disk image using genimage"
      depends_on:
        - ./boot/extlinux.conf
        - cache/rootfs-post.tar.gz
        - cache/bootloader/idbloader.img
        - ./image/hd215-rk3576.genimage.cfg
```

The rules, as implemented:

- A script with no `cached_generated_artifacts` **always runs** — `depends_on` alone never enables skipping. The `make_image` example above is like that on purpose; if your script's output is expensive, declare its artifacts.
- With `cached_generated_artifacts`, the script is **skipped** when every listed artifact exists, the script file itself is unchanged, and every `depends_on` hash is unchanged. `--clean` forces a run.
- Paths resolve by prefix: `cache/...` → `dist/cache/<bsp>/...`, `output/...` → `dist/output/<bsp>/...`, `./...` → the BSP folder, anything else → `dist/`. Details in [Path Resolution](/bsp/reference/path-resolution.html).

`depends_on` can point at directories (like `./drivers/` above) — the whole tree is hashed.

## 5. Add a custom kernel

Up to now the image uses the stock Debian kernel from the rootfs. Real boards almost always need their vendor's kernel tree and a board device tree. Flip the switch and point at the sources:

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
      patches:
        - ./patches/kernel-hd215-mcu-poweroff.patch
      device_tree:
        dts: ./dts/rk3576-hd215-linux.dts
```

::: tip What's a defconfig? What's a device tree?
A **defconfig** is a named preset of kernel build options — `rockchip_linux_defconfig` is a file the Rockchip kernel tree ships in its `configs/` system that enables everything Rockchip SoCs need. A **device tree** (`.dts`) is a text file describing the board's hardware — which peripherals exist, at which addresses, on which pins — that the kernel reads at boot instead of probing. Both get a full treatment in [Custom Kernels](/bsp/guide/kernel.html).
:::

This single block makes the kernel step fetch the source (a git URL with an optional `#branch`, `#tag`, or `#commit` pin), apply your patches, configure with the defconfig plus your fragments, build the kernel image, modules, and device tree blob, and install everything to `dist/cache/<bsp>/kernel/`. Your `make_image` script picks the artifacts up from there.

Build again and watch the kernel step run. Kernel iteration (menuconfig, fragments, cleaning) is covered in [Custom Kernels](/bsp/guide/kernel.html).

## 6. Add a bootloader

The last layer is the **bootloader** — the program the board's ROM loads at power-on, which initializes RAM and loads your kernel. For most ARM boards this is U-Boot:

```yaml
  boot:
    bootloader:
      enabled: true
      type: u-boot
      source: https://github.com/rockchip-linux/u-boot.git#b14196eade471bbc000c368f8555f2a2a1ecc17d
      defconfig: rk3576_defconfig
      device_tree:
        dts: ./dts/rk3576-hd215-uboot.dts
      patches:
        - ./patches/uboot-rockchip-strux-bootcmd.diff
      boot_method: extlinux
      boot_config: ./boot/extlinux.conf
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
```

New concepts here — `boot_method`, `boot_config`, and the vendor `blobs` (firmware binaries the SoC needs before U-Boot can even run) — are explained in [Bootloaders](/bsp/guide/bootloader.html). Boards whose vendor U-Boot needs a non-standard build (the Rockchip trees do) replace the built-in build with a `custom_bootloader` script instead of `type: u-boot`; the real `hd215-rk3576` BSP does exactly that, and the bootloader guide shows how.

With the bootloader built, your `make_image` script grows up too: instead of a bare ext4 file, it assembles a real partition table with the bootloader at the right offsets. The hardware BSPs use `genimage` (available in the builder container) with a config in `image/`, sized from the rootfs and driven by the artifacts in `cache/bootloader/`. Study `bsp/hd215-rk3576/scripts/make-image.sh` and `image/hd215-rk3576.genimage.cfg` as the reference.

## 7. Flash and iterate

Add `flash_script_tool` and `flash_script` entries so `strux flash` can write the image to the board — see [Flash Scripts](/bsp/guide/flash-scripts.html). From there, bring-up is iterative: tweak the device tree or a kernel option, rebuild (the cache means only the kernel step reruns), reflash, watch the serial console.

## Where to go next

- [Custom Kernels](/bsp/guide/kernel.html) — the kernel block in full depth.
- [Bootloaders](/bsp/guide/bootloader.html) — types, boot methods, blobs, U-Boot device trees.
- [Lifecycle Scripts](/bsp/concepts/lifecycle-scripts.html) — every hook and how caching decides to skip.
- [Runtime Extensions](/bsp/guide/runtime-extensions.html) — give your app APIs for the board's hardware.
- [Example BSPs](/bsp/guide/examples.html) — the qemu, RK3576, and RK3288 BSPs annotated.
