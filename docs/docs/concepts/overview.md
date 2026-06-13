# Architecture Overview

This page explains how Strux works under the hood, in two halves: what happens on your machine when you run `strux build`, and what happens on the device every time it powers on. Read this once and the rest of the docs will make much more sense.

## The two halves

```txt
BUILD TIME (your machine)                ON DEVICE (every boot)
┌──────────────────────────┐             ┌──────────────────────────┐
│  strux CLI               │             │  Bootloader → Kernel     │
│    │                     │             │    │                     │
│    ▼                     │             │    ▼                     │
│  strux-builder (Docker)  │   image     │  systemd                 │
│    frontend, Go app,     │  ───────▶   │    │                     │
│    Cage, WPE, kernel,    │             │    ▼                     │
│    bootloader, rootfs    │             │  strux.service           │
│    │                     │             │    ├─ Go backend (:8080) │
│    ▼                     │             │    └─ strux client       │
│  dist/output/{bsp}/      │             │         └─ Cage → Cog    │
│    bootable image        │             │              └─ your app │
└──────────────────────────┘             └──────────────────────────┘
```

## Build-time architecture

The `strux` CLI is a single binary (TypeScript, compiled with Bun) that orchestrates the build. It doesn't compile anything itself — every build step runs as a shell script inside a Docker container called **strux-builder**, which has all the cross-compilers, `debootstrap`, and build tools pre-installed. That's why Docker is the only real prerequisite: your machine never needs an ARM toolchain or kernel headers.

A build works like this:

1. The CLI validates `strux.yaml` (your project config) and `bsp/{name}/bsp.yaml` (the board config) against strict schemas. Typos fail fast, before any compilation.
2. It copies its embedded assets (build scripts, systemd services, the Cage and client source code) into `dist/artifacts/`, where you can inspect and even edit them. See [Artifacts](/concepts/artifacts.html).
3. It runs the build steps in order — frontend, Go application, Cage compositor, WPE extension, client, kernel, bootloader, root filesystem — each as a script inside the strux-builder container with your project mounted at `/project`. The full sequence is described in [Build Pipeline](/concepts/build-pipeline.html).
4. A smart cache skips any step whose inputs haven't changed, so incremental builds are fast. See [Caching](/concepts/caching.html).
5. The BSP's `make_image` script assembles everything into a bootable disk image under `dist/output/{bsp}/`.

Everything lands in `dist/`, split per board so you can build for QEMU and real hardware side by side:

```txt
dist/
├── artifacts/          # Embedded assets, copied out once — yours to edit
├── cache/
│   ├── frontend/       # Built frontend (shared — architecture-agnostic)
│   └── {bsp}/          # Per-board compiled binaries, kernel, rootfs tarballs
└── output/
    └── {bsp}/          # The final bootable image
```

::: tip What's a rootfs?
The **root filesystem** (rootfs) is everything a Linux system has on disk: `/usr`, `/etc`, your app, all of it. Strux builds a minimal Debian rootfs and layers your app on top.
:::

Hardware specifics — CPU architecture, kernel source, bootloader, device-specific scripts — live entirely in the **Board Support Package**. The pipeline is the same for every board; the BSP fills in the blanks. See [Board Support Packages](/concepts/bsp.html).

## On-device architecture

The built image boots a fixed, minimal chain. There's no desktop, no login screen — just enough Linux to put your app on the screen.

```txt
Bootloader (U-Boot/GRUB — BSP-dependent)
  └─ Linux kernel + initramfs (Plymouth splash shows your logo)
       └─ systemd
            ├─ strux-network.service   (network bring-up)
            ├─ seatd                   (grants display/input access)
            └─ strux.service
                 └─ /strux/strux.sh
                      ├─ /strux/main      ← your Go backend, HTTP on :8080
                      └─ /strux/client    ← the Strux client
                           └─ cage        ← Wayland compositor (with splash)
                                └─ cog    ← WPE WebKit browser, one per display
                                     └─ your frontend, full-screen
```

::: tip New to some of these terms?
**systemd** is Linux's service manager — it starts and supervises processes at boot. **Plymouth** draws the boot splash before the graphics stack is up. A **Wayland compositor** (Cage) is the component that puts pixels on the screen; **WPE WebKit** (launched via the `cog` browser shell) renders your web app inside it.
:::

Everything Strux-specific lives in `/strux/` on the device. The key players:

- **`strux.service`** — the systemd unit that owns the whole UI stack. It requires `seatd` (the daemon that hands out access to displays and input devices) and restarts on failure.
- **`strux.sh`** — the startup script. It waits for the GPU and seatd, applies any staged binary updates, starts your Go backend (`/strux/main`), hands off from Plymouth, then launches the client. It's user-editable — see [Artifacts](/concepts/artifacts.html).
- **The Strux client** (`/strux/client`) — a small Go program that decides between production and dev mode, then launches Cage. In production it simply runs the compositor; in dev mode (when `/strux/.dev-env.json` exists) it first discovers your dev machine over mDNS, USB networking, or configured fallback hosts, and connects via WebSocket so the CLI can push new binaries without reflashing. See [Dev Mode](/guide/dev-mode.html).
- **Cage** — Strux ships a modified Cage that renders the boot splash itself (so the logo never flickers between Plymouth and your app), supports multiple monitors with per-output URLs, rotation, and touch-device mapping. See [Display Stack](/concepts/display-stack.html).
- **Cog** — the WPE WebKit browser shell. Cage launches one Cog instance per configured display through the user-editable `/strux/strux-run-cog.sh` script.

### How the frontend talks to the backend

Your Go backend serves HTTP on port `8080` — it serves the built frontend files from `/strux/frontend` and answers API calls. In production it binds to `127.0.0.1` only, so nothing is exposed on the network; in dev mode it listens on all interfaces.

Cog loads `http://localhost:8080` plus the path configured for its display. Alongside HTTP, a WPE WebKit **web extension** (`libstrux-extension.so`) runs inside the browser's web process and connects to the backend over a Unix socket (`/tmp/strux-ipc.sock`). It injects a `window.strux` object into every page: your backend's fields and methods appear as typed JavaScript properties and async functions, plus a `strux.ipc` event API (`on`, `off`, `send`) for bidirectional events. That's the bridge the [Backend guide](/guide/backend.html) and [Frontend API reference](/reference/frontend-api.html) describe.

## Where to go next

- [Build Pipeline](/concepts/build-pipeline.html) — every build step in detail.
- [Caching](/concepts/caching.html) — why rebuilds are fast.
- [Board Support Packages](/concepts/bsp.html) — how hardware support is packaged.
- [Display Stack](/concepts/display-stack.html) — Cage, Cog, and multi-monitor setups.
