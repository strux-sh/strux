# Building

`strux build` turns your project into a complete, bootable OS image. This page is the day-to-day guide: what a build actually does, how to read its output, when to reach for `--clean`, and where the results land. For the full anatomy of the pipeline, see [Build Pipeline](/concepts/build-pipeline.md).

## Running a build

```bash
strux build qemu
```

The argument is the BSP (Board Support Package — the folder under `bsp/` describing your target hardware) to build for. Use `qemu` for local testing, or the name of your hardware BSP:

```bash
strux build my-board
```

Each BSP builds independently: caches live in `dist/cache/<bsp>/` and outputs in `dist/output/<bsp>/`, so building for one board never clobbers another.

## What a build does

The pipeline runs these steps in order, each inside the `strux-builder` Docker container:

1. **frontend** — regenerates the typed API bindings from your Go backend, then runs your frontend's production build (`npm run build` — Vite in the templates).
2. **application** — cross-compiles your Go backend (`main.go`) for the target architecture.
3. **cage** — builds the Cage Wayland compositor (the component that puts your app full-screen on the display).
4. **wpe** — builds the WPE WebKit browser extension and launcher.
5. **screen** — builds the remote screen streaming daemon.
6. **client** — builds the on-device Strux client binary.
7. **kernel** — fetches, configures, and compiles the Linux kernel (only if the BSP enables a custom kernel).
8. **bootloader** — builds U-Boot or GRUB (only if the BSP enables a bootloader, GRUB support is on the way).
9. **rootfs-base** — assembles the Debian root filesystem (the rootfs: the `/` directory tree the device runs from).
10. **rootfs-post** — applies your overlay, packages, and configuration on top.
11. **make_image** — the BSP's image script packs everything into a flashable disk image.

BSPs can hook scripts before and after each step — see [Lifecycle Scripts](/bsp/concepts/lifecycle-scripts.md). If `update.enabled` and `update.auto_bundle` are set in `strux.yaml`, the build also produces a signed `.struxb` [update bundle](/guide/updates.md) at the end.

## Reading the output

Each step prints either a progress line as it works or a cache notice when it's skipped:

```txt
◆ frontend (no changes detected) (cached)
◆ application (no changes detected) (cached)
◐ Building Root Filesystem
```

Long steps report progress milestones (build scripts emit `STRUX_PROGRESS:` markers that drive the spinner text). If you want the raw underlying output — every compiler line, every Docker command — add the global `--verbose` flag:

```bash
strux --verbose build qemu
```

## Caching: why the second build is fast

Strux hashes every input a step depends on — source files, directories, specific `strux.yaml`/`bsp.yaml` keys, and the bundled assets that ship inside the CLI — and stores the hashes in a manifest at `dist/cache/<bsp>/.build-cache.json`. On the next build, a step reruns only if:

- any tracked file, directory, or YAML key changed,
- one of its output artifacts is missing,
- a step it depends on was rebuilt,
- the builder Docker image changed (this invalidates everything), or
- you upgraded the Strux CLI in a way that changed that step's embedded build scripts.

So editing `main.go` rebuilds the application and the steps downstream of it — not the kernel, not the compositor. The full mechanics are on the [Caching](/concepts/caching.md) page.

You can tune the cache in `strux.yaml`:

```yaml
build:
  cache:
    enabled: true
    force_rebuild:
      - rootfs-post
    ignore_patterns:
      - "*.tmp"
```

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Disable to rebuild every step on every run |
| `force_rebuild` | string list | — | Step names that always rebuild (`frontend`, `application`, `cage`, `wpe`, `screen`, `client`, `kernel`, `bootloader`, `rootfs-base`, `rootfs-post`) |
| `ignore_patterns` | string list | — | File name patterns excluded from dependency hashing |

## When to use `--clean`

```bash
strux build qemu --clean
```

`--clean` deletes `dist/cache/<bsp>/` for the BSP you're building (other BSPs keep their caches) and rebuilds everything from scratch. Reach for it when a build behaves strangely after heavy config churn, or when you want a guaranteed-fresh image. Don't use it routinely — a clean build recompiles the browser stack and reassembles the rootfs, which is the slow first-run experience all over again.

## Dev images vs production images

```bash
strux build qemu --dev
```

`--dev` builds a **development image**: it includes the dev client configuration so the device connects to a [dev server](/guide/dev-mode.md) at boot, streams logs, and accepts pushed binaries. The CLI shows a loud warning when you build one — dev images enable remote control paths and are not hardened, so never deploy them to production.

::: warning You Might Need a Dev Image
If you're currently testing and developing your app on real hardware, you'll need to add the ```--dev``` flag so that your device works with the ```strux dev --remote``` tool! When you've finished your image and it's all ready for production, you can omit the ```--dev``` flag.
:::

A plain `strux build` produces a production image: no dev services, no remote control, the app runs from the image itself. The build mode is recorded in `dist/output/<bsp>/.build-info.json`, and [`strux run`](/guide/running-qemu.md) refuses to boot a dev image.

You normally don't run `--dev` yourself — `strux dev` builds its development image automatically. You will need to add ```--dev``` to ```strux build <bsp>``` if you plan to test on real hardware as you develop.

## Where outputs land

Everything ends up under `dist/`:

```txt
dist/
├── cache/<bsp>/             # Per-BSP build cache + intermediate artifacts
│   └── .build-cache.json    # The cache manifest
├── artifacts/               # Editable copies of Strux's build scripts and sources
└── output/<bsp>/            # Final build products
    ├── rootfs.ext4          # Root filesystem image
    ├── vmlinuz, initrd.img  # Kernel and initramfs (qemu BSP)
    ├── *.img                # Flashable disk image (hardware BSPs, named by the BSP's image script)
    └── .build-info.json     # Build mode, time, versions
```

The exact files in `output/` depend on the BSP's `make_image` script — a Rockchip board produces a single flashable `.img`, while the qemu BSP keeps kernel, initramfs, and rootfs separate for QEMU to load directly. See [Artifacts](/concepts/artifacts.md) for what lives in `dist/artifacts/` and why you might edit it.

## Command reference

| Flag | Description |
| --- | --- |
| `--clean` | Delete this BSP's build cache before building |
| `--dev` | Build a development image (with a 5-second warning banner) |
| `--no-chown` | Skip file permission fixing after builds |
| `--local-runtime <path>` | Use a local Strux repo for the Go runtime instead of the published module |

## Where to go next

- [Running in QEMU](/guide/running-qemu.md) — boot the image you just built.
- [Flashing](/guide/flashing.md) — write it to real hardware.
- [Build Pipeline](/concepts/build-pipeline.md) and [Caching](/concepts/caching.md) — the deep dives.
- [Customizing the OS](/guide/customizing-the-os.md) — packages, overlays, and system configuration.
