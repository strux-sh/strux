#!/bin/bash

set -eo pipefail

# Trap errors and print the failing command/line
trap 'echo "Error: Command failed at line $LINENO with exit code $?: $BASH_COMMAND" >&2' ERR

# ============================================================================
# SECTION 1: INITIALIZATION AND HELPER FUNCTIONS
# ============================================================================

# Define A Function to Print Progress Messages that will be used by the Strux CLI
progress() {
    echo "STRUX_PROGRESS: $1"
}

progress "Preparing Base Root Filesystem"

PROJECT_DIR="${PROJECT_DIR:-/project}"
PROJECT_DIST_DIR="${PROJECT_DIST_DIR:-$PROJECT_DIR/dist}"
PROJECT_CACHE_DIR="${BSP_CACHE_DIR:-$PROJECT_DIST_DIR/cache}"

mkdir -p "$PROJECT_CACHE_DIR"

# ============================================================================
# SECTION 2: CONFIGURATION READING FROM YAML FILES
# ============================================================================
# This section reads the project configuration from YAML files to determine:
# - Which BSP is active
# - Target architecture
# - Packages to install (both repository packages and .deb files)
# ============================================================================

progress "Reading configuration from YAML files..."

# Get the active BSP name - check environment variable first, then fall back to strux.yaml
if [ -n "$PRESELECTED_BSP" ]; then
    BSP_NAME="$PRESELECTED_BSP"
    progress "Using BSP from environment variable: $BSP_NAME"
else
    BSP_NAME=$(yq '.bsp' "$PROJECT_DIR/strux.yaml" 2>/dev/null || echo "")
    
    if [ -z "$BSP_NAME" ]; then
        echo "Error: Could not read BSP name from $PROJECT_DIR/strux.yaml and PRESELECTED_BSP is not set"
        exit 1
    fi
    
    progress "Using BSP from strux.yaml: $BSP_NAME"
fi

# Construct BSP folder path
BSP_FOLDER="$PROJECT_DIR/bsp/$BSP_NAME"
BSP_CONFIG="$BSP_FOLDER/bsp.yaml"

if [ ! -f "$BSP_CONFIG" ]; then
    echo "Error: BSP configuration file not found: $BSP_CONFIG"
    exit 1
fi

# Get architecture from BSP config
ARCH=$(yq '.bsp.arch' "$BSP_CONFIG" 2>/dev/null | xargs || echo "")

if [ -z "$ARCH" ]; then
    echo "Error: Could not read architecture from $BSP_CONFIG"
    exit 1
fi

if [ "$ARCH" = "host" ]; then
    ARCH="${TARGET_ARCH:-$(dpkg --print-architecture 2>/dev/null || echo "")}"
    if [ -z "$ARCH" ] || [ "$ARCH" = "host" ]; then
        echo "Error: Could not resolve host architecture"
        exit 1
    fi
    progress "Resolved host architecture to $ARCH"
fi

# ============================================================================
# SECTION 3: BUILD ENVIRONMENT SETUP
# ============================================================================
# This section sets up the build environment variables and prepares
# the root filesystem directory.
# ============================================================================

# We use Debian Trixie which contains wlroots 0.18
DEBIAN_SUITE="trixie"

# Temporary Directory for the Root Filesystem
ROOTFS_DIR="/tmp/rootfs"

# Map Strux arch to Debian arch
case "$ARCH" in
    arm64|aarch64)
        DEBIAN_ARCH="arm64"
        ;;
    amd64|x86_64)
        DEBIAN_ARCH="amd64"
        ;;
    armhf|armv7|arm)
        DEBIAN_ARCH="armhf"
        ;;
    *)
        echo "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

# Clean the Root Filesystem directory and change the permissions
rm -rf "$ROOTFS_DIR"
mkdir -p "$ROOTFS_DIR"
chmod -R 777 "$ROOTFS_DIR"

# ============================================================================
# SECTION 4: ROOT FILESYSTEM CREATION (DEBOOTSTRAP)
# ============================================================================
# This section creates the base root filesystem using debootstrap.
# It handles both native and cross-architecture builds:
# - Native: Simple debootstrap
# - Cross-arch: Foreign mode with QEMU emulation for second stage
# ============================================================================

# Check if we're building for native or cross architecture
HOST_ARCH=$(dpkg --print-architecture 2>/dev/null || echo "unknown")

progress "Running debootstrap (downloading Debian packages)..."

# If the debian architecture is the same as the host architecture, we can use the native debootstrap
if [ "$DEBIAN_ARCH" = "$HOST_ARCH" ]; then
    # Native architecture - simple debootstrap
    debootstrap \
        --variant=minbase \
        --include=ca-certificates \
        "$DEBIAN_SUITE" \
        "$ROOTFS_DIR" \
        http://deb.debian.org/debian
else
    # Cross-architecture - use foreign mode with qemu
    debootstrap \
        --arch="$DEBIAN_ARCH" \
        --variant=minbase \
        --foreign \
        --include=ca-certificates \
        "$DEBIAN_SUITE" \
        "$ROOTFS_DIR" \
        http://deb.debian.org/debian

    # Copy QEMU static binary for second stage
    if [ "$DEBIAN_ARCH" = "arm64" ]; then
        cp /usr/bin/qemu-aarch64-static "$ROOTFS_DIR/usr/bin/" 2>/dev/null || true
    elif [ "$DEBIAN_ARCH" = "armhf" ]; then
        cp /usr/bin/qemu-arm-static "$ROOTFS_DIR/usr/bin/" 2>/dev/null || true
    fi

    # Run second stage inside chroot
    progress "Running debootstrap second stage..."
    chroot "$ROOTFS_DIR" /debootstrap/debootstrap --second-stage
fi

# ============================================================================
# SECTION 5: SYSTEM CONFIGURATION AND CHROOT SETUP
# ============================================================================
# This section configures the base system:
# - Sets up APT sources
# - Mounts necessary filesystems for chroot operations
# - Updates package lists
# ============================================================================

progress "Configuring apt sources..."

# Configure apt sources for Trixie
cat > "$ROOTFS_DIR/etc/apt/sources.list" << 'EOF'
deb http://deb.debian.org/debian trixie main contrib non-free non-free-firmware
EOF

# Add Forky repository for cog 0.18.5 (fixes issues present in Trixie's version)
cat > "$ROOTFS_DIR/etc/apt/sources.list.d/forky.list" << 'EOF'
deb http://deb.debian.org/debian forky main contrib non-free non-free-firmware
EOF

# Pin Forky packages to low priority (only use when explicitly requested)
# This prevents Forky from upgrading other packages automatically
cat > "$ROOTFS_DIR/etc/apt/preferences.d/forky-pinning" << 'EOF'
# Default: prefer Trixie packages
Package: *
Pin: release n=trixie
Pin-Priority: 900

# Forky packages have lower priority by default
Package: *
Pin: release n=forky
Pin-Priority: 100

# Allow cog and its dependencies from Forky
Package: cog
Pin: release n=forky
Pin-Priority: 990
EOF

progress "Mounting root filesystem for chroot..."

# Mount necessary filesystems for chroot
mount --bind /dev "$ROOTFS_DIR/dev" || true
mount --bind /dev/pts "$ROOTFS_DIR/dev/pts" || true
mount --bind /proc "$ROOTFS_DIR/proc" || true
mount --bind /sys "$ROOTFS_DIR/sys" || true

# Function to run commands in chroot
run_in_chroot() {
    chroot "$ROOTFS_DIR" /bin/bash -c "$1"
}

# Update package lists
progress "Updating package lists..."
run_in_chroot "apt-get update"

# ============================================================================
# SECTION 6: SYSTEM PACKAGE INSTALLATION
# ============================================================================
# This section installs essential system packages required for Strux OS:
# - Systemd and session management
# - Graphics stack (Mesa drivers)
# - Wayland and WPE WebKit
# - Fonts and media support
# - System utilities
# ============================================================================

# Install systemd and session management
progress "Installing systemd and core packages..."
run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    systemd \
    systemd-sysv \
    libpam-systemd \
    dbus \
    seatd \
    plymouth \
    plymouth-themes"


# Install graphics stack
progress "Installing graphics stack (Mesa drivers)..."
run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    mesa-vulkan-drivers \
    mesa-va-drivers \
    libgl1-mesa-dri \
    libgles2 \
    libegl1 \
    libgbm1"

# Install architecture-specific GPU drivers
if [ "$DEBIAN_ARCH" = "amd64" ]; then
    progress "Installing Intel/AMD GPU drivers for x86_64..."
    run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        mesa-vulkan-intel \
        intel-media-va-driver \
        libegl-mesa0 \
        libgl1-mesa-glx \
        libwayland-egl1" || true
fi


# Install Wayland and browser components
progress "Installing Wayland and WPE WebKit..."
run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    libwlroots-0.18 \
    wayland-protocols \
    libwayland-client0 \
    libwayland-server0 \
    libwpewebkit-2.0-1 \
    libwpe-1.0-1 \
    libwpebackend-fdo-1.0-1" \
    shared-mime-info

# Install cog from Forky (v0.18.5 fixes issues present in Trixie's version)
# The patched cog binary (with --autoplay-policy support) is built in
# strux-build-wpe.sh and copied over this in strux-build-post.sh.
progress "Installing cog 0.18.5 from Debian Forky..."
run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y -t forky cog"

# Install fonts and media support
progress "Installing fonts and media support..."
run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    fonts-dejavu-core \
    fonts-noto-core \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    gstreamer1.0-vaapi \
    gstreamer1.0-gl"



# Install system utilities
progress "Installing system utilities..."
run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    udev \
    kmod \
    iproute2 \
    netcat-openbsd \
    procps \
    libjson-glib-1.0-0 \
    wlr-randr \
    xwayland \
    systemd-resolved \
    libinput10 \
    libseat1"

# ============================================================================
# SECTION 7: CLEANUP
# ============================================================================
# This section cleans up the build environment.
# ============================================================================

# Clean up apt cache to reduce image size
progress "Cleaning up package cache..."
run_in_chroot "apt-get clean"
rm -rf "$ROOTFS_DIR/var/lib/apt/lists/"*
rm -rf "$ROOTFS_DIR/var/cache/apt/"*

# Unmount filesystems
progress "Unmounting filesystems..."
umount "$ROOTFS_DIR/sys" 2>/dev/null || true
umount "$ROOTFS_DIR/proc" 2>/dev/null || true
umount "$ROOTFS_DIR/dev/pts" 2>/dev/null || true
umount "$ROOTFS_DIR/dev" 2>/dev/null || true

# Remove QEMU static binaries (not needed in final image)
rm -f "$ROOTFS_DIR/usr/bin/qemu-aarch64-static"
rm -f "$ROOTFS_DIR/usr/bin/qemu-arm-static"

# Save the base rootfs as a tarball for caching
progress "Saving base rootfs cache..."
mkdir -p "$PROJECT_CACHE_DIR"
cd "$ROOTFS_DIR"
tar -czf "$PROJECT_CACHE_DIR/rootfs-base.tar.gz" .

echo "Base rootfs cache created successfully."
echo "  Size: $(du -h "$PROJECT_CACHE_DIR/rootfs-base.tar.gz" | cut -f1)"
