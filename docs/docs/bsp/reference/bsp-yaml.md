# bsp.yaml Reference

Every key that `bsp.yaml` accepts, with types, defaults, and accepted values. The file is validated with a Zod schema when any build-related command loads the BSP — unknown values for enums and missing required keys abort the build with a validation error. For a guided walkthrough of writing one, see [Writing a BSP](/bsp/guide/writing-a-bsp.html).

## Top level

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `strux_version` | `string` | required | The Strux version this BSP was written for, e.g. `"0.3.0"`. |
| `bsp` | `object` | required | The BSP configuration. All remaining keys on this page live under `bsp`. |

## bsp

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | required | BSP name. Should match the folder name under `bsp/`. |
| `description` | `string` | required | Human-readable description of the board. |
| `arch` | `string` | required | Target CPU architecture. Accepted values: `host` (resolves to the build machine's architecture), `arm64` / `aarch64`, `x86_64` / `amd64`, `armhf` / `armv7` / `arm`. |
| `hostname` | `string` | required | Hostname the device gets on the network. |
| `display` | `object` | — | Display configuration. See [bsp.display](#bsp-display). |
| `cage` | `object` | — | Cage compositor options. See [bsp.cage](#bsp-cage). |
| `scripts` | `array` | — | Lifecycle scripts. See [bsp.scripts](#bsp-scripts). |
| `boot` | `object` | — | Kernel and bootloader configuration. See [bsp.boot.kernel](#bsp-boot-kernel) and [bsp.boot.bootloader](#bsp-boot-bootloader). |
| `rootfs` | `object` | — | BSP-specific root filesystem additions. See [bsp.rootfs](#bsp-rootfs). |
| `runtime` | `object` | — | Runtime API compatibility and extensions. See [bsp.runtime](#bsp-runtime). |

## bsp.display

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `resolution` | `string` | required (if `display` is set) | Display resolution as `WIDTHxHEIGHT`, e.g. `1920x1080`. Strux splits it into width and height, writes a display config into the image, and exposes both to lifecycle scripts as `DISPLAY_WIDTH` / `DISPLAY_HEIGHT`. |

## bsp.cage

Options for Cage, the Wayland compositor that shows your app full-screen.

::: tip What is a Wayland compositor?
The Linux component that puts windows on a screen. Cage is a tiny one: it runs a single app full-screen and nothing else.
:::

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `env` | `string[]` | — | Environment variables (as `KEY=value` strings) set for the Cage process on the device. Commonly wlroots tuning flags like `WLR_DRM_NO_MODIFIERS=1`. |
| `hide_cursor` | `boolean` | — | Hide the mouse cursor — what you usually want on a touchscreen kiosk. |

## bsp.scripts

A list of script entries that hook into the [build pipeline](/bsp/reference/build-steps.html). Each entry:

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `location` | `string` | required | Path to the script, relative to the BSP directory (with or without a leading `./`). |
| `step` | `enum` | required | Which build step to run at. See the [valid steps](#valid-step-values) below. |
| `cached_generated_artifacts` | `string[]` | — | Files the script generates. If all exist and nothing changed, the script is skipped. See [Path Resolution](/bsp/reference/path-resolution.html). |
| `depends_on` | `string[]` | — | Files the script depends on. If any file's hash changes, the script re-runs. See [Path Resolution](/bsp/reference/path-resolution.html). |
| `description` | `string` | — | Human-readable name shown in build logs. |

### Valid step values

`before_build`, `after_build`, `before_frontend`, `after_frontend`, `before_application`, `after_application`, `before_cage`, `after_cage`, `before_wpe`, `after_wpe`, `before_client`, `after_client`, `before_kernel`, `after_kernel_extract`, `after_kernel`, `custom_kernel`, `before_bootloader`, `after_bootloader`, `custom_bootloader`, `before_rootfs`, `after_rootfs`, `before_bundle`, `make_image`, `flash_script_tool`, `flash_script`.

When each one fires — and which are conditional — is covered in [Build Steps & Lifecycle Hooks](/bsp/reference/build-steps.html). How to write the scripts themselves is covered in the [Scripts guide](/bsp/guide/scripts.html) and [Lifecycle Scripts](/bsp/concepts/lifecycle-scripts.html).

## bsp.boot.kernel

Custom kernel configuration. See the [Kernel guide](/bsp/guide/kernel.html) for a walkthrough.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `custom_kernel` | `boolean` | required (if `kernel` is set) | `true` builds a custom kernel from source; `false` uses the Debian distribution kernel and skips the kernel step entirely. |
| `source` | `string` | — | Where to fetch the kernel: a Git repository (optionally with `#branch-or-commit`) or a tarball URL. |
| `version` | `string` | — | Kernel version, e.g. `"6.1"`. |
| `defconfig` | `string` | — | Kernel defconfig to start from, e.g. `rockchip_linux_defconfig`. |
| `fragments` | `string[]` | — | Config fragments applied on top of the defconfig. Each entry is either a file path or an inline multi-line string of `CONFIG_*` options. |
| `patches` | `string[]` | — | Patch files applied to the kernel source after fetching. |
| `device_tree` | `object` | — | Device tree configuration. See below. |

::: tip What is a defconfig / device tree?
A **defconfig** is a saved set of kernel build options for a board family. A **device tree** is a data file (`.dts`) describing the hardware on the board — which peripherals exist and where — that the kernel reads at boot.
:::

### bsp.boot.kernel.device_tree

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `dts` | `string \| string[]` | required (if `device_tree` is set) | Primary DTS file(s). A bare filename is searched in the kernel's `arch/*/boot/dts/`; a path (e.g. `./dts/board.dts`) is treated as an external file. |
| `overlays` | `string[]` | — | Device tree overlay (`.dtso`) files applied on top of the base device tree. |
| `include_paths` | `string[]` | — | Extra include directories for DTS compilation. |

## bsp.boot.bootloader

Bootloader configuration. See the [Bootloader guide](/bsp/guide/bootloader.html) for a walkthrough.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | required (if `bootloader` is set) | `false` skips the bootloader step entirely (QEMU boots without one). `true` enables it. |
| `type` | `enum` | — | One of `grub`, `u-boot`, `systemd-boot`, `custom`, `none`. The built-in bootloader build only runs for `grub`, `u-boot`, and `systemd-boot`; `custom` and `none` (or leaving it unset) skip the built-in build, so your `custom_bootloader` / hook scripts do the work. |
| `version` | `string` | — | Bootloader version to fetch, e.g. `"2025.10"`. |
| `source` | `string` | — | Where to fetch it: a Git repository (optionally with `#branch-or-commit`) or a tarball URL. |
| `defconfig` | `string` | — | Bootloader defconfig, e.g. `rk3576_defconfig`. |
| `fragments` | `string[]` | — | Config fragments — file paths or inline multi-line `CONFIG_*` strings. |
| `patches` | `string[]` | — | Patch files applied to the bootloader source. |
| `device_tree` | `object` | — | Bootloader device tree. See below. |
| `boot_method` | `enum` | — | How the bootloader loads the kernel: `extlinux`, `script`, or `direct`. |
| `boot_config` | `string` | — | Path to a boot config template (e.g. an `extlinux.conf`), relative to the BSP directory. |
| `blobs` | `array` | — | Vendor firmware blobs for early boot. See below. |

### bsp.boot.bootloader.device_tree

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `dts` | `string \| string[]` | required (if `device_tree` is set) | Primary DTS file(s) to compile for the bootloader. |
| `dtsi` | `string \| string[]` | — | DTSI include files copied alongside the DTS files. |
| `include_paths` | `string[]` | — | Extra include directories for DTS compilation. |
| `standalone` | `boolean` | — | `true` marks the DTS as self-contained (no includes — e.g. extracted from a running system). It is compiled externally with `dtc` and passed to the bootloader build via `EXT_DTB`. |

### bsp.boot.bootloader.blobs

Firmware blobs are pre-built vendor binaries (DDR init, ARM Trusted Firmware, TEE, …) required early in the boot chain on many SoCs.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | `string` | required | Identifier for the blob, e.g. `ddr`, `bl31`. |
| `role` | `string` | required | What the blob is for. Free-form; conventional roles include `ddr_init`, `miniloader`, `bl31`, `bl32`, `bl33`, `pmic_fw`, `mcu_fw`, `usbplug`. |
| `path` | `string` | required | Path to the blob file, relative to the BSP directory. |
| `required` | `boolean` | — | If `true`, the build fails when the blob is missing. |
| `sha256` | `string` | — | Expected SHA256 checksum of the blob. |
| `make_var` | `string` | — | Make variable the blob is passed as during the bootloader build, e.g. `BL31`, `TEE`. |

## bsp.rootfs

BSP-specific additions to the root filesystem (the Linux filesystem the device boots from).

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `overlay` | `string` | — | Folder whose contents are copied verbatim into the root filesystem, e.g. `./overlay`. Merged with the project-level overlay from `strux.yaml`. |
| `packages` | `string[]` | — | Debian packages to install (names or paths to `.deb` files). Board-specific packages — firmware, drivers, tools — belong here rather than in `strux.yaml`. |

See [Customizing the OS](/guide/customizing-the-os.html) for the project-level counterparts.

## bsp.runtime

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `compatible_strux_api` | `string \| string[]` | — | Strux runtime API version(s) this BSP has been tested with, as `major.minor` strings (e.g. `"0.3"`). When set, Strux compares it against the runtime version in the project's `go.mod` and aborts the build on a mismatch. Unset skips the check. |
| `extensions` | `array` | — | Go runtime extensions this BSP adds to the device API. See below. |

### bsp.runtime.extensions

Each entry registers a Go package that extends the device runtime API — see [Runtime Extensions](/bsp/guide/runtime-extensions.html) and the [Extension System](/bsp/concepts/extension-system.html).

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | — | Local path to the Go package, resolved from the BSP directory (e.g. `runtime/wifi`). |
| `import` | `string` | — | Explicit Go import path. If omitted for an in-project `path`, Strux derives it from the module path in the project's `go.mod`. |

At least one of `path` or `import` is required per entry — the schema rejects an empty object.

## Annotated example

A condensed version of a real BSP for a Rockchip RK3576 board (`test/bsp/hd215-rk3576/bsp.yaml` in the Strux repository):

```yaml
strux_version: 0.3.0
bsp:
  name: hd215-rk3576
  description: "Medeiros IT HD215 RK3576 Board"
  arch: arm64
  hostname: test

  display:
    resolution: 1920x1080

  cage:
    hide_cursor: true            # Touchscreen kiosk - no mouse cursor
    env:
      - WLR_DRM_NO_MODIFIERS=1   # wlroots flag needed by this SoC's display driver

  scripts:
    # Replaces the built-in bootloader build with a vendor U-Boot build
    - location: ./scripts/build-bootloader-rockchip.sh
      step: custom_bootloader
      description: "Build Rockchip vendor U-Boot for HD215"
      cached_generated_artifacts:
        - cache/bootloader/u-boot.bin          # -> dist/cache/hd215-rk3576/bootloader/u-boot.bin
        - cache/bootloader/idbloader.img
      depends_on:
        - ./dts/rk3288-hd215-uboot-rockchip.dts  # -> bsp/hd215-rk3576/dts/...
        - cache/kernel/rk3576-hd215-linux.dtb

    # Hook: convert the splash PNG to BMP after the bootloader is built
    - location: ./scripts/install-boot-logo.sh
      step: after_bootloader
      description: "Convert splash logo to BMP for U-Boot"

    # Required for any flashable image: produce the final disk image
    - location: ./scripts/make-image.sh
      step: make_image
      description: "Create RK3576 disk image using genimage"
      depends_on:
        - cache/rootfs-post.tar.gz
        - cache/bootloader/idbloader.img
        - ./image/hd215-rk3576.genimage.cfg

    # Host-side scripts run by `strux flash`, not during build
    - location: ./scripts/prepare-rkdeveloptool.sh
      step: flash_script_tool
      description: "Prepare rkdeveloptool for HD215 flashing"
    - location: ./scripts/flash-rk3576.sh
      step: flash_script
      description: "Flash HD215 RK3576 eMMC over Rockchip Maskrom"

  boot:
    bootloader:
      enabled: true
      type: custom               # Skip the built-in build; custom_bootloader script does it
      version: "2017.09"
      source: https://github.com/rockchip-linux/u-boot.git#b14196eade471bbc000c368f8555f2a2a1ecc17d
      defconfig: rk3576_defconfig
      device_tree:
        dts: ./dts/rk3576-hd215-uboot.dts
      patches:
        - ./patches/uboot-rockchip-strux-bootcmd.diff
      boot_method: extlinux
      boot_config: ./boot/extlinux.conf
      fragments:
        - |                      # Inline fragment: splash screen support
          CONFIG_CMD_BMP=y
          CONFIG_SPLASH_SCREEN=y
          CONFIG_SPLASH_SCREEN_ALIGN=y
      blobs:                     # Vendor firmware needed before U-Boot runs
        - id: ddr
          role: ddr_init
          path: ./blobs/rk3576_ddr_lp4_2112MHz_lp5_2736MHz_v1.09.bin
          required: true
        - id: bl31
          role: bl31
          path: ./blobs/rk3576_bl31_v1.20.elf
          make_var: BL31         # Passed to the U-Boot build as BL31=...
          required: true

    kernel:
      custom_kernel: true        # Build the vendor kernel instead of using Debian's
      source: https://github.com/armbian/linux-rockchip.git#rk-6.1-rkr6.1
      version: "6.1"
      defconfig: rockchip_linux_defconfig
      fragments:
        - |                      # USB gadget Ethernet for `strux dev` over USB
          CONFIG_USB_GADGET=y
          CONFIG_USB_CONFIGFS=y
          CONFIG_USB_CONFIGFS_NCM=y
      patches:
        - "./patches/kernel-aic8800-makefile-fix.patch"
      device_tree:
        dts: ./dts/rk3576-hd215-linux.dts

  runtime:
    extensions:                  # Board-specific Go APIs exposed to the frontend
      - path: runtime/network
      - path: runtime/wifi

  rootfs:
    overlay: ./overlay           # Files copied verbatim into the OS filesystem
    packages:                    # Board-specific Debian packages
      - network-manager
      - wpasupplicant
      - pulseaudio
      - bluez
```

## Related pages

- [Build Steps & Lifecycle Hooks](/bsp/reference/build-steps.html) — when each script step runs.
- [Environment Variables](/bsp/reference/environment-variables.html) — what your scripts can read.
- [Path Resolution](/bsp/reference/path-resolution.html) — how `cached_generated_artifacts` and `depends_on` paths resolve.
- [strux.yaml Reference](/reference/strux-yaml.html) — the project-level configuration file.
