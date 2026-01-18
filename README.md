# Strux OS

> **⚠️ ALPHA WARNING**: Strux OS is currently in **alpha** stage. The API and behavior may change without notice, and some features may not work as expected. Use at your own risk.

A framework for building kiosk-style operating systems. Strux enables developers to create customized, minimal Linux distributions optimized for single-purpose applications like digital signage, point-of-sale systems, embedded displays, and more.

## Features

- **Kiosk-Focused**: Build minimal, purpose-built Linux images for embedded displays
- **Cross-Platform Targets**: Support for ARM64, x86_64, and ARMhf architectures
- **Board Support Packages (BSP)**: Hardware-specific configurations with lifecycle scripts
- **Docker-Based Builds**: Reproducible, containerized build environment
- **Development Server**: Hot-reload development with Socket.io and mDNS discovery
- **Frontend Integration**: Support for React, Vue, or vanilla JavaScript frontends
- **Go Backend**: Integrate Go applications with web-based frontends via Cage + WPE WebKit
- **QEMU Emulation**: Test your builds locally before deploying to hardware
- **YAML Configuration**: Simple, human-readable configuration with `strux.yaml` and `bsp.yaml`
- **Type Generation**: Automatic TypeScript type generation from Go structs

## Use Cases

- **Digital Signage** - Display networks in retail, transit, and advertising
- **Point-of-Sale Systems** - Checkout terminals and payment kiosks
- **Kiosk Applications** - Self-service information and ticketing
- **Embedded Displays** - Industrial monitoring and control panels
- **Interactive Installations** - Art and museum exhibits
- **Dedicated Single-Purpose Devices** - IoT applications

## Installation

### macOS (Homebrew)

```bash
brew tap strux-dev/strux
brew install strux
```

**macOS runtime prerequisites for `strux run` with USB passthrough:**
- QEMU (install via Homebrew: `brew install qemu`)
- usbredir tools (install via Homebrew: `brew install usbredir`)
- QEMU must be built with usbredir support

### Linux (Debian/Ubuntu)

```bash
wget https://github.com/strux-dev/strux/releases/latest/download/strux_VERSION_amd64.deb
sudo dpkg -i strux_VERSION_amd64.deb
```

### Linux (Fedora/RHEL)

```bash
wget https://github.com/strux-dev/strux/releases/latest/download/strux-VERSION-1.x86_64.rpm
sudo rpm -i strux-VERSION-1.x86_64.rpm
```

### Binary Downloads

Pre-built binaries are available for all platforms:

| Platform | Architecture | Download |
|----------|--------------|----------|
| Linux | x64 | `strux-linux-x64` |
| Linux | arm64 | `strux-linux-arm64` |
| macOS | x64 | `strux-darwin-x64` |
| macOS | arm64 (Apple Silicon) | `strux-darwin-arm64` |
| Windows | x64 | `strux-windows-x64.exe` |

## Quick Start

### Create a New Project

```bash
strux init my-kiosk --template react --arch arm64
cd my-kiosk
```

### Project Structure

```
my-kiosk/
├── strux.yaml          # Project configuration
├── main.go             # Go application entry point
├── go.mod              # Go module file
├── bsp/                # Board Support Packages
│   └── qemu/           # QEMU BSP for testing (required — do not delete!)
│       ├── bsp.yaml    # BSP configuration
│       ├── overlay/    # BSP-specific filesystem overlay
│       └── scripts/    # BSP lifecycle scripts
├── frontend/           # Frontend source (React/Vue/vanilla)
│   ├── index.html
│   └── src/
├── assets/             # Static assets (logo, etc.)
│   └── logo.png
└── overlay/            # Global filesystem overlay (copied to rootfs)
```

> **⚠️ Important:** Do **not** delete the `bsp/qemu/` folder. The QEMU BSP is required for local development and testing with `strux dev` and `strux run`. You can add additional BSPs for your target hardware alongside it.

### Build Output Structure

After running `strux build`, artifacts are organized in the `dist/` folder:

```
dist/
├── artifacts/          # User-editable build files (preserved between builds)
│   ├── client/         # Strux client Go source code
│   │   ├── main.go
│   │   └── ...
│   ├── logo.png        # Your splash screen logo (copied every time from location specified in strux.yaml)
│   ├── plymouth/       # Plymouth splash screen config
│   ├── scripts/        # Init and service scripts
│   │   ├── init.sh
│   │   ├── strux.sh
│   │   └── strux-network.sh
│   └── systemd/        # Systemd service files
│       ├── strux.service
│       └── strux-network.service
├── cache/              # Compiled artifacts (auto-generated, BSP-specific)
│   ├── frontend/       # Bundled frontend assets
│   └── {bsp}/          # Per-BSP cache (e.g., qemu/)
│       ├── app/main    # Compiled Go application
│       ├── client      # Compiled strux client
│       ├── cage        # Compiled Cage compositor
│       ├── rootfs-base.tar.gz
│       ├── rootfs-post.tar.gz
│       └── ...
├── output/             # Final build outputs (BSP-specific)
│   └── {bsp}/          # Per-BSP output (e.g., qemu/)
│       ├── rootfs.ext4 # Final root filesystem image
│       ├── vmlinuz     # Kernel
│       └── initrd.img  # Initial ramdisk
├── cage/               # Cage compositor source (auto-cloned)
└── extension/          # WPE extension source (auto-cloned)
```

**Key Points:**
- **`dist/artifacts/`** — These files are **user-editable**. Changes you make here are preserved across builds. Customize scripts, systemd services, or the strux client as needed.
- **`dist/cache/`** — Auto-generated compiled artifacts. Cleared with `--clean` flag.
- **`dist/output/`** — Final images ready for flashing or running in QEMU.

### Build Your OS Image

```bash
strux build qemu
```

### Test with QEMU

```bash
strux run
```

### Development Mode

Start the development server with hot-reload:

```bash
strux dev
```

### Hiding the Splash Screen

When your app first boots on the device, you may notice the splash screen remains visible. This is intentional — Strux doesn't automatically hide the splash screen to preserve the vanilla nature of React, Vue, and vanilla JavaScript projects.

To hide the splash screen and reveal your UI, add this to your frontend code:

```typescript
await strux.boot.HideSplash()
```

**Example (React):**
```tsx
import { useEffect } from 'react'

function App() {
  useEffect(() => {
    // Hide splash screen once the app is ready
    strux.boot.HideSplash()
  }, [])

  return <div>My Kiosk App</div>
}
```

**Example (Vue):**
```vue
<script setup lang="ts">
import { onMounted } from 'vue'

onMounted(() => {
  strux.boot.HideSplash()
})
</script>
```

**Example (Vanilla JS):**
```javascript
document.addEventListener('DOMContentLoaded', () => {
  strux.boot.HideSplash()
})
```

> **Tip:** Call `HideSplash()` only after your app has finished loading critical assets or data to ensure a smooth transition from the splash screen to your UI.

## Commands

### `strux init <name>`

Initialize a new Strux project.

**Options:**
- `-t, --template <type>` - Frontend template: `vanilla`, `react`, or `vue` (default: `vanilla`)
- `-a, --arch <arch>` - Target architecture: `arm64`, `x86_64`, or `armhf` (default: `arm64`)

**Example:**
```bash
strux init my-project --template react --arch arm64
```

### `strux build <bsp>`

Build a complete OS image for the specified Board Support Package.

**Options:**
- `--clean` - Clean build cache before building
- `--dev` - Build a development image

**Build Process:**
1. Frontend build (TypeScript types + bundling)
2. Docker build environment setup
3. User application compilation (Go cross-compilation)
4. Cage compositor compilation (Wayland)
5. WPE extension compilation (WebKit bridge)
6. Base rootfs generation (debootstrap with caching)
7. BSP scripts execution (lifecycle hooks)
8. Custom kernel compilation (if enabled)
9. Bootloader build (if enabled)
10. Final OS image assembly

**Example:**
```bash
strux build qemu
strux build qemu --clean  # Force clean rebuild
strux build rpi4          # Build for Raspberry Pi 4
```

### `strux run`

Run the built OS image in QEMU for testing. Auto-detects GPU (Intel/AMD/NVIDIA) for GL acceleration.

**Options:**
- `--debug` - Show console output and systemd messages

**Example:**
```bash
strux run
strux run --debug  # Show debug output
```

### `strux dev`

Start Strux OS in development mode with hot-reload capabilities. This command:
- Builds a development-optimized image
- Starts a Vite dev server for your frontend (runs in Docker)
- Starts a Socket.io dev server for binary streaming
- Watches for Go code and config changes
- Runs QEMU with automatic rebuilds

**Options:**
- `--remote` - Run in remote mode (skips QEMU, serves to external devices)
- `--clean` - Clean build cache before building
- `--debug` - Show device log streams
- `--vite` - Show Vite dev server output

**Features:**
- **Hot-reload for Go code**: Automatically rebuilds and streams your Go binary when `.go` files change
- **Frontend dev server**: Starts Vite with HMR accessible from the VM
- **Config watching**: Rebuilds when `strux.yaml` or Go files change
- **mDNS discovery**: Devices can discover the dev server automatically
- **Remote development**: Develop on real hardware while iterating locally

**Example:**
```bash
strux dev              # Local QEMU development
strux dev --remote     # Serve to remote devices only
strux dev --debug      # Show device logs
strux dev --vite       # Show Vite output
```

**Developing on Real Hardware:**

If you want hot-reload on a physical device instead of QEMU, follow this workflow:

1. Build a development image for your target BSP:
   ```bash
   strux build rpi4 --dev
   ```

2. Flash the image to your device (SD card, eMMC, etc.)

3. Start the dev server in remote mode before booting the device:
   ```bash
   strux dev --remote
   ```

4. Boot your device — it will connect to the dev server automatically via mDNS or the configured fallback hosts

5. Edit your Go code and watch it hot-reload on the device!

> **Note:** Make sure your development machine and device are on the same network. Configure `dev.server.fallback_hosts` in `strux.yaml` with your machine's IP address if mDNS discovery doesn't work on your network.

### `strux types`

Generate TypeScript types from Go structs for frontend integration.

**Example output (`strux.d.ts`):**
```typescript
interface App {
  Title: string;
  Counter: number;
  Greet(name: string): Promise<string>;
  Add(x: number, y: number): Promise<number>;
}

declare global {
  const strux: Strux;
  interface Window {
    strux: Strux;
    go: {
      main: {
        App: App;
      };
    };
  }
}
```

### `strux usb`

Manage USB device passthrough configuration for QEMU.

#### `strux usb add`

Auto-detect USB devices and add them to `strux.yaml`:

```bash
strux usb add
```

#### `strux usb list`

List configured USB devices and optionally remove them:

```bash
strux usb list
```

## Configuration

### strux.yaml

The main project configuration file:

```yaml
strux_version: 0.0.1
name: my-kiosk

# BSP to use (folder name under bsp/)
bsp: qemu

# Device hostname
hostname: my-device

# Boot configuration
boot:
  splash:
    enabled: true
    logo: ./assets/logo.png
    color: "000000"  # Hex color for browser background

# RootFS configuration
rootfs:
  overlay: ./overlay
  packages:
    - curl
    - wget

# QEMU-specific settings (for local testing)
qemu:
  enabled: true
  network: true
  usb: []
  flags:
    - -m 2G

# Build configuration
build:
  host_packages:
    - curl
    - wget

# Development server settings
dev:
  server:
    fallback_hosts:
      - host: 10.0.2.2
        port: 8000
    use_mdns_on_client: true
    client_key: YOUR_CLIENT_KEY_HERE
```

#### Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `strux_version` | Strux version this project was built with | Required |
| `name` | Project name | Required |
| `bsp` | BSP folder name (under `bsp/`) | Required |
| `hostname` | Device hostname | `strux` |
| `boot.splash.enabled` | Show boot splash screen | `true` |
| `boot.splash.logo` | Path to splash logo (PNG) | `./assets/logo.png` |
| `boot.splash.color` | Browser background color (hex) | `000000` |
| `rootfs.overlay` | Filesystem overlay directory | `./overlay` |
| `rootfs.packages` | APT packages to install | `[]` |
| `qemu.enabled` | Enable QEMU for testing | `true` |
| `qemu.network` | Enable QEMU networking | `true` |
| `qemu.usb` | USB device passthrough | `[]` |
| `qemu.flags` | Additional QEMU flags | `[]` |
| `build.host_packages` | Docker build environment packages | `[]` |
| `dev.server.fallback_hosts` | Dev server bind addresses | `[]` |
| `dev.server.use_mdns_on_client` | Enable mDNS discovery | `true` |
| `dev.server.client_key` | Authentication key for dev clients | Required for dev |

### bsp.yaml

Board Support Package configuration:

```yaml
strux_version: 0.0.1
bsp:
  name: qemu
  description: "QEMU virtual machine for testing"
  arch: arm64
  hostname: my-device
  
  display:
    resolution: 1920x1080

  # Lifecycle scripts
  scripts:
    - location: ./scripts/make-image.sh
      step: make_image
      description: "Create disk image"
      cached_generated_artifacts:
        - output/rootfs.ext4
      depends_on:
        - cache/rootfs-base.tar.gz
        - cache/rootfs-post.tar.gz

  # Boot configuration
  boot:
    bootloader:
      enabled: false
      # type: u-boot
      # version: 2025.10
      # source: https://github.com/u-boot/u-boot.git
      # defconfig: qemu_arm64_defconfig
      # fragments: []
      # patches: []

    kernel:
      custom_kernel: false
      # source: https://github.com/torvalds/linux.git
      # version: 6.1
      # defconfig: defconfig
      # fragments: []
      # patches: []
      # device_tree:
      #   dts: my-board.dts
      #   overlays: []

  # BSP-specific rootfs
  rootfs:
    overlay: ./overlay
    packages:
      - curl
      - wget
```

#### BSP Script Steps

Scripts can run at various lifecycle stages:

| Step | When it runs |
|------|-------------|
| `before_build` | Very first step, before anything else |
| `after_build` | Very last step, after everything completes |
| `before_frontend` / `after_frontend` | Around frontend compilation |
| `before_application` / `after_application` | Around main.go compilation |
| `before_cage` / `after_cage` | Around Cage compositor compilation |
| `before_wpe` / `after_wpe` | Around WPE extension compilation |
| `before_client` / `after_client` | Around strux-client compilation |
| `before_kernel` / `after_kernel` | Around kernel compilation (if enabled) |
| `before_bootloader` / `after_bootloader` | Around bootloader compilation (if enabled) |
| `before_rootfs` / `after_rootfs` | Around rootfs creation |
| `before_bundle` | After post-processing, before final image |
| `make_image` | Creates the final disk image |
| `flash_script` | Flash script (used by `strux flash`) |

#### Script Environment Variables

Scripts have access to these environment variables:

| Variable | Description |
|----------|-------------|
| `BSP_NAME` | Name of the BSP |
| `PROJECT_FOLDER` | Project root directory |
| `PROJECT_DIST_FOLDER` | `dist/` directory |
| `PROJECT_DIST_CACHE_FOLDER` | BSP cache: `dist/cache/{bsp}/` |
| `PROJECT_DIST_OUTPUT_FOLDER` | BSP output: `dist/output/{bsp}/` |
| `PROJECT_DIST_ARTIFACTS_FOLDER` | Shared artifacts: `dist/artifacts/` |
| `SHARED_CACHE_DIR` | Shared cache: `dist/cache/` |
| `BSP_CACHE_DIR` | Alias for cache folder |
| `HOST_ARCH` | Host machine architecture |
| `TARGET_ARCH` | Target device architecture |
| `STEP` | Current build step name |
| `STRUX_VERSION` | Strux version |

## Architecture

### How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                         Strux OS                            │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   Frontend  │  │   Go App    │  │   WPE Extension     │  │
│  │  (React/Vue)│◄─┤  (main.go)  │◄─┤   (WebSocket RPC)   │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│         │                │                    │             │
│         ▼                ▼                    ▼             │
│  ┌─────────────────────────────────────────────────────────┐│
│  │              Cage Wayland Compositor                    ││
│  │           (Fullscreen kiosk mode)                       ││
│  └─────────────────────────────────────────────────────────┘│
│                          │                                  │
│                          ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐│
│  │              Minimal Debian Rootfs                       ││
│  │         (Custom kernel + systemd services)               ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### Development Mode Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Development Workflow                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  File Watch  │───▶│  Go Compile  │───▶│ Binary Stream │  │
│  │  (chokidar)  │    │  (Docker)    │    │  (Socket.io)  │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│                                                  │          │
│  ┌──────────────┐                                ▼          │
│  │ Vite Server  │◄─────────── HMR ──────▶ ┌──────────────┐  │
│  │  (Docker)    │                         │  QEMU / Real │  │
│  │  :5173       │                         │   Hardware   │  │
│  └──────────────┘                         └──────────────┘  │
│                                                  ▲          │
│  ┌──────────────┐                                │          │
│  │  Dev Server  │────── mDNS Discovery ──────────┘          │
│  │  (Socket.io) │                                           │
│  │  :8000       │                                           │
│  └──────────────┘                                           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Type System Bridge

Strux provides seamless integration between Go backends and TypeScript frontends:

1. **Go Introspection**: The `strux-introspect` tool analyzes your `main.go` using Go AST
2. **Type Extraction**: Extracts App struct fields and public methods
3. **TypeScript Generation**: Creates `strux.d.ts` with proper type mappings

## Requirements

- **Docker**: Required for containerized builds
- **Go 1.24+**: For Go application compilation and type introspection
- **QEMU**: Optional, for local testing
- **Node.js and npm**: Required for React/Vue frontends

## Development

### Prerequisites

- [Bun](https://bun.sh) v1.1.38+
- Go 1.24+

### Setup

```bash
# Clone the repository
git clone https://github.com/strux-dev/strux.git
cd strux

# Install dependencies
bun install

# Build the Go introspection binary
bun run build:go

# Generate runtime types
bun run generate:types

# Run in development mode
bun run dev
```

### Build

```bash
# Build the CLI executable
bun run build

# Build the Go introspection binary
bun run build:go
```

### Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Run CLI in development mode |
| `bun run build` | Build CLI executable |
| `bun run build:go` | Build Go introspection binary |
| `bun run generate:types` | Generate TypeScript types from Go |
| `bun run lint` | Run ESLint |
| `bun run typecheck` | Run TypeScript type checking |
| `bun test` | Run tests |

### Project Structure

```
strux/
├── src/                          # TypeScript source code
│   ├── index.ts                  # CLI entry point (Commander.js)
│   ├── commands/                 # CLI commands
│   │   ├── build/               # Build system orchestration
│   │   ├── dev/                 # Development server
│   │   ├── init/                # Project initialization
│   │   ├── run/                 # QEMU emulator runner
│   │   ├── types/               # TypeScript type generation
│   │   └── usb/                 # USB device management
│   ├── types/                    # Type definitions
│   │   ├── main-yaml.ts         # strux.yaml schema (Zod)
│   │   ├── bsp-yaml.ts          # bsp.yaml schema (Zod)
│   │   └── strux-runtime.ts     # Runtime API types
│   ├── utils/                    # Helper utilities
│   └── assets/                   # Build script templates
├── cmd/                          # Go source code
│   ├── strux/main.go            # Go AST introspection tool
│   └── gen-runtime-types/       # Runtime types generator
├── pkg/                          # Go libraries
│   └── runtime/                 # Runtime helpers
├── test/                         # Test fixtures and examples
├── package.json                  # Bun/npm dependencies
└── tsconfig.json                 # TypeScript configuration
```

## License

GPLv2
