# Installation

This page gets the `strux` CLI installed on your machine, along with the tools it needs. Five minutes, then you're ready for [Getting Started](/guide/getting-started.md).

## Prerequisites

Strux runs all OS builds inside a Docker container, so your machine stays clean — but that means Docker is non-negotiable. Here's the full list:

| Tool | Required? | Why |
|------|-----------|-----|
| **Docker** | Required | All build steps run inside the `strux-builder` container |
| **Go 1.24+** | Required | Compiles your backend during development and powers type generation |
| **Node.js + npm** | Required | Scaffolds and runs your frontend (Vite) |
| **QEMU** | Optional | Runs your built image locally with `strux run` and `strux dev` |

::: tip What's QEMU?
QEMU is a machine emulator — it boots your OS image in a virtual machine on your laptop, so you can test the complete device experience without any hardware. You'll want it; install it from your package manager (`brew install qemu` on macOS).
:::

## macOS (Homebrew)

```bash
brew tap strux-dev/strux
brew install strux
```

### Extras for USB passthrough

If you plan to pass USB devices (scanners, printers, touch controllers) into the QEMU virtual machine, you also need:

```bash
brew install qemu
brew install usbredir
```

QEMU must be built with usbredir support for passthrough to work.

## Linux (Debian/Ubuntu)

Download the `.deb` from the latest release and install it:

```bash
wget https://github.com/strux-dev/strux/releases/latest/download/strux_VERSION_amd64.deb
sudo dpkg -i strux_VERSION_amd64.deb
```

Replace `VERSION` with the release version you downloaded.

## Linux (Fedora/RHEL)

```bash
wget https://github.com/strux-dev/strux/releases/latest/download/strux-VERSION-1.x86_64.rpm
sudo rpm -i strux-VERSION-1.x86_64.rpm
```

## Binary downloads

Prefer a plain binary? Every release ships pre-built binaries for all platforms:

| Platform | Architecture | Download |
|----------|--------------|----------|
| Linux | x64 | `strux-linux-x64` |
| Linux | arm64 | `strux-linux-arm64` |
| macOS | x64 | `strux-darwin-x64` |
| macOS | arm64 (Apple Silicon) | `strux-darwin-arm64` |
| Windows | x64 | `strux-windows-x64.exe` |

Grab the one for your platform from the [releases page](https://github.com/strux-dev/strux/releases), make it executable, and put it on your `PATH`.

## Verify it works

```bash
strux --version
```

If that prints a version number, you're set.

## The builder Docker image

You don't need to set anything up for Docker beyond having it installed and running. On your first build, Strux automatically pulls its builder image from the GitHub Container Registry (`ghcr.io/strux-sh/strux-builder`), matched to your CLI version. Every build step — compiling the kernel, assembling the root filesystem, cross-compiling your Go app — runs inside this container.

Two global flags control where the image comes from:

| Flag | Description |
|------|-------------|
| `--local-builder` | Build the Docker image locally from the embedded Dockerfile instead of pulling from GHCR |
| `--remote-builder <branch-or-tag>` | Pull a branch-scoped builder image from GHCR, e.g. `feature/v0.3.0` → `feature-v0.3.0` |

You won't normally need either — if the registry pull fails (offline, rate-limited), Strux falls back to building the image locally on its own. `--local-builder` is mainly for working on Strux itself.

## Where to go next

- [Getting Started](/guide/getting-started.md) — scaffold a project and boot it in QEMU.
- [Project Structure](/guide/project-structure.md) — what `strux init` actually creates.
- [CLI Reference](/reference/cli.md) — every command and flag.
