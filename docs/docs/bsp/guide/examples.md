# BSP Examples

The fastest way to write a BSP is to start from one that already works. The Strux repository ships four real BSPs under `test/bsp/` — from a minimal QEMU profile to full Rockchip board bring-ups with custom kernels, vendor bootloaders, and flash scripts. This page tours each one so you can pick the closest starting point and copy it into your project's `bsp/` folder.

| BSP | Hardware | Arch | Custom kernel | Bootloader | Flash scripts | Runtime extensions |
|---|---|---|---|---|---|---|
| `qemu` | QEMU virtual machine | arm64 | no | none | no | no |
| `hd215-rk3576` | HD215 kiosk board (RK3576) | arm64 | yes | vendor U-Boot | yes | yes |
| `ht109-rk3576s` | HT109 tablet (RK3576S) | arm64 | yes | vendor U-Boot | yes | yes |
| `rt101-rk3568` | RT101 tablet (RK3568) | arm64 | yes | vendor U-Boot | yes | yes |
| `hd215-rk3288` | HD215 board (RK3288) | armhf | yes | vendor U-Boot | no | no |

::: tip How You Can Help
Have a device that you want supported? We're currently working on supporting the Raspberry Pi 5 and other Single Board Computers. If you have a specific request for a device, feel free to shoot us an [Email](mailto:support@medeirosconsulting.ca)
:::

## qemu — the minimal reference

The BSP every project starts with (`strux init` scaffolds it for you). It targets a QEMU virtual machine, so there is no real hardware to support: no bootloader, no custom kernel, no flash scripts. That makes it the cleanest illustration of what a BSP *minimally* is.

```yaml
strux_version: 0.0.1
bsp:
  name: qemu
  description: "QEMU virtual machine for testing"
  display:
    resolution: 1920x1080
  arch: arm64
  hostname: test

  cage:
    env:
      - WLR_DRM_NO_MODIFIERS=1
      - WLR_NO_HARDWARE_CURSORS=1
```

The `cage.env` entries pass environment variables to the Cage compositor — these two work around quirks of QEMU's virtual GPU. Both `boot.bootloader.enabled` and `boot.kernel.custom_kernel` are `false`, so the kernel and bootloader hooks never fire.

What it demonstrates:

- **A single `make_image` script** (`scripts/make-image.sh`) that extracts the rootfs tarball from `$PROJECT_DIST_CACHE_FOLDER`, sizes an ext4 image, loop-mounts it, and copies the files in. It declares its caching honestly:

```yaml
scripts:
  - location: ./scripts/make-image.sh
    step: make_image
    description: "Create QEMU disk image"
    cached_generated_artifacts:
      - output/rootfs.ext4
    depends_on:
      - cache/rootfs-base.tar.gz
      - cache/rootfs-post.tar.gz
```

- **Per-BSP packages and overlay** under `rootfs:` — extra Debian packages and a folder of files copied verbatim into the OS.
- Its `bsp.yaml` is also heavily commented — the comments document every script hook, environment variable, and path-resolution rule inline, which makes it a handy cheat sheet.

Start here if: you're learning the format, or your target boots a stock Debian kernel without a board-specific bootloader.

## hd215-rk3576 — the full bring-up

A complete board support package for the Medeiros IT HD215, a Rockchip RK3576 kiosk device with a 1920x1080 LVDS panel, AIC8800 Wi-Fi/Bluetooth, and an ES8388 audio codec. This is the most instructive BSP in the repo — nearly every Strux BSP feature appears in it.

**Custom kernel.** It builds the Armbian Rockchip kernel with config fragments and board patches, and compiles an external device tree:

```yaml
kernel:
  custom_kernel: true
  source: https://github.com/armbian/linux-rockchip.git#rk-6.1-rkr6.1
  version: "6.1"
  defconfig: rockchip_linux_defconfig
  fragments:
    - |
      CONFIG_CPU_RK3576=y
      CONFIG_CLK_RK3576=y
      ...
  patches:
    - "./patches/kernel-aic8800-makefile-fix.patch"
    - "./patches/kernel-hd215-mcu-poweroff.patch"
  device_tree:
    dts: ./dts/rk3576-hd215-linux.dts
```

::: tip Device tree?
A **device tree** (DTS) is a data file describing the board's hardware — which chips sit on which buses, at which addresses — so the kernel doesn't need board-specific code compiled in. See the [kernel guide](/bsp/guide/kernel.md).
:::

**Vendor U-Boot via `custom_bootloader`.** Mainline U-Boot couldn't drive this board's display for a boot splash, so the BSP sets `type: custom` and builds Rockchip's U-Boot fork with its own script, chaining the required firmware **blobs** (pre-compiled vendor binaries for DDR memory training and the ARM trusted firmware) through the `blobs:` list:

```yaml
bootloader:
  enabled: true
  type: custom
  source: https://github.com/rockchip-linux/u-boot.git#b14196eade471bbc000c368f8555f2a2a1ecc17d
  defconfig: rk3576_defconfig
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

**A realistic script set** — the clearest demonstration of [lifecycle script](/bsp/concepts/lifecycle-scripts.md) hooks working together: `custom_bootloader` builds U-Boot, two `after_bootloader` scripts convert the splash logo to BMP and package `idbloader.img`, a `before_bundle` script installs boot assets into the rootfs, and `make_image` produces the final disk image with `genimage`. Plus `flash_script_tool` / `flash_script` for [flashing over Rockchip Maskrom](/bsp/guide/flash-scripts.md).

**Runtime extensions.** The BSP ships Go packages that implement the `strux.network` and `strux.wifi` runtime APIs (backed by NetworkManager's `nmcli`):

```yaml
runtime:
  extensions:
    - path: runtime/network
    - path: runtime/wifi
```

See [runtime extensions](/bsp/guide/runtime-extensions.md) for how these get compiled into the user's app.

**Audio and connectivity packages.** Its `rootfs.packages` list pulls in PulseAudio, GStreamer plugins, ALSA utilities, NetworkManager, `wpasupplicant`, and Bluetooth tooling — a good reference for what a sound- and network-capable kiosk needs. The BSP folder also includes `AUDIO.md`, `WIFI.md`, and `BLUETOOTH.md` notes documenting the bring-up.

**A/B dual-rootfs layout.** The BSP carries two `genimage` configs and a U-Boot boot script (`boot/strux-ab-boot.cmd`); when the project enables updates, `make-image.sh` switches to the A/B partition layout.

::: warning Experimental
The dual-rootfs / A-B update layout is experimental and its design may change. See [dual rootfs](/bsp/concepts/dual-rootfs.md).
:::

Start here if: you're bringing up an ARM single-board device that needs a custom kernel, a bootloader with splash, or vendor firmware blobs.

## hd215-rk3288 — the older 32-bit board

Support for the original HD215 on the Rockchip RK3288 — a 32-bit ARM SoC (`arch: armhf`) with a 1920x1080 eDP display. It predates the newer BSPs (no flash scripts, no runtime extensions) but earns its place in two ways:

**It proves the 32-bit path.** Everything the arm64 boards do — custom kernel from Rockchip's tree, vendor U-Boot, splash logo, `genimage` — working on `armhf`.

**Its README is a bootloader war story.** The vendor U-Boot needed here is a 2017-era fork, and the README documents the traps in detail: the kernel DTS must delete the inherited `bootargs` so extlinux's `append` line wins, the fork doesn't auto-include `*-u-boot.dtsi` companions, `idbloader.img` must be hand-assembled with `mkimage`, and the kernel performs a "loader protect" display handover from U-Boot. It also shows the `device_tree.dtsi` key for explicitly shipping a companion DTSI:

```yaml
device_tree:
  dts: ./dts/rk3288-hd215-uboot-rockchip.dts
  dtsi:
    - ./dts/rk3288-hd215-uboot-rockchip-u-boot.dtsi
```

Start here if: you target a 32-bit ARM board, or you're fighting an old vendor U-Boot and want to read how someone else won.

## Where to go next

- [Writing a BSP](/bsp/guide/writing-a-bsp.md) — build your own, step by step.
- [Kernel](/bsp/guide/kernel.md) and [bootloader](/bsp/guide/bootloader.md) — the two big subsystems these examples configure.
- [bsp.yaml reference](/bsp/reference/bsp-yaml.md) — every key used in the snippets above.
