# Flash Scripts

`strux flash` gets a built image onto real hardware — over USB, onto an SD card, however your board is programmed. Strux doesn't know how to flash your board; your BSP provides a script that does, and `strux flash` runs it **on your machine** (not in Docker) so it can reach USB ports and card readers. This page shows how the mechanism works and how to write a flash script, using the HD215 RK3576 board as the real example.

## How `strux flash` works

```bash
strux flash              # uses the BSP from strux.yaml's `bsp` field
strux flash my-board     # or name one explicitly
```

When you run it, Strux:

1. Loads `strux.yaml` and the BSP's `bsp.yaml`.
2. Creates a flash workspace at `dist/flash/{bsp}/` and prints its path.
3. Runs every script registered with `step: flash_script_tool`, in order — a preparation hook for fetching or locating flashing tools.
4. Runs every script registered with `step: flash_script`, in order — the actual flashing.

If the BSP defines no `flash_script`, the command fails with `Not Available for this BSP` — the qemu BSP, for example, has nothing to flash (you [run it in QEMU](/guide/running-qemu.html) instead).

Each script is executed with `/bin/bash` **on the host**, with the flash workspace as its working directory. Unlike [build-time lifecycle scripts](/bsp/concepts/lifecycle-scripts.html), there is no Docker container and no caching — flash scripts run every time, and all the path environment variables contain real host paths instead of `/project/...` container paths.

::: tip Host tools are your responsibility
Because flash scripts run outside Docker, any tool they call (`rkdeveloptool`, `dd`, vendor flashers) must be installed on the developer's machine. Good flash scripts check for their tools and print an actionable error — that's exactly what the `flash_script_tool` hook is for.
:::

### Environment

The same context variables as build scripts (`BSP_NAME`, `HOST_ARCH`, `TARGET_ARCH`, `STEP`, `STRUX_VERSION`, splash and display settings), plus host-path variables:

| Variable | Value |
|---|---|
| `PROJECT_FOLDER` / `PROJECT_DIR` | Project root on the host |
| `PROJECT_DIST_OUTPUT_FOLDER` | `dist/output/{bsp}/` — where your built image lives |
| `PROJECT_DIST_CACHE_FOLDER` / `BSP_CACHE_DIR` | `dist/cache/{bsp}/` |
| `FLASH_DIR` / `PROJECT_DIST_FLASH_FOLDER` | `dist/flash/{bsp}/` — the workspace, also the working directory |
| `BSP_FOLDER` | `bsp/{bsp}/` — your blobs, configs, and scripts |

The full list is in the [environment variables reference](/bsp/reference/environment-variables.html).

Output is streamed through the same progress system as the build: `STRUX_PROGRESS: message` lines update the status, and `STRUX_PROGRESS_BAR: message (42%)` lines render a progress bar. Run with the global `--verbose` flag to see raw output instead.

## A real example: flashing the HD215 over USB

Rockchip SoCs are flashed over USB in **Maskrom mode** — a built-in ROM bootloader the chip falls back to when its storage is empty (or when you hold the recovery button), which accepts commands from the `rkdeveloptool` utility. The HD215 BSP splits the job across both hooks:

```yaml
scripts:
  - location: ./scripts/prepare-rkdeveloptool.sh
    step: flash_script_tool
    description: "Prepare rkdeveloptool for HD215 flashing"

  - location: ./scripts/flash-rk3576.sh
    step: flash_script
    description: "Flash HD215 RK3576 eMMC over Rockchip Maskrom"
```

**The tool script** locates `rkdeveloptool` on the host (checking `$PATH`, then Homebrew and system locations, then an `RKDEVELOPTOOL` override variable), symlinks it into `$FLASH_DIR/tools/`, and copies the board's SPL loader blob from the BSP folder next to it. If the tool can't be found, it fails with instructions:

```bash
if [ -z "$RKDEVELOPTOOL_BIN" ] || [ ! -x "$RKDEVELOPTOOL_BIN" ]; then
    echo "Error: rkdeveloptool was not found." >&2
    echo "Install rkdeveloptool on the host, or set RKDEVELOPTOOL=/path/to/rkdeveloptool before running strux flash." >&2
    exit 1
fi
```

**The flash script** then validates its inputs, waits for the device, and writes the image:

```bash
IMAGE_PATH="$PROJECT_DIST_OUTPUT_FOLDER/strux-hd215-rk3576.img"

if [ ! -f "$IMAGE_PATH" ]; then
    echo "Error: image not found: $IMAGE_PATH" >&2
    echo "Build the HD215 image first so strux-hd215-rk3576.img exists under dist/output/$BSP_NAME." >&2
    exit 1
fi

progress "Trying to find HD215-RK3576"

# Poll `rkdeveloptool ld` until a device in Maskrom mode appears
while true; do
    if ld_output="$("$RKDEVELOPTOOL" ld 2>&1)"; then ld_status=0; else ld_status="$?"; fi
    if [ "$ld_status" -eq 0 ] && printf "%s\n" "$ld_output" | grep -qi "Maskrom"; then
        break
    fi
    sleep 1
done
```

After the device shows up it downloads the SPL loader (`rkdeveloptool db`), erases the eMMC (`ef`), and writes the image (`wl 0`), translating `rkdeveloptool`'s percentage output into `STRUX_PROGRESS_BAR` lines so the CLI shows a live progress bar. Any failing step exits non-zero, which makes `strux flash` report the failure.

Patterns worth copying from this script:

- `set -eo pipefail` plus an `ERR` trap that prints the failing line.
- Validate every input (tool, loader blob, image) with a clear error message *before* touching the device.
- Wait for the device in a loop instead of failing if it isn't connected yet — the user can plug it in after starting the command.
- Verify expected tool output (the script greps for `Downloading bootloader succeeded.`) instead of trusting exit codes alone.

## Writing one for your board

For boards flashed from an SD card or USB mass storage rather than a vendor protocol, the script typically writes the image from `$PROJECT_DIST_OUTPUT_FOLDER` to a block device with `dd` or a similar tool. Whatever the mechanism:

1. Put the script in your BSP's `scripts/` folder and register it with `step: flash_script`.
2. If it needs tooling that may not be installed, add a `flash_script_tool` script that finds or prepares it and fails helpfully.
3. Read the image from `$PROJECT_DIST_OUTPUT_FOLDER`; keep temporary files in `$FLASH_DIR`.
4. Exit non-zero on any failure — `strux flash` treats the exit code as the result.

::: danger Choose the target device carefully
A flash script runs with your user's privileges on your real machine, and writing an image to the wrong block device destroys that disk. Never hardcode a device path like `/dev/sda` — that's somebody's system drive. Require the user to pass the device explicitly (for example via an environment variable), verify it looks like a removable device before writing, and print exactly what you're about to overwrite. Vendor protocols like Rockchip Maskrom are safer in this respect: `rkdeveloptool` only talks to a chip that is deliberately in flashing mode.
:::

## Where to go next

- [Flashing guide](/guide/flashing.html) — the app-developer view of `strux flash`.
- [Lifecycle scripts](/bsp/concepts/lifecycle-scripts.html) — how the build-time scripts differ from flash scripts.
- [BSP examples](/bsp/guide/examples.html) — the HD215 and HT109 BSPs both ship complete flash scripts to copy.
