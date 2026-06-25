# CLI Reference

Every `strux` command, argument, and flag. For task-oriented walkthroughs, see the [Getting Started guide](/guide/getting-started.md) — this page is the lookup table.

Run `strux --help` (or `strux <command> --help`) for the same information in your terminal. `strux --version` prints the CLI version.

## Global options

These options work with every command. Pass them before or after the command name.

| Flag | Description |
| --- | --- |
| `--verbose` | Enable verbose output. Streams full build script output instead of progress bars. |
| `--local-builder` | Build the `strux-builder` Docker image locally instead of pulling it from GHCR. |
| `--remote-builder <branch-or-tag>` | Pull a branch-scoped builder image from GHCR instead of the default one. |

`--remote-builder` normalizes the value into a valid Docker tag: it is trimmed, lowercased, every run of characters outside `a-z 0-9 _ . -` becomes a single `-`, and leading/trailing dashes are stripped. For example, `feature/v0.3.0` becomes `feature-v0.3.0`. An empty result falls back to `unknown`.

```bash
strux --remote-builder feature/v0.3.0 build qemu
```

## strux init

Scaffold a new Strux project: frontend, Go backend, `strux.yaml`, and a QEMU BSP for local testing.

```bash
strux init my-kiosk --template react --arch arm64
```

| Argument | Description |
| --- | --- |
| `<project-name>` | The name of the project to create (required). A folder with this name is created in the current directory. |

| Flag | Description |
| --- | --- |
| `-t, --template <template>` | Frontend template: `vanilla`, `react`, or `vue`. Default: `vanilla`. |
| `-a, --arch <arch>` | Target architecture: `host`, `arm64`, `x86_64`, or `armhf`. Default: `host`. |

See [Getting Started](/guide/getting-started.md) for what the scaffolded project contains and [Project Structure](/guide/project-structure.md) for a file-by-file tour.

## strux types

Generate TypeScript type definitions for your frontend from the Go structs and methods in `main.go` (plus any BSP runtime extensions). Output goes to `frontend/src`.

```bash
strux types
```

No arguments or options. Run it from the project root. Dev mode runs this automatically when your Go code changes — see the [Backend guide](/guide/backend.md) for how the generated API works.

## strux build

Build a complete OS image for a BSP. Runs the full [build pipeline](/concepts/build-pipeline.md) inside Docker and writes the result to `dist/output/<bsp>/`.

```bash
strux build qemu --clean
```

| Argument | Description |
| --- | --- |
| `<bsp>` | The board support package to build for (required). Must match a folder under `bsp/`. |

| Flag | Description |
| --- | --- |
| `--clean` | Clean the build cache before building. |
| `--dev` | Build a development image. Prints a prominent warning — dev images enable development-only services and remote control paths and must not be deployed to production. |
| `--no-chown` | Skip file permission fixing after builds. |
| `--local-runtime <path>` | Use a local strux repo for the Go runtime instead of the published module. |

See [Building](/guide/building.md) for a walkthrough and [Caching](/concepts/caching.md) for how the build cache decides what to rebuild.

## strux update gen-keypair

Generate a 4096-bit RSA-PSS keypair for signing Strux system update bundles. The private key is written with `0600` permissions.

```bash
strux update gen-keypair
```

| Flag | Description |
| --- | --- |
| `--private-key <path>` | Private key output path. Default: `./strux-update.key`. |
| `--public-key <path>` | Public key output path. Default: `./strux-update.pub`. |
| `-f, --force` | Overwrite existing key files. Without it, the command refuses to overwrite either file. |

See the [Updates guide](/guide/updates.md) for the full signing and delivery workflow.

## strux update bundle

Create a signed full-rootfs update bundle (`.struxb`) from a built rootfs image.

```bash
strux update bundle --bsp qemu --version 1.2.0
```

| Argument | Description |
| --- | --- |
| `[rootfs-image]` | The full rootfs image to bundle. Default: `dist/output/<bsp>/rootfs.ext4`. |

| Flag | Description |
| --- | --- |
| `--private-key <path>` | RSA private key PEM used to sign the bundle with RSA-PSS/SHA-512. Default: `./strux-update.key`. |
| `--bsp <name>` | Target BSP name. Default: the `bsp` value from `strux.yaml`. |
| `--version <version>` | Update version/generation label. Default: `project_version` from `strux.yaml`. |
| `-o, --out <path>` | Output `.struxb` path. Default: `dist/output/<bsp>/<image-name>.struxb`. |

The rootfs image, private key, and output path must all live inside the project folder so the builder container can access them. See the [update system concept page](/concepts/update-system.md) for what's inside a bundle.

## strux update send

Ask a running dev server to install a system update bundle on connected devices. The request is authenticated with the dev client key.

```bash
strux update send dist/output/qemu/rootfs.ext4.struxb
```

| Argument | Description |
| --- | --- |
| `[bundle]` | Path to a `.struxb` bundle. If omitted, the dev server uses the newest bundle in `dist/output/<bsp>`. |

| Flag | Description |
| --- | --- |
| `--server <url>` | Running dev server URL for control requests. Default: the `STRUX_DEV_SERVER_URL` environment variable, or `http://127.0.0.1:8000` if that is unset. |
| `--key <key>` | Client/dev server key. Default: `dev.server.client_key` from `strux.yaml`. Required one way or the other. |

See [Dev Mode](/guide/dev-mode.md) for running the dev server and the [Updates guide](/guide/updates.md) for testing updates end to end.

## strux run

Run the built Strux OS image in QEMU, exactly as it would boot on hardware. Uses the BSP configured in `strux.yaml`.

```bash
strux run --debug
```

| Flag | Description |
| --- | --- |
| `--debug` | Show console output and systemd messages during boot. |
| `--headless` | Run QEMU without opening a host display window. |

See [Running in QEMU](/guide/running-qemu.md) for QEMU configuration, networking, and USB passthrough.

## strux dev

Start the Strux OS development server: builds a dev image, boots it in QEMU (or serves a remote device), and opens a terminal UI with hot reload for the frontend and live Go binary push for the backend.

```bash
strux dev --remote
```

| Flag | Description |
| --- | --- |
| `--remote` | Run the development server to serve the project to a remote device (skips build and QEMU running). |
| `--clean` | Clean the build cache before building. |
| `--debug` | Show device log streams. |
| `--vite` | Show Vite dev server output. |
| `--no-app-debug` | Disable app output streaming (it is on by default). |
| `--no-rebuild` | Skip the initial build and use existing artifacts. |
| `--no-chown` | Skip file permission fixing after builds. |
| `--local-runtime <path>` | Use a local strux repo for the Go runtime instead of the published module. |

See [Dev Mode](/guide/dev-mode.md) for the full tour: remote devices, the WebKit inspector, and USB networking.

## strux flash

Run the selected BSP's flash scripts on the host to write a built image to real hardware. The BSP must define a `flash_script` in its `bsp.yaml`; any `flash_script_tool` scripts run first.

```bash
strux flash my-board
```

| Argument | Description |
| --- | --- |
| `[bsp]` | The board support package to flash. Default: the `bsp` value from `strux.yaml`. |

The command fails if the BSP defines no `flash_script`. Scripts run from a workspace at `dist/flash/<bsp>/`. See the [Flashing guide](/guide/flashing.md) for usage and [flash scripts](/bsp/guide/flash-scripts.md) for writing them.

## strux usb

Manage USB device passthrough configuration for QEMU. Run bare for an interactive menu, or use a subcommand directly. Devices are stored under the `qemu.usb` key in `strux.yaml`.

```bash
strux usb
```

### strux usb add

Auto-detect USB devices connected to your machine and add selected devices to `strux.yaml`.

```bash
strux usb add
```

No options.

### strux usb list

List configured USB devices and optionally remove selected devices.

```bash
strux usb list
```

No options. See [Running in QEMU](/guide/running-qemu.md) for how passthrough devices reach the VM.

## strux kernel

Kernel configuration and management commands. Both subcommands resolve the BSP from the `bsp` key in `strux.yaml`.

### strux kernel menuconfig

Open the interactive kernel configuration menu (`make menuconfig`) inside the builder container.

```bash
strux kernel menuconfig --save
```

| Flag | Description |
| --- | --- |
| `--save` | Save the configuration as a fragment file. |

See the [BSP kernel guide](/bsp/guide/kernel.md) for how kernel configuration fits into a BSP.

### strux kernel clean

Clean kernel build artifacts.

```bash
strux kernel clean --mode full
```

| Flag | Description |
| --- | --- |
| `--mode <mode>` | Clean mode: `mrproper` (default), `clean`, or `full`. |

| Mode | What it does |
| --- | --- |
| `mrproper` | Runs `make mrproper` — removes the kernel config and all generated files. |
| `clean` | Runs `make clean` — removes object files but keeps the config. |
| `full` | Deletes the entire kernel source and build directories. |
