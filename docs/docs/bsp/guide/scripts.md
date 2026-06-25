# Writing Lifecycle Scripts

Lifecycle scripts are how your BSP does board-specific work the generic build pipeline can't: assembling the final disk image, patching kernel sources, converting a splash logo for U-Boot. This page walks you through writing one — picking the right hook, declaring caching so it doesn't re-run needlessly, and debugging it when it fails. For the underlying model, read [lifecycle scripts](/bsp/concepts/lifecycle-scripts.md) first.

## Where scripts live

By convention, scripts go in a `scripts/` folder inside your BSP directory and are registered in `bsp.yaml` under `bsp.scripts`:

```txt
bsp/my-board/
├── bsp.yaml
└── scripts/
    └── make-image.sh
```

```yaml
scripts:
  - location: ./scripts/make-image.sh    # path relative to the BSP directory
    step: make_image                     # which hook to run at
    description: "Create disk image"     # optional, shown in build logs
```

Every build, Strux runs the scripts registered for each hook at the right moment in the pipeline, inside the `strux-builder` Docker container with your project mounted at `/project`. Multiple scripts on the same hook run in the order they appear in `bsp.yaml`.

## 1. Write the script

Here is the skeleton every real Strux BSP script uses — fail fast, report where you failed, and emit progress the CLI can display:

```bash
#!/bin/bash
set -eo pipefail

# Print the failing command and line on any error
trap 'echo "Error: Command failed at line $LINENO with exit code $?: $BASH_COMMAND" >&2' ERR

# Lines prefixed with "STRUX_PROGRESS: " update the build spinner
progress() {
    echo "STRUX_PROGRESS: $1"
}

progress "Doing board-specific work..."

# Use the env vars Strux provides — never hardcode paths
# PROJECT_FOLDER              = /project (your project, mounted in Docker)
# PROJECT_DIST_CACHE_FOLDER   = /project/dist/cache/{bsp}
# PROJECT_DIST_OUTPUT_FOLDER  = /project/dist/output/{bsp}
# BSP_FOLDER                  = /project/bsp/{bsp}

mkdir -p "$PROJECT_DIST_CACHE_FOLDER"
```

::: tip Why the env vars matter
The script runs inside Docker, where your project lives at `/project` — paths from your host machine don't exist there. `BSP_NAME`, `TARGET_ARCH`, `STEP`, and friends are also set so one script can serve several boards. The full list is in the [environment variables reference](/bsp/reference/environment-variables.md).
:::

Two progress marker formats are recognized in your script's output:

- `STRUX_PROGRESS: message` — replaces the spinner text.
- `STRUX_PROGRESS_BAR: message (42%)` — renders a progress bar (the HD215 flash script uses this to surface `rkdeveloptool`'s percentage output).

Everything else your script prints is hidden behind the spinner unless the script fails or you run with `--verbose`.

## 2. Choose a step

Ask: *what does my script need to exist, and what consumes its output?* Then pick the hook between those two points. Some real choices from the BSPs in the Strux repo:

| You want to... | Step | Real example |
|---|---|---|
| Patch or extend kernel sources before they compile | `after_kernel_extract` | HT109 installs vendor touchscreen/audio/NFC drivers into the kernel tree |
| Build a vendor bootloader fork yourself | `custom_bootloader` | HD215 builds Rockchip's U-Boot fork (the built-in build is replaced) |
| Post-process bootloader output | `after_bootloader` | HD215 converts the splash PNG to BMP and packages `idbloader.img` |
| Install files into the finished rootfs | `before_bundle` | HD215 installs `extlinux.conf` and boot assets into the rootfs tarball |
| Produce the final disk image | `make_image` | Every BSP — qemu makes a raw ext4, the Rockchip boards run `genimage` |
| Flash the image to hardware | `flash_script` | Runs on the host via `strux flash`, see [flash scripts](/bsp/guide/flash-scripts.md) |

The complete hook list in execution order is in the [build steps reference](/bsp/reference/build-steps.md). Remember that kernel hooks only fire when `boot.kernel.custom_kernel: true`, and bootloader hooks only when `boot.bootloader.enabled: true`.

## 3. Declare caching

Without caching declarations, your script runs on **every** build. That's fine for cheap scripts, but a 10-minute U-Boot build needs to be skipped when nothing changed. Declare what the script produces and what it reads:

```yaml
- location: ./scripts/build-bootloader-rockchip.sh
  step: custom_bootloader
  description: "Build Rockchip vendor U-Boot"
  cached_generated_artifacts:        # skip the script if these all exist...
    - cache/bootloader/u-boot.bin
    - cache/bootloader/idbloader.img
  depends_on:                        # ...and none of these changed
    - ./dts/rk3576-hd215-uboot.dts
    - ./blobs/rk3576_bl31_v1.20.elf
    - cache/kernel/rk3576-hd215-linux.dtb
```

The rules, in the order Strux checks them:

1. `--clean` forces every script to run (and wipes `dist/cache/{bsp}/` first).
2. No `cached_generated_artifacts` declared → the script always runs.
3. Any declared artifact missing → run.
4. The script file itself changed (SHA256 hash) → run. You never list the script in its own `depends_on`.
5. Any `depends_on` file changed, missing, or not seen before → run.

Paths use a prefix convention: `cache/` → `dist/cache/{bsp}/`, `output/` → `dist/output/{bsp}/`, `./` → the BSP directory, anything else → `dist/`. Details in the [path resolution reference](/bsp/reference/path-resolution.md).

Getting this right is mostly about honesty:

- **List every input.** If your script reads a DTS file, a blob, a config under `./boot/`, or another script's output from `cache/`, list it. An unlisted input means stale builds — the script gets skipped when it shouldn't be.
- **List real outputs.** Only declare files the script reliably writes; if one is ever missing, the script just re-runs.
- **Depend on upstream outputs to chain scripts.** The HD215 `package-rockchip.sh` script depends on `cache/bootloader/spl/u-boot-spl.bin`, so it re-runs exactly when the bootloader build produced a new SPL.
- **Files, not directories.** `depends_on` entries are hashed as single files; a directory can't be hashed and forces the script to run every build.

## 4. Run and debug

Run a build and watch for your script's description in the output:

```bash
strux build my-board
```

A script that runs logs `Running BSP script: <description> (<step>)...` and, on success, `Completed BSP script: <description>`. A skipped script logs `Skipping script: <description>`.

When a script **fails** (any non-zero exit code), the build aborts and prints the script's stderr and stdout. The `trap ... ERR` line from the skeleton makes sure the very first failing command and its line number appear in that output — put it in every script.

To see everything live, use the global `--verbose` flag:

```bash
strux --verbose build my-board
```

Verbose mode streams the full output of every script (and every built-in step) as it runs instead of hiding it behind a spinner, and prints cache decisions — including why a script was *not* skipped (changed dependency, missing artifact, edited script).

Other debugging tactics that work well:

- **Force a re-run** by touching the script file — its hash is part of the cache key — or by building with `--clean` (slower: it invalidates the whole BSP cache).
- **Check the right hook fired.** Each script's log line shows the step name in parentheses; `STEP` is also exported into the script's environment.
- **Inspect intermediate state** under `dist/cache/{bsp}/` on the host after a failed run — the rootfs tarballs, kernel artifacts, and whatever your script wrote are all there. Note that paths inside the script are container paths: `/project/dist/...` in the script is `dist/...` in your project.
- **Missing script file?** Strux aborts immediately with `Script ... not found` — check the `location` path is relative to the BSP directory.

## Where to go next

- [Lifecycle scripts concept](/bsp/concepts/lifecycle-scripts.md) — the hook model, execution environment, and caching semantics in depth.
- [Build steps reference](/bsp/reference/build-steps.md) — every hook in exact order.
- [BSP examples](/bsp/guide/examples.md) — real scripts in real BSPs, annotated.
- [Flash scripts](/bsp/guide/flash-scripts.md) — the host-side counterpart for `strux flash`.
