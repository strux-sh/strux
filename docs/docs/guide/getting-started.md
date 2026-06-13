# Getting Started

This page takes you from nothing to a Strux OS image booting in a virtual machine. You'll scaffold a project, start the live dev environment, and build a complete OS image. Expect the first build to take a while (it compiles a browser stack and assembles a Linux root filesystem); everything after that is fast thanks to the build cache.

## Prerequisites

You need the `strux` CLI and Docker installed — see [Installation](/guide/installation.html). QEMU is required for running the image locally.

## 1. Create a project

```bash
strux init my-kiosk --template react --arch arm64
cd my-kiosk
```

- `--template` picks your frontend: `vanilla`, `react`, or `vue`.
- `--arch` picks the target CPU architecture: `host` (same as your machine — fastest for trying things out), `arm64`, `x86_64`, or `armhf`.

::: tip Which arch should I pick?
If you're just exploring, use `host` — emulation is much faster when the target matches your machine. If you already know your hardware (most ARM single-board computers are `arm64`), pick its architecture now so QEMU testing matches the real device.
:::

You get a complete, working project:

```txt
my-kiosk/
├── strux.yaml          # Project configuration
├── main.go             # Go backend entry point
├── frontend/           # Your web app (React in this case)
├── bsp/
│   └── qemu/           # Board profile for local testing — don't delete it
├── assets/             # Logo and static assets
└── overlay/            # Files copied verbatim into the OS filesystem
```

::: warning Keep the qemu BSP
The `bsp/qemu/` folder is what lets `strux dev` and `strux run` work on your machine. Add BSPs for real hardware alongside it; never remove it.
:::

## 2. Start dev mode

```bash
strux dev
```

This is where you'll spend most of your time. Strux builds a development image, boots it in QEMU, and opens a terminal UI. From here:

- Edit anything in `frontend/` — the page hot-reloads instantly (Vite handles this).
- Edit `main.go` — Strux recompiles the Go backend and pushes the new binary to the running VM in seconds. No reboot, no rebuild.

A QEMU window opens showing exactly what your device will display: your app, full-screen.

::: tip First run is slow — that's normal
The first build compiles the Cage compositor and WPE WebKit and assembles a Debian root filesystem inside Docker. Subsequent runs reuse the cache and only rebuild what changed. See [Caching](/concepts/caching.html) for how this works.
:::

## 3. Make it yours

Open `frontend/src/` and change something visible — the QEMU window updates as you save. Then look at `main.go`: the template includes a small example of backend state and methods that the frontend calls through a generated, typed API. The [Backend guide](/guide/backend.html) explains how that bridge works.

## 4. Build a real image

When you want a production image rather than a dev environment:

```bash
strux build
```

This runs the full [build pipeline](/concepts/build-pipeline.html) — frontend, Go application, compositor, browser engine, kernel, bootloader, root filesystem — and produces a bootable disk image under `dist/output/`.

## 5. Boot the image

```bash
strux run
```

This launches the built image in QEMU, exactly as it would boot on hardware: splash screen, then your app. Add `--debug` to see console output and systemd messages while it boots.

## Where to go next

- [Project Structure](/guide/project-structure.html) — what every file and folder in your new project does.
- [Dev Mode](/guide/dev-mode.html) — the full tour: remote devices, the WebKit inspector, USB networking.
- [Frontend](/guide/frontend.html) and [Backend](/guide/backend.html) — how to actually build your app.
- [Flashing](/guide/flashing.html) — getting the image onto real hardware when you're ready.
