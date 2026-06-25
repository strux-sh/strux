# Running in QEMU

`strux run` boots your built image in QEMU — a virtual machine that emulates your target hardware — so you can see exactly what a device will do, from splash screen to app, without flashing anything. This page covers booting, debug and headless modes, configuring QEMU through `strux.yaml`, and passing real USB devices into the VM.

## Booting the image

Build for the qemu BSP, then run:

```bash
strux build qemu
strux run
```

QEMU loads the kernel, initramfs, and root filesystem from your `dist/` folder and a window opens showing the boot: your splash logo, then your app full-screen. The window matches the resolution from your display configuration, and if `strux.yaml` defines multiple monitors, QEMU creates one virtual output per monitor.

`strux run` picks the right QEMU binary for your target architecture (`qemu-system-x86_64`, `qemu-system-aarch64`, or `qemu-system-arm`) and uses hardware acceleration when the host supports it — HVF on macOS, KVM on Linux for x86_64. On Linux, GL acceleration is auto-enabled for Intel and AMD GPUs; NVIDIA and unknown GPUs use software rendering (set `STRUX_GL=1` to force GL on).

::: warning Production images only
`strux run` refuses to boot a development image (one built with `--dev` or by `strux dev`) — those expect a dev server to connect to. Rebuild without `--dev`, or use [`strux dev`](/guide/dev-mode.md) for the live development loop.
:::

Press `Ctrl-C` in the terminal to stop the VM.

## Debug and headless modes

| Flag | Description |
| --- | --- |
| `--debug` | Show the kernel console and systemd messages in your terminal during boot, instead of the quiet splash |
| `--headless` | Run without opening a host display window (the guest still has a virtual GPU and renders normally) |

`--debug` is the first thing to reach for when an image doesn't boot to your app: it replaces the silent splash boot with the full console stream, so you can see which service failed.

```bash
strux run --debug
```

`--headless` is useful on CI machines or over SSH, where there's no display to open a window on.

## Configuring QEMU in strux.yaml

The `qemu` section of `strux.yaml` controls the VM:

```yaml
qemu:
  enabled: true
  network: true
  flags:
    - -m 2G
  # usb:
  #   - vendor_id: "1234"
  #     product_id: "5678"
```

**Memory and custom flags.** The VM gets 2048 MB of RAM by default. `qemu.flags` is a list of extra QEMU command-line flags appended to the launch command — and if a custom flag matches a built-in one (like `-m`), the built-in is removed so yours wins. So `- -m 4G` raises memory to 4 GB. Any QEMU flag works here; each list entry is split on whitespace into flag and value.

**Networking.** The VM uses QEMU user-mode networking with a virtio network card — the guest gets outbound network access through your machine without any host network configuration. From inside the guest, your host machine is reachable at `10.0.2.2` (QEMU's built-in gateway address). When the image runs under [dev mode](/guide/dev-mode.md) with the WebKit inspector enabled, the inspector ports are additionally forwarded from your host into the guest.

## USB passthrough

You can hand real USB devices on your machine — a barcode scanner, a serial adapter, a touch controller — through to the VM, so the guest sees them as if they were plugged into the device.

Devices are listed in `strux.yaml` under `qemu.usb` as vendor/product ID pairs (the 4-hex-digit identifiers every USB device carries). You don't have to find those IDs yourself — let `strux usb` do it:

```bash
strux usb add
```

This detects the USB devices currently connected to your machine and shows an interactive checklist (already-configured devices appear pre-selected). Toggle the ones you want and confirm; `strux.yaml` is updated for you:

```yaml
qemu:
  enabled: true
  network: true
  usb:
    - vendor_id: "0c2e"
      product_id: "0b81"
```

To review or remove configured devices later:

```bash
strux usb list
```

It prints the configured devices and offers an interactive removal prompt. (`strux usb` on its own is a shortcut for `strux usb add`.)

On the next `strux run`, the configured devices are attached to the VM. On Linux this uses QEMU's `usb-host` device directly. On macOS it uses `usbredir` (a USB-over-socket protocol), which requires a QEMU built with usbredir support — `strux run` checks and tells you if yours isn't.

::: tip Device busy?
If passthrough fails, make sure nothing on the host has claimed the device exclusively — close any app that's actively using it and run again.
:::

## Where to go next

- [Dev Mode](/guide/dev-mode.md) — don't rebuild-and-run by hand; get hot reload in the same VM.
- [Flashing](/guide/flashing.md) — when QEMU looks right, put the image on hardware.
- [strux.yaml reference](/reference/strux-yaml.md) — every key in the `qemu` section and beyond.
