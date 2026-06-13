# Flashing

Flashing is the step where your built image leaves your laptop and lands on real hardware — written to a board's eMMC (built-in flash storage), an SD card, or whatever your board boots from. This page explains what `strux flash` does, what a real flash flow looks like, and what to do if your board doesn't have one yet.

## What `strux flash` does

```bash
strux flash my-board
```

`strux flash` runs the **flash scripts defined by your BSP** (Board Support Package — the folder under `bsp/` describing your hardware). Every board is flashed differently — Rockchip boards use a USB recovery mode, others want an image `dd`'d to an SD card — so Strux doesn't hardcode a flashing method. Instead, the BSP declares scripts in its `bsp.yaml`, and `strux flash` executes them **on your host machine** (not inside Docker, since they need direct access to your USB ports and card readers).

If you omit the BSP name, the `bsp` field from `strux.yaml` is used:

```bash
strux flash
```

Two kinds of scripts run, in order:

1. **`flash_script_tool`** scripts — preparation: locate or set up the host-side flashing tool the board needs.
2. **`flash_script`** scripts — the actual flash: talk to the board and write the image.

The scripts run with a working directory of `dist/flash/<bsp>/` (created for you — a scratch space for tools and temporary files) and receive the standard Strux environment variables, including `PROJECT_DIST_OUTPUT_FOLDER` (where the built image lives), `FLASH_DIR`, `BSP_FOLDER`, `BSP_NAME`, and `TARGET_ARCH`. The full list is in the [environment variables reference](/bsp/reference/environment-variables.html).

::: tip Build first
`strux flash` doesn't build anything — it expects the image to already exist in `dist/output/<bsp>/`. Run [`strux build`](/guide/building.html) first; the flash script will tell you if the image is missing.
:::

You can also trigger a flash from inside [dev mode](/guide/dev-mode.html): the TUI shows a **Flash** entry (and a "Flash Device" action in the config panel) whenever the active BSP defines a `flash_script`, with the script's output streamed into its own log tab.

## A real example: Rockchip RK3576

Here's how a real BSP wires this up. A Rockchip RK3576 board flashes over USB using **Maskrom mode** — a recovery mode baked into the chip where it waits for a host tool (`rkdeveloptool`) to send it a bootloader and an image. The BSP declares both script kinds in `bsp.yaml`:

```yaml
  scripts:
    - location: ./scripts/prepare-rkdeveloptool.sh
      step: flash_script_tool
      description: "Prepare rkdeveloptool for HD215 flashing"

    - location: ./scripts/flash-rk3576.sh
      step: flash_script
      description: "Flash HD215 RK3576 eMMC over Rockchip Maskrom"
```

Running `strux flash hd215-rk3576` then looks like this:

1. **Tool preparation** — `prepare-rkdeveloptool.sh` finds `rkdeveloptool` on your machine (checking your `PATH` and common install locations) and copies the board's SPL loader blob from the BSP folder into `dist/flash/hd215-rk3576/tools/`.
2. **Wait for the board** — `flash-rk3576.sh` polls until it sees a device in Maskrom mode. This is when you connect the board over USB and put it into recovery mode.
3. **Flash** — the script sends the loader to enter flash mode, erases the eMMC, and writes `dist/output/hd215-rk3576/strux-hd215-rk3576.img` to the board, reporting percentage progress as it goes.

```txt
◐ Trying to find HD215-RK3576
◐ Entering Flash Mode
◐ Erasing Flash
▰ Flashing Image (42%)
◐ HD215-RK3576 flash completed
```

Flash scripts report progress by printing `STRUX_PROGRESS:` and `STRUX_PROGRESS_BAR:` markers, which the CLI renders as the spinner and progress bar above.

When the script finishes, power-cycle the board: it boots your image — splash logo, then your app.

## If your BSP has no flash script

`strux flash` exits with an error if the BSP doesn't define a `flash_script`:

```txt
Not Available for this BSP: my-board does not define a flash_script in bsp.yaml.
```

That just means nobody has written one for this board yet. Two options:

- **Flash manually.** The built image is a regular file in `dist/output/<bsp>/` — if your board boots from an SD card, writing the image with `dd` or a tool like balenaEtcher works fine.
- **Write a flash script.** It's an ordinary bash script plus two lines of `bsp.yaml` — the [flash scripts guide](/bsp/guide/flash-scripts.html) walks through writing one, with the conventions for tool preparation, progress markers, and error handling.

## Where to go next

- [Flash Scripts](/bsp/guide/flash-scripts.html) — write a flash script for your board.
- [Dev Mode](/guide/dev-mode.html) — flash a development image, then develop against the real device with `strux dev --remote`.
- [Updates](/guide/updates.html) — after the first flash, ship new versions over the network instead of re-flashing.
