# Strux OS

> **⚠️ ALPHA WARNING**: Strux OS is currently in **alpha** stage. The API and behavior may change without notice, and some features may not work as expected. Use at your own risk.

A framework for building kiosk-style operating systems. Strux enables developers to create customized, minimal Linux distributions optimized for single-purpose applications like digital signage, point-of-sale systems, and embedded displays.

## Features

- **Kiosk-Focused**: Build minimal, purpose-built Linux images for embedded displays
- **Cross-Platform Targets**: Support for ARM64 and x86_64 architectures
- **Board Support Packages (BSP)**: Hardware-specific configurations for different boards
- **Docker-Based Builds**: Reproducible, containerized build environment
- **Frontend Integration**: Support for React, Vue, or vanilla JavaScript frontends
- **Go Backend**: Integrate Go applications with web-based frontends via Cage + WPE WebKit
- **QEMU Emulation**: Test your builds locally before deploying to hardware
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

### Linux (Debian/Ubuntu)

```bash
wget https://github.com/strux-dev/strux/releases/latest/download/strux_VERSION_amd64.deb
sudo dpkg -i strux_VERSION_amd64.deb
```

### Linux (Fedora/RHEL) (Untested)

```bash
wget https://github.com/strux-dev/strux/releases/latest/download/strux-VERSION-1.x86_64.rpm
sudo rpm -i strux-VERSION-1.x86_64.rpm
```

### Windows (Untested)

Download and run `strux-setup.exe` from the [latest release](https://github.com/strux-dev/strux/releases/latest).

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
├── strux.json          # Project configuration
├── main.go             # Go application entry point
├── go.mod              # Go module file
├── bsp/                # Board Support Packages
│   └── qemu/           # QEMU BSP for testing
│       └── bsp.json    # BSP configuration
├── frontend/           # Frontend source (React/Vue/vanilla)
│   ├── index.html
│   └── src/
├── assets/             # Static assets (logo, etc.)
│   └── logo.png
└── overlay/            # Filesystem overlay (copied to rootfs)
```

### Build Your OS Image
Builds an image for the relevant BSP

```bash
strux build qemu
```

### Test with QEMU

```bash
strux run
```

You must first run ```strux build qemu```.

## Commands

### `strux init <name>`

Initialize a new Strux project.

**Options:**
- `--template <type>` - Frontend template: `vanilla`, `react`, or `vue` (default: `vanilla`)
- `--arch <arch>` - Target architecture: `arm64` or `x86_64` (default: `arm64`)

**Example:**
```bash
strux init my-project --template react --arch arm64
```

### `strux build <bsp>`

Build a complete OS image for the specified Board Support Package.

**Options:**
- `--clean` - Clean build cache before building
- `--verbose` - Show detailed build output

**Build Process:**
1. Frontend build (TypeScript types + bundling)
2. Docker build environment setup
3. User application compilation (Go cross-compilation)
4. Cage compositor compilation (Wayland)
5. WPE extension compilation (WebKit bridge)
6. Base rootfs generation (debootstrap with caching)
7. BSP artifacts building
8. Custom kernel compilation (if enabled)
9. U-Boot bootloader build (if enabled)
10. Final OS image assembly
11. Disk image generation (if partitions defined) [This is a Work in Progress]

### `strux run`

Run the built OS image in QEMU for testing. Auto-detects GPU (Intel/AMD/NVIDIA) for GL acceleration.
NVIDIA Devices and MacOS (with Apple Silicon) devices tend to have issues with GPU Passthrough, so we have employed software rendering for both.

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

### `strux bsp <command>`

Manage Board Support Packages:

- `strux bsp add <url|path>` - Add a BSP from git URL or local path
- `strux bsp list` - List installed BSPs
- `strux bsp info <name>` - Show BSP details
- `strux bsp remove <name>` - Remove a BSP
- `strux bsp init <name> --arch <arch>` - Create a new BSP skeleton

### `strux clean`

Clean the build cache.

## Configuration

### strux.json

The main project configuration file:

```json
{
  "v": "0.0.1",
  "name": "my-kiosk",
  "output": "./dist",
  "arch": "arm64",
  "bsp": "./bsp/qemu",
  "hostname": "strux",
  "display": {
    "resolution": "1920x1080",
    "initial_load_color": "000000"
  },
  "boot": {
    "splash": {
      "enabled": true,
      "logo": "./assets/logo.png"
    },
    "bootloader": {
      "enabled": false,
      "type": "u-boot",
      "defconfig": "qemu_arm64_defconfig",
      "fragments": []
    },
    "kernel": {
      "source": "https://github.com/torvalds/linux.git",
      "version": "6.1",
      "defconfig": "defconfig",
      "fragments": []
    },
    "service_files": []
  },
  "rootfs": {
    "overlay": "./overlay",
    "packages": ["curl", "wget"],
    "deb_packages": []
  },
  "qemu": {
    "network": true,
    "usb": [
      { "vendor_id": "1234", "product_id": "5678" }
    ],
    "flags": []
  },
  "build": {
    "host_packages": []
  }
}
```

#### Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `v` | Strux version this project was built with | Required |
| `name` | Project name | Required |
| `output` | Output directory for build artifacts | `./dist` |
| `arch` | Target architecture (`arm64` or `x86_64`) | Required |
| `bsp` | Path to BSP directory | Required |
| `hostname` | Device hostname | `strux` |
| `display.resolution` | Display resolution (e.g., `1920x1080`) | `1920x1080` |
| `display.initial_load_color` | Initial load screen color (hex) | `000000` |
| `boot.splash.enabled` | Show boot splash screen | `true` |
| `boot.splash.logo` | Path to splash logo | `./assets/logo.png` |
| `boot.service_files` | Custom systemd service files | `[]` |
| `rootfs.overlay` | Filesystem overlay directory | `./overlay` |
| `rootfs.packages` | APT packages to install | `[]` |
| `rootfs.deb_packages` | Local .deb files to install | `[]` |
| `qemu.network` | Enable QEMU network | `true` |
| `qemu.usb` | USB device passthrough | `[]` |
| `qemu.flags` | Additional QEMU flags | `[]` |

### BSP Configuration (bsp.json)

Board Support Package configuration:

```json
{
  "name": "qemu",
  "description": "QEMU virtual machine for testing",
  "arch": "arm64",
  "soc": "generic",
  "artifacts": {
    "source": "prebuilt"
  },
  "packages": [],
  "kernel": {
    "enabled": false,
    "source": "https://github.com/torvalds/linux.git",
    "version": "6.1",
    "defconfig": "defconfig",
    "fragments": [],
    "patches": [],
    "external_dts": [],
    "overlays": []
  },
  "uboot": {
    "enabled": false,
    "source": "https://github.com/u-boot/u-boot.git",
    "defconfig": "qemu_arm64_defconfig",
    "patches": [],
    "env": {},
    "output_files": {}
  },
  "partitions": {
    "table": "gpt",
    "layout": [
      { "name": "boot", "source": "fat", "size": "256M" },
      { "name": "rootfs", "source": "rootfs" }
    ]
  },
  "flash": {
    "script": "./flash.sh",
    "instructions": "Hold BOOT button and connect USB..."
  }
}
```

#### BSP Options

| Option | Description |
|--------|-------------|
| `name` | BSP identifier |
| `description` | Human-readable description |
| `arch` | Target architecture (`arm64` or `amd64`) |
| `soc` | System-on-chip identifier |
| `artifacts.source` | How to obtain artifacts: `prebuilt`, `script`, or `download` |
| `packages` | Additional packages required for this board |
| `kernel.enabled` | Build custom kernel |
| `kernel.source` | Kernel source repository URL |
| `kernel.defconfig` | Kernel configuration |
| `kernel.patches` | Kernel patches to apply |
| `kernel.external_dts` | External device tree sources |
| `uboot.enabled` | Build U-Boot bootloader |
| `uboot.source` | U-Boot source repository URL |
| `uboot.defconfig` | U-Boot configuration |
| `partitions.table` | Partition table type (`gpt` or `mbr`) |
| `partitions.layout` | Partition definitions |

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

### Type System Bridge

Strux provides seamless integration between Go backends and TypeScript frontends:

1. **Go Introspection**: The `strux-introspect` tool analyzes your `main.go` using Go AST
2. **Type Extraction**: Extracts App struct fields and public methods
3. **TypeScript Generation**: Creates `strux.d.ts` with proper type mappings

## Requirements

- **Docker**: Required for containerized builds
- **Go 1.24+**: For Go application compilation and type introspection
- **QEMU**: Optional, for local testing
- **NodeJS and NPM**: Required for Vue, React projects

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
| `bun run dev` | Run in development mode |
| `bun run build` | Build CLI executable |
| `bun run build:go` | Build Go introspection binary |
| `bun run generate:types` | Generate TypeScript types from Go |
| `bun run lint` | Run ESLint |
| `bun run typecheck` | Run TypeScript type checking |
| `bun run test` | Run tests |

### Project Structure

```
strux-os-bun/
├── src/                          # TypeScript source code
│   ├── index.ts                  # CLI entry point (Commander.js)
│   ├── tools/                    # Core functionality modules
│   │   ├── build/               # Build system orchestration
│   │   ├── init/                # Project initialization
│   │   ├── bsp/                 # Board Support Package management
│   │   ├── run/                 # QEMU emulator runner
│   │   └── types/               # TypeScript type generation
│   ├── types/                    # Type definitions
│   │   ├── config.ts            # Project configuration schema
│   │   ├── bsp.ts               # BSP schema and validators
│   │   └── strux-runtime.ts     # Runtime API types
│   ├── utils/                    # Helper utilities
│   └── files/                    # Build script templates
├── cmd/                          # Go source code
│   ├── strux/main.go            # Go AST introspection tool
│   └── gen-runtime-types/       # Runtime types generator
├── package.json                  # Bun/npm dependencies
└── tsconfig.json                 # TypeScript configuration
```

## License

GPLv2
