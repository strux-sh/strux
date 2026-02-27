# SITE.md — Strux OS Marketing Website Brief

> This document is a comprehensive brief for generating the strux.sh marketing website.
> It contains all features, positioning, messaging, architecture details, and content
> needed to build a professional, developer-focused product website.

---

## 1. BRAND & POSITIONING

### Tagline Options
- "Build kiosk operating systems with web technologies"
- "From React to bootable Linux in one command"
- "The framework for single-purpose devices"

### One-Liner
Strux OS is a CLI framework that lets you build minimal, bootable Linux operating systems for kiosk and embedded displays using Go + React/Vue — with hot-reload development, smart caching, and full hardware customization.

### Elevator Pitch
Building a kiosk OS shouldn't require embedded Linux expertise. Strux gives web developers the power to create production-ready, single-purpose Linux images using the tools they already know — React, Vue, or vanilla JavaScript for the UI, Go for the backend, and YAML for configuration. One CLI handles everything: scaffolding, building, testing in QEMU, hot-reload development, and deployment to real hardware.

### Target Audience
- **Primary**: Fullstack/web developers building embedded display products (digital signage, POS, kiosks, control panels)
- **Secondary**: Embedded Linux engineers looking for a faster, more modern workflow
- **Tertiary**: Hardware companies needing a rapid prototyping-to-production OS pipeline

### Competitive Landscape
Strux replaces the need to manually orchestrate:
- Yocto / Buildroot (complex, steep learning curve, slow iteration)
- Custom Docker + debootstrap setups (fragile, no dev experience)
- Electron on full Linux (bloated, not purpose-built)
- Android kiosk mode (overkill, Google dependencies)

---

## 2. HERO SECTION

### Key Message
Ship a custom Linux OS for your kiosk, signage, or embedded device — built with React/Vue and Go, tested locally in QEMU, deployed anywhere.

### Hero Code Example
```bash
# Create a new kiosk project with React
strux init my-kiosk --template react --arch arm64

# Build a bootable OS image
cd my-kiosk && strux build qemu

# Test it locally
strux run

# Develop with hot-reload
strux dev
```

### Stats/Social Proof (placeholders)
- "From zero to bootable image in under 5 minutes"
- "12-step automated build pipeline"
- "3 target architectures: ARM64, x86_64, ARMhf"
- "Single binary CLI — zero runtime dependencies"

---

## 3. FEATURES — DETAILED BREAKDOWN

### 3.1 Web-Native Development Stack

**Headline**: Build your kiosk UI with the frameworks you already know.

**Details**:
- Choose React, Vue, or vanilla JavaScript for the frontend
- Go backend with automatic method/field exposure to the frontend
- Type-safe bridge: Go structs become TypeScript interfaces automatically
- Vite-powered frontend builds with HMR in dev mode
- Standard web APIs — no proprietary SDK to learn

**Code Example — Type-Safe Go-to-Frontend Bridge**:
```go
// main.go — your Go backend
type App struct {
    Title   string
    Counter int
}

func (a *App) Greet(name string) string {
    return "Hello, " + name + "!"
}

func (a *App) Add(x, y int) int {
    return x + y
}
```

```typescript
// Auto-generated strux.d.ts
interface App {
  Title: string
  Counter: number
  Greet(name: string): Promise<string>
  Add(x: number, y: number): Promise<number>
}
```

```tsx
// Frontend — call Go methods directly
function App() {
  const [greeting, setGreeting] = useState('')

  useEffect(() => {
    strux.boot.HideSplash()
  }, [])

  const handleGreet = async () => {
    const result = await window.go.main.App.Greet('World')
    setGreeting(result)
  }

  return <button onClick={handleGreet}>{greeting}</button>
}
```

### 3.2 Hot-Reload Development Mode

**Headline**: Iterate at the speed of web development — on an embedded OS.

**Details**:
- `strux dev` launches a complete development environment
- Frontend hot-reload via Vite HMR — see UI changes instantly
- Go backend hot-reload — edit `.go` files, binary recompiles and streams to device automatically
- Works with local QEMU emulation or real hardware on your network
- mDNS auto-discovery — devices find the dev server automatically
- Rich terminal UI (React/Ink) with 7 tabbed log streams: Build, Vite, App, Cage, System, QEMU Serial, Remote Console
- Remote mode (`--remote`) for developing directly on physical hardware

**Dev Mode Architecture Diagram**:
```
  Your Machine                          Device / QEMU
  ┌──────────────────┐                 ┌──────────────────┐
  │  File Watcher    │──── recompile ──▶│                  │
  │  (Go changes)    │     & stream     │  Your App        │
  │                  │                  │  (Go + Web UI)   │
  │  Vite Dev Server │──── HMR ────────▶│                  │
  │  (Frontend)      │                  │  Cage Compositor  │
  │                  │                  │  (Fullscreen)     │
  │  Dev Server      │◀── mDNS ────────│                  │
  │  (Socket.io)     │   discovery      │  Strux Client    │
  └──────────────────┘                 └──────────────────┘
```

### 3.3 Smart Build Caching

**Headline**: Rebuild only what changed. Minutes, not hours.

**Details**:
- 12-step build pipeline with per-step dependency tracking
- Each step declares its file, directory, and config dependencies
- SHA256-based cache invalidation — only rebuilds what actually changed
- Per-BSP cache manifests (`dist/cache/{bsp}/.build-cache.json`)
- Docker image hash tracking — Dockerfile changes auto-invalidate dependent steps
- Individual YAML key tracking — changing a single config value only rebuilds affected steps
- Asset hash tracking — CLI upgrades automatically invalidate steps that depend on embedded assets
- Deferred permission fixing — single `chown` pass at pipeline end instead of per-step (dramatically faster)

### 3.4 Board Support Packages (BSPs)

**Headline**: One project, many hardware targets. BSPs handle the differences.

**Details**:
- Each hardware target gets its own BSP directory with `bsp.yaml`
- 20+ lifecycle hook points for hardware-specific customization
- Custom kernel builds with defconfig, fragments, patches, device trees, and overlays
- Custom bootloader builds (U-Boot, GRUB, systemd-boot, or custom)
- BSP-specific package lists and filesystem overlays
- Scripts run inside Docker with 20+ environment variables for full context
- QEMU BSP included by default for instant local testing

**Lifecycle Hooks Available**:
| Phase | Hooks |
|-------|-------|
| Global | `before_build`, `after_build` |
| Frontend | `before_frontend`, `after_frontend` |
| Application | `before_application`, `after_application` |
| Cage Compositor | `before_cage`, `after_cage` |
| WPE Extension | `before_wpe`, `after_wpe` |
| Strux Client | `before_client`, `after_client` |
| Kernel | `before_kernel`, `after_kernel_extract`, `after_kernel`, `custom_kernel` |
| Bootloader | `before_bootloader`, `after_bootloader`, `custom_bootloader` |
| RootFS | `before_rootfs`, `after_rootfs` |
| Bundle | `before_bundle` |
| Image | `make_image`, `flash_script` |

### 3.5 Full OS Architecture

**Headline**: A complete, purpose-built software stack — from bootloader to browser.

**Stack Diagram**:
```
┌────────────────────────────────────────────┐
│          Your Frontend (React/Vue/JS)      │
│            Vite-bundled web app             │
├────────────────────────────────────────────┤
│          Your Go Backend (main.go)         │
│         Automatic method/field binding      │
├────────────────────────────────────────────┤
│         WPE WebKit + IPC Extension         │
│     JSON-RPC bridge (sync + async IPC)     │
├────────────────────────────────────────────┤
│        Cog Browser (WPE launcher)          │
│          Fullscreen kiosk rendering         │
├────────────────────────────────────────────┤
│         Cage Wayland Compositor            │
│    Single-app fullscreen, splash screen     │
├────────────────────────────────────────────┤
│        Strux Client (device manager)       │
│   Process lifecycle, dev mode, networking   │
├────────────────────────────────────────────┤
│          Minimal Debian Rootfs             │
│     Debian 13 (Trixie) — supported to 2030 │
├────────────────────────────────────────────┤
│      Custom Linux Kernel (optional)        │
│    Defconfig + fragments + patches + DTS    │
├────────────────────────────────────────────┤
│     Bootloader (U-Boot/GRUB/custom)        │
│      Firmware blobs, device trees           │
├────────────────────────────────────────────┤
│            Target Hardware                 │
│      ARM64 / x86_64 / ARMhf               │
└────────────────────────────────────────────┘
```

**Details**:
- **Cage Wayland Compositor**: wlroots-based, single-app fullscreen mode, splash screen rendering with PNG support, DPI-aware, XWayland support
- **WPE WebKit Extension**: Custom C extension bridging JavaScript to Go via JSON-RPC over Unix sockets. Dual socket architecture — sync for field access, async for method calls with promise tracking
- **Strux Client**: Go binary managing device lifecycle — process startup/shutdown, dev mode detection, mDNS discovery, binary update streaming, network readiness checks, display resolution management
- **Debian 13 Trixie**: Long-term support base, minimal footprint via debootstrap, customizable package lists and filesystem overlays

### 3.6 QEMU Emulation & Testing

**Headline**: Test on your laptop before you flash to hardware.

**Details**:
- `strux run` launches the built image in QEMU instantly
- Automatic GPU detection (Intel/AMD/NVIDIA) for hardware-accelerated rendering
- Platform-specific acceleration: macOS HVF, Linux KVM
- Software rendering fallback when no GPU detected
- USB device passthrough for testing peripheral integration
- Serial console access for debugging
- Configurable display resolution and QEMU flags
- Debug mode with systemd and console output

### 3.7 USB Passthrough Management

**Headline**: Test with real peripherals in your virtual environment.

**Details**:
- `strux usb add` — auto-detect connected USB devices with interactive selection
- `strux usb list` — view and manage configured devices
- Saved to `strux.yaml` for reproducible configuration
- Vendor/product ID based — devices are consistent across sessions

### 3.8 Custom Kernel & Bootloader

**Headline**: Full control when you need it, sensible defaults when you don't.

**Details**:
- **Custom Kernel**: Specify source repository, version, defconfig, config fragments, patches, device trees (DTS + DTSI includes), and overlays
- **Interactive Menuconfig**: `strux kernel menuconfig` opens the full Linux kernel configuration UI inside Docker — no local toolchain needed
- **Custom Bootloader**: U-Boot, GRUB, systemd-boot, or fully custom — with firmware blob support, device tree modes, and boot method selection
- **Two-Phase Kernel Build**: Extract phase + build phase with BSP hooks in between for maximum customization
- **Kernel Clean**: `strux kernel clean` with mrproper/clean/full modes

### 3.9 Single Binary Distribution

**Headline**: One file. No dependencies. Every platform.

**Details**:
- Entire CLI compiles to a single `strux` binary via Bun
- All build scripts, Dockerfiles, Go source, C source, templates, and images are embedded at compile time
- Zero runtime dependencies (Docker is the only external requirement for builds)
- Available for: Linux x64/arm64, macOS x64/arm64 (Apple Silicon), Windows x64
- Install via Homebrew (macOS), apt/dpkg (Debian/Ubuntu), rpm (Fedora/RHEL), or direct binary download
- CLI upgrades automatically invalidate cached build steps that depend on changed assets

### 3.10 TypeScript Type Generation

**Headline**: Your Go backend, fully typed in your frontend.

**Details**:
- `strux types` runs Go AST introspection on your `main.go`
- Extracts all public methods and fields from your App struct
- Generates `strux.d.ts` with proper Go-to-TypeScript type mappings
- Full IDE autocomplete and type checking for backend calls
- Runs automatically during frontend builds — always up to date
- Maps Go types to TypeScript: `string` -> `string`, `int/float` -> `number`, `bool` -> `boolean`, structs -> interfaces

---

## 4. USE CASES

### Digital Signage
Deploy dynamic content displays across retail locations, airports, transit systems, and advertising networks. Build the UI in React, manage content from the Go backend, and push updates to thousands of screens.

### Point-of-Sale Systems
Build secure, purpose-built checkout terminals. The locked-down kiosk mode prevents users from escaping the application, while the Go backend handles payment processing and inventory integration.

### Interactive Kiosks
Self-service information terminals, ticketing machines, wayfinding displays, and check-in stations. The web-native UI makes it easy to build rich, touch-friendly interfaces.

### Industrial Control Panels
Monitoring dashboards and equipment interfaces for factory floors, server rooms, and industrial environments. Real-time data visualization in the browser, hardware control through Go.

### Museum & Art Installations
Interactive exhibits with custom UIs. Rapid prototyping with hot-reload means artists and designers can iterate in real-time while the installation runs.

### Embedded Appliances
Single-purpose IoT devices with web-based management interfaces — media players, smart home panels, network appliances, and more.

---

## 5. QUICK START / GETTING STARTED SECTION

### Prerequisites
- **Docker**: Required for the containerized build process
- **Go 1.24+**: For Go application compilation and type introspection
- **Node.js + npm**: For frontend tooling
- **QEMU** (optional): For local testing without hardware

### Installation

**macOS (Homebrew)**:
```bash
brew tap strux-dev/strux
brew install strux
```

**Linux (Debian/Ubuntu)**:
```bash
wget https://github.com/strux-dev/strux/releases/latest/download/strux_VERSION_amd64.deb
sudo dpkg -i strux_VERSION_amd64.deb
```

**Linux (Fedora/RHEL)**:
```bash
wget https://github.com/strux-dev/strux/releases/latest/download/strux-VERSION-1.x86_64.rpm
sudo rpm -i strux-VERSION-1.x86_64.rpm
```

**Direct Binary Download**:
| Platform | Architecture | Binary |
|----------|--------------|--------|
| Linux | x64 | `strux-linux-x64` |
| Linux | arm64 | `strux-linux-arm64` |
| macOS | x64 (Intel) | `strux-darwin-x64` |
| macOS | arm64 (Apple Silicon) | `strux-darwin-arm64` |
| Windows | x64 | `strux-windows-x64.exe` |

### Your First Kiosk OS in 4 Steps

```bash
# 1. Create a new project
strux init my-kiosk --template react --arch arm64

# 2. Build the OS image
cd my-kiosk
strux build qemu

# 3. Test it in QEMU
strux run

# 4. Start developing with hot-reload
strux dev
```

### Project Structure
```
my-kiosk/
├── strux.yaml          # Project configuration
├── main.go             # Go application backend
├── go.mod              # Go module
├── frontend/           # React/Vue/vanilla frontend
│   ├── index.html
│   └── src/
├── bsp/                # Board Support Packages
│   └── qemu/           # Default QEMU BSP for testing
│       ├── bsp.yaml    # Hardware configuration
│       ├── overlay/    # BSP-specific filesystem overlay
│       └── scripts/    # Lifecycle scripts
├── assets/             # Static assets (splash logo, etc.)
│   └── logo.png
└── overlay/            # Global filesystem overlay
```

---

## 6. CLI COMMANDS REFERENCE

| Command | Description |
|---------|-------------|
| `strux init <name>` | Scaffold a new project (React/Vue/vanilla, arm64/x86_64/armhf) |
| `strux build <bsp>` | Build a bootable OS image for a target BSP |
| `strux build <bsp> --clean` | Force a clean rebuild from scratch |
| `strux build <bsp> --dev` | Build a development image |
| `strux run` | Launch the built image in QEMU |
| `strux run --debug` | Launch with console/systemd output visible |
| `strux dev` | Start hot-reload development mode (QEMU) |
| `strux dev --remote` | Dev mode for remote hardware (no QEMU) |
| `strux types` | Generate TypeScript types from Go structs |
| `strux usb add` | Auto-detect and configure USB passthrough |
| `strux usb list` | List and manage configured USB devices |
| `strux kernel menuconfig` | Interactive kernel configuration UI |
| `strux kernel clean` | Clean kernel build artifacts |

---

## 7. CONFIGURATION REFERENCE

### strux.yaml — Project Configuration

```yaml
strux_version: 0.0.1
name: my-kiosk
bsp: qemu
hostname: my-device

boot:
  splash:
    enabled: true
    logo: ./assets/logo.png
    color: "000000"

rootfs:
  overlay: ./overlay
  packages:
    - curl
    - wget

qemu:
  enabled: true
  network: true
  usb: []
  flags:
    - -m 2G

build:
  host_packages:
    - curl

dev:
  server:
    fallback_hosts:
      - host: 10.0.2.2
        port: 8000
    use_mdns_on_client: true
    client_key: YOUR_KEY_HERE
```

### bsp.yaml — Hardware Configuration

```yaml
strux_version: 0.0.1
bsp:
  name: rpi4
  description: "Raspberry Pi 4"
  arch: arm64

  display:
    resolution: 1920x1080

  boot:
    kernel:
      custom_kernel: true
      source: https://github.com/raspberrypi/linux.git
      version: "6.1"
      defconfig: bcm2711_defconfig
      fragments:
        - ./kernel/kiosk.cfg
      patches:
        - ./kernel/patches/custom-driver.patch
      device_tree:
        dts:
          - bcm2711-rpi-4-b.dts
        includes:
          - ./kernel/dtsi/custom-overlay.dtsi
        overlays:
          - ./kernel/overlays/touchscreen.dtbo

    bootloader:
      enabled: true
      type: u-boot
      source: https://github.com/u-boot/u-boot.git
      version: "2025.10"
      defconfig: rpi_4_defconfig

  rootfs:
    overlay: ./overlay
    packages:
      - firmware-brcm80211

  scripts:
    - location: ./scripts/make-image.sh
      step: make_image
      description: "Create SD card image"
```

---

## 8. ARCHITECTURE PAGE CONTENT

### How Strux Builds Your OS

**The 12-Step Build Pipeline**:

1. **Frontend** — Compile TypeScript types, bundle with Vite
2. **Application** — Cross-compile your Go backend for the target architecture
3. **Cage Compositor** — Compile the Wayland compositor (kiosk mode)
4. **WPE Extension** — Compile the WebKit-to-Go IPC bridge
5. **Strux Client** — Compile the on-device lifecycle manager
6. **Base RootFS** — Bootstrap minimal Debian via debootstrap (cached)
7. **Kernel** — Compile custom Linux kernel (if configured)
8. **Bootloader** — Compile U-Boot/GRUB (if configured)
9. **Post RootFS** — Install packages, apply overlays, configure services
10. **BSP Scripts** — Run hardware-specific lifecycle hooks
11. **Bundle** — Collect all artifacts
12. **Image Assembly** — Create the final bootable disk image

All steps run inside Docker for reproducibility. Each step tracks its own dependencies and only rebuilds when inputs change.

### The IPC Bridge — Go Meets JavaScript

Strux's IPC bridge is what makes the developer experience seamless:

1. Your Go `App` struct's public fields and methods are discovered via reflection at runtime
2. A JSON-RPC protocol over Unix sockets connects the WPE WebKit extension to your Go process
3. The WPE extension exposes your Go API as JavaScript objects on `window.go.main.App`
4. `strux types` analyzes your Go code via AST introspection and generates TypeScript definitions
5. Your frontend gets full autocomplete, type checking, and promise-based async calls

**Dual Socket Architecture**: The IPC uses two Unix sockets — one for synchronous field access (never blocks), one for async method calls with promise tracking and queue management. This prevents UI freezes when backend methods take time.

### The On-Device Client

The Strux Client is a Go binary that manages everything on the device:

- **Production Mode**: Starts Cage compositor, launches Cog browser with your app, manages process lifecycle, handles graceful shutdown
- **Development Mode**: Discovers dev server via mDNS, receives binary updates over WebSocket, redirects to Vite HMR server, enables WebKit Inspector for debugging
- **Network Intelligence**: Multi-step network readiness checks (port availability, IPv4 address verification, default route confirmation) before launching the UI
- **Display Management**: Reads display configuration, sets resolution via `wlr-randr`

---

## 9. WHY STRUX? — COMPARISON SECTION

### vs. Yocto / Buildroot
| | Strux | Yocto/Buildroot |
|---|---|---|
| Learning curve | Web dev familiar | Steep, specialized |
| Build time (incremental) | Minutes (smart caching) | Often 30min+ |
| Dev iteration | Hot-reload (Go + frontend) | Full rebuild cycle |
| Frontend | React / Vue / vanilla JS | Custom, manual |
| Type safety | Auto-generated TS types | None |
| Configuration | YAML | Bitbake recipes / Kconfig |

### vs. Electron on Linux
| | Strux | Electron |
|---|---|---|
| OS footprint | Minimal (purpose-built) | Full desktop Linux |
| Resource usage | Lightweight (WPE WebKit) | Heavy (Chromium) |
| Backend | Go (native performance) | Node.js |
| Kiosk mode | Built-in (Cage compositor) | Requires configuration |
| Boot time | Seconds (minimal init) | Desktop boot + app launch |
| Security | Locked-down by design | Full OS surface area |

### vs. Android Kiosk Mode
| | Strux | Android Kiosk |
|---|---|---|
| Dependencies | None (Docker for builds) | Google Play Services |
| Customization | Full (kernel, bootloader) | Limited to app layer |
| Boot time | Seconds | Android full boot |
| Updates | Your control | Google's schedule |
| License | GPLv2 | Proprietary |
| Hardware support | Any Linux-compatible | Android-certified |

---

## 10. TECHNICAL HIGHLIGHTS FOR DEVELOPERS

### Single Binary, Zero Dependencies
The entire Strux CLI — including all build scripts, Dockerfiles, Go source code for the client, C source code for the compositor and WebKit extension, project templates, and even the splash screen logo — is embedded into a single binary at compile time using Bun's import attributes. No runtime dependencies besides Docker.

### Reproducible Builds by Design
Every build step runs inside Docker. The Dockerfile itself is embedded in the CLI and hashed — if it changes between CLI versions, all cached steps are automatically invalidated. Build scripts, artifacts, and dependencies are all version-tracked.

### Extensible Runtime
The Go runtime includes an extension registry system. Built-in extensions provide boot management (`strux.boot.HideSplash()`, `strux.boot.Reboot()`, `strux.boot.Shutdown()`). The architecture supports pluggable extensions for storage, networking, and other framework features.

### Automatic GPU Detection
When running in QEMU, Strux analyzes sysfs GPU connector entries to auto-detect KMS-capable GPUs and enable hardware-accelerated rendering. Falls back gracefully to software rendering.

### Debian 13 Trixie Base
Built on Debian 13 (Trixie) with long-term support through 2030. Minimal rootfs via debootstrap with full package customization — install only what your device needs.

---

## 11. WEBSITE PAGE STRUCTURE (SUGGESTED)

1. **Home** — Hero, key value props, quick start, use cases
2. **Features** — Detailed feature breakdown with code examples and diagrams
3. **Docs** — Full documentation (getting started, configuration, CLI reference, architecture, BSP guide)
4. **Blog** — Release notes, tutorials, case studies
5. **GitHub** — Link to `github.com/strux-dev/strux`
6. **Community** — Discord/Discussions link (if applicable)

---

## 12. SEO & METADATA

### Keywords
- kiosk operating system
- embedded Linux framework
- digital signage OS
- build custom Linux
- kiosk mode Linux
- Go + React embedded
- single purpose Linux
- POS operating system
- embedded display OS
- Linux kiosk framework

### Page Titles
- Home: "Strux OS — Build Kiosk Operating Systems with Web Technologies"
- Features: "Features — Strux OS"
- Docs: "Documentation — Strux OS"
- Getting Started: "Quick Start — Strux OS"

### Meta Description
"Strux OS is an open-source CLI framework for building minimal, bootable Linux operating systems for kiosks, digital signage, POS systems, and embedded displays. Build with React/Vue + Go, test in QEMU, deploy anywhere."

---

## 13. VISUAL / DESIGN NOTES

### Suggested Visual Elements
- **Terminal recordings / GIFs**: Show `strux init`, `strux build`, `strux dev` workflows
- **Architecture diagrams**: Full stack diagram, build pipeline, dev mode data flow
- **Code examples**: Side-by-side Go backend + TypeScript frontend with type bridge
- **Screenshot of dev mode TUI**: The tabbed Ink terminal interface during `strux dev`
- **Before/after comparison**: Traditional embedded Linux workflow vs. Strux workflow

### Color Palette Suggestions
- Developer-focused, dark theme friendly
- Terminal green / electric blue accents on dark backgrounds
- Clean, technical typography (monospace for code, sans-serif for copy)

---

## 14. OPEN SOURCE & COMMUNITY

- **License**: GPLv2
- **GitHub**: github.com/strux-dev/strux
- **Status**: Alpha (v0.0.19 current, v0.1.0 upcoming)
- **Install**: Homebrew, apt, rpm, direct binary download
- **Platforms**: macOS (Intel + Apple Silicon), Linux (x64 + arm64), Windows (x64)

---

## 15. FAQ CONTENT

**Q: What hardware does Strux support?**
A: Strux targets ARM64, x86_64, and ARMhf architectures. Any Linux-compatible hardware can be supported through custom Board Support Packages. QEMU is included for local testing without hardware.

**Q: Do I need embedded Linux experience?**
A: No. If you can build a web app with React/Vue and write Go, you can build a Strux OS image. The framework handles all the embedded Linux complexity — kernel, bootloader, rootfs, compositor, and device management.

**Q: How does the Go-to-JavaScript bridge work?**
A: Strux uses a WPE WebKit extension that communicates with your Go backend over Unix sockets using a JSON-RPC protocol. Your Go struct's public methods and fields are discovered via reflection and exposed as JavaScript objects. TypeScript types are auto-generated from Go AST analysis.

**Q: Can I use a custom Linux kernel?**
A: Yes. BSP configuration supports custom kernel source, version, defconfig, config fragments, patches, device trees (DTS/DTSI), and device tree overlays. `strux kernel menuconfig` opens the interactive kernel configuration UI inside Docker.

**Q: How fast are incremental builds?**
A: Strux tracks dependencies at the individual file and YAML key level. If you only change your Go code, only the application compilation step re-runs. A full first build takes longer (debootstrap, kernel compilation), but subsequent builds typically take minutes.

**Q: Can I develop on real hardware?**
A: Yes. Build a dev image with `strux build <bsp> --dev`, flash it to your device, then run `strux dev --remote`. The device discovers the dev server via mDNS, and you get hot-reload for both Go and frontend code on physical hardware.

**Q: What's the base operating system?**
A: Debian 13 (Trixie), with long-term support through 2030. The rootfs is minimal — built via debootstrap with only the packages you specify.

**Q: Is this production-ready?**
A: Strux is currently in alpha. The core build pipeline, dev mode, and QEMU emulation are functional. We recommend it for prototyping and development, with production deployments coming as the project matures.
