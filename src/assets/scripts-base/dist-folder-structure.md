# Dist Folder Structure

This document describes the structure of the `dist/` directory created during the Strux OS build process.

## Overview

The `dist/` directory contains source code, build artifacts, compiled binaries, and intermediate files generated during the build process. It is created at the project root and serves as the output directory for all build operations.

**Key Principle**: Source code lives at the root of `dist/`, while all compiled results are stored in `dist/cache/`.

## Directory Structure

```
dist/
├── artifacts/              # Build artifacts and configuration files
│   ├── Dockerfile         # Docker build file for build environment
│   ├── scripts/           # System scripts
│   │   ├── init.sh        # Init script (copied to rootfs /init)
│   │   └── strux-network.sh  # Network configuration script
│   ├── systemd/           # Systemd service files
│   │   ├── strux.service  # Main Strux service
│   │   ├── strux-network.service  # Network service
│   │   └── 20-ethernet.network  # Network configuration
│   ├── plymouth/          # Plymouth boot splash theme
│   │   ├── strux.plymouth # Plymouth theme configuration
│   │   ├── strux.script   # Plymouth theme script
│   │   └── plymouthd.conf # Plymouth daemon configuration
│   └── logo.png           # Logo file (used by Plymouth and app)
│
├── cage/                  # Cage source code (cloned repository)
│
├── extension/             # WPE Extension source code (cloned repository)
│
├── kernel/                # Custom kernel source code (if custom kernel enabled)
│
└── cache/                 # All compiled results and build cache
    ├── app/               # Compiled application binaries
    │   └── main          # Compiled Go application binary
    │
    ├── frontend/          # Frontend build output
    │   └── dist/         # Built frontend files (HTML, CSS, JS)
    │
    ├── cage              # Cage compositor binary (Wayland compositor)
    │
    ├── libstrux-extension.so  # WPE WebKit extension library
    │
    ├── kernel/            # Custom kernel compiled artifacts (if custom kernel enabled)
    │   ├── vmlinuz       # Kernel image (generic name)
    │   ├── Image         # Kernel image (ARM64)
    │   ├── bzImage       # Kernel image (x86_64)
    │   └── modules/      # Kernel modules
    │       └── <kernel-version>/  # Kernel modules for specific version
    │
    ├── vmlinuz           # Final kernel image (copied from kernel/ or Debian)
    │
    ├── initrd.img        # Final initramfs (or dev-initrd.img in dev mode)
    │
    ├── extension_build/  # Extension build directory (temporary, during build)
    │
    └── rootfs-base.tar.gz  # Cached base rootfs tarball
```

## File Descriptions

### Source Code Directories

- **`cage/`**: Cage compositor source code (cloned from repository)
- **`extension/`**: WPE Extension source code (cloned from repository)
- **`kernel/`**: Custom kernel source code (if custom kernel is enabled)

### Build Artifacts (`artifacts/`)

- **`Dockerfile`**: Docker build file used to create the build environment image
- **`scripts/init.sh`**: Init script that runs as PID 1 in the rootfs
- **`scripts/strux-network.sh`**: Network configuration script used by systemd service
- **`systemd/*.service`**: Systemd unit files for services
- **`systemd/*.network`**: Systemd network configuration files
- **`plymouth/*`**: Plymouth boot splash theme files
- **`logo.png`**: Logo image used by Plymouth and the application

### Compiled Binaries (`cache/`)

- **`cache/app/main`**: Compiled Go application binary (cross-compiled for target architecture)
- **`cache/cage`**: Cage compositor binary (Wayland compositor with splash support)
- **`cache/libstrux-extension.so`**: WPE WebKit extension library (bridge between Go and WebKit)

### Frontend (`cache/frontend/`)

- **`cache/frontend/dist/`**: Built frontend files (HTML, CSS, JavaScript bundles)

### Kernel Files (`cache/kernel/`)

- **`cache/kernel/`**: Custom kernel compiled artifacts (only present if custom kernel is enabled)
  - Kernel image files (`vmlinuz`, `Image`, or `bzImage`)
  - Kernel modules directory
  - Optional initramfs if provided by kernel build script
- **`cache/vmlinuz`**: Final kernel image (copied from `cache/kernel/` or installed from Debian)
- **`cache/initrd.img`**: Final initramfs (generated or copied from kernel build)
- **`cache/dev-initrd.img`**: Initramfs for dev mode (if `STRUX_DEV_MODE=1`)

### Build Cache (`cache/`)

- **`cache/rootfs-base.tar.gz`**: Cached base rootfs tarball to speed up subsequent builds

### Temporary Directories (`cache/`)

- **`cache/extension_build/`**: Extension build directory during compilation (temporary)

## Build Process Flow

1. **Frontend Build** → `dist/cache/frontend/`
2. **Application Build** → `dist/cache/app/main`
3. **Cage Build** → Source: `dist/cage/`, Output: `dist/cache/cage`
4. **WPE Extension Build** → Source: `dist/extension/`, Output: `dist/cache/libstrux-extension.so`
5. **Artifacts Copy** → `dist/artifacts/` (Plymouth, scripts, systemd files)
6. **Kernel Build** (if custom) → Source: `dist/kernel/`, Output: `dist/cache/kernel/`
7. **RootFS Build** → Uses artifacts and creates `dist/cache/rootfs-base.tar.gz`
8. **RootFS Post-Processing** → Copies files from `dist/cache/` into rootfs, generates final `dist/cache/initrd.img`

## Cache Checking

When checking if a build artifact exists (to skip rebuilding), the system checks for the compiled files in `dist/cache/`:

- **Cage**: `dist/cache/cage`
- **Extension**: `dist/cache/libstrux-extension.so`
- **App**: `dist/cache/app/main`
- **Frontend**: `dist/cache/frontend/`
- **Kernel**: `dist/cache/kernel/` (if custom kernel)

## Notes

- The `dist/` directory is created automatically at the start of the build process
- Source code directories (`cage/`, `extension/`, `kernel/`) persist between builds to avoid re-cloning
- All compiled results are stored in `dist/cache/` for easy cleanup and organization
- The `cache/` directory helps speed up subsequent builds by caching compiled binaries and the base rootfs
- In dev mode, `dev-initrd.img` is used instead of `initrd.img`
- Temporary build directories (`cache/extension_build/`) may persist between builds
