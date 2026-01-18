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

# Project directory (mounted at /project in Docker container)
PROJECT_DIR="/project"
PROJECT_DIST_DIR="/project/dist"
# Use BSP_CACHE_DIR if provided, otherwise fallback to default
PROJECT_CACHE_DIR="${BSP_CACHE_DIR:-/project/dist/cache}"

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


# ============================================================================
# SECTION 3: PACKAGE COLLECTION AND SEPARATION
# ============================================================================
# This section collects packages from both global and BSP-specific configs,
# then separates them into:
# - Repository packages (installed via apt-get)
# - .deb file paths (copied and installed via dpkg)
#
# Path resolution rules:
# - Global packages: relative to project root (/project)
# - BSP packages starting with ./: relative to BSP folder (/project/bsp/{bsp_name})
# - BSP packages without ./: relative to project root
# ============================================================================

# Collect packages from global rootfs.packages
GLOBAL_PACKAGES=$(yq '.rootfs.packages[]?' "$PROJECT_DIR/strux.yaml" 2>/dev/null || echo "")

# Collect packages from BSP-specific rootfs.packages
BSP_PACKAGES=$(yq '.bsp.rootfs.packages[]?' "$BSP_CONFIG" 2>/dev/null || echo "")

# Separate repository packages from .deb file paths
REPO_PACKAGES=""
DEB_FILES=""

# Process global packages (relative to project root)
while IFS= read -r package; do
    if [ -z "$package" ]; then
        continue
    fi
    
    # Check if it's a .deb file (ends with .deb)
    if [[ "$package" == *.deb ]]; then
        # Global packages are relative to project root
        # Normalize path (remove ./ prefix if present)
        normalized_package="${package#./}"
        
        # Resolve the path relative to project directory
        if [ -f "$PROJECT_DIR/$normalized_package" ]; then
            DEB_FILES="$DEB_FILES$normalized_package\n"
        elif [ -f "$package" ]; then
            # Absolute path
            DEB_FILES="$DEB_FILES$package\n"
        else
            echo "Warning: .deb file not found: $package (checked: $PROJECT_DIR/$normalized_package)"
        fi
    else
        # It's a repository package name
        REPO_PACKAGES="$REPO_PACKAGES$package "
    fi
done <<< "$GLOBAL_PACKAGES"

# Process BSP packages (paths starting with ./ are relative to BSP folder)
while IFS= read -r package; do
    if [ -z "$package" ]; then
        continue
    fi
    
    # Check if it's a .deb file (ends with .deb)
    if [[ "$package" == *.deb ]]; then
        # BSP packages: if starts with ./, resolve relative to BSP folder, otherwise relative to project root
        if [[ "$package" == ./* ]]; then
            # Remove ./ prefix and resolve relative to BSP folder
            bsp_relative_path="${package#./}"
            if [ -f "$BSP_FOLDER/$bsp_relative_path" ]; then
                DEB_FILES="$DEB_FILES$BSP_FOLDER/$bsp_relative_path\n"
            else
                echo "Warning: .deb file not found: $package (checked: $BSP_FOLDER/$bsp_relative_path)"
            fi
        else
            # Not starting with ./, resolve relative to project root (like global packages)
            normalized_package="${package#./}"
            if [ -f "$PROJECT_DIR/$normalized_package" ]; then
                DEB_FILES="$DEB_FILES$normalized_package\n"
            elif [ -f "$package" ]; then
                # Absolute path
                DEB_FILES="$DEB_FILES$package\n"
            else
                echo "Warning: .deb file not found: $package (checked: $PROJECT_DIR/$normalized_package)"
            fi
        fi
    else
        # It's a repository package name - check if already added (avoid duplicates)
        if [[ ! " $REPO_PACKAGES " =~ " $package " ]]; then
            REPO_PACKAGES="$REPO_PACKAGES$package "
        fi
    fi
done <<< "$BSP_PACKAGES"

# Trim trailing spaces/newlines
REPO_PACKAGES=$(echo "$REPO_PACKAGES" | sed 's/[[:space:]]*$//')
DEB_FILES=$(echo -e "$DEB_FILES" | grep -v '^$' || true)

# ============================================================================
# SECTION 4: BUILD ENVIRONMENT SETUP
# ============================================================================
# This section sets up the build environment variables and prepares
# the root filesystem directory.
# ============================================================================

# We use Debian Forky as it contains the latest wlroots (0.19)
DEBIAN_SUITE="forky"

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
# SECTION 5: ROOT FILESYSTEM CREATION (DEBOOTSTRAP)
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
# SECTION 6: SYSTEM CONFIGURATION AND CHROOT SETUP
# ============================================================================
# This section configures the base system:
# - Sets up APT sources
# - Mounts necessary filesystems for chroot operations
# - Updates package lists
# ============================================================================

progress "Configuring apt sources..."

# Configure apt sources for Forky
cat > "$ROOTFS_DIR/etc/apt/sources.list" << 'EOF'
deb http://deb.debian.org/debian forky main contrib non-free non-free-firmware
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
# SECTION 7: SYSTEM PACKAGE INSTALLATION
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
    libwlroots-0.19 \
    wayland-protocols \
    libwayland-client0 \
    libwayland-server0 \
    cog \
    libwpewebkit-2.0-1 \
    libwpe-1.0-1 \
    libwpebackend-fdo-1.0-1"

# Install fonts and media support
progress "Installing fonts and media support..."
run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    fonts-dejavu-core \
    fonts-noto-core \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good"



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
    systemd-resolved"

# ============================================================================
# SECTION 8: CUSTOM PACKAGE INSTALLATION
# ============================================================================
# This section installs user-specified packages from the configuration:
# - Repository packages: Installed via apt-get
# - .deb files: Copied to chroot and installed via dpkg
# ============================================================================

# Install repository packages from config
if [ -n "$REPO_PACKAGES" ]; then
    progress "Installing repository packages..."
    run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        $REPO_PACKAGES"
else
    progress "No repository packages to install"
fi

# Copy and install custom .deb package files
if [ -n "$DEB_FILES" ]; then
    progress "Copying and installing custom .deb package files..."
    
    # Create temporary directory for .deb files in chroot
    DEB_TEMP_DIR="$ROOTFS_DIR/tmp/deb-packages"
    mkdir -p "$DEB_TEMP_DIR"
    
    # Copy each .deb file to chroot and install it
    while IFS= read -r deb_file; do
        if [ -z "$deb_file" ]; then
            continue
        fi
        
        # Normalize path (remove ./ prefix if present)
        deb_file="${deb_file#./}"
        
        # Resolve the path - try relative to project directory first, then absolute
        if [ -f "$PROJECT_DIR/$deb_file" ]; then
            SOURCE_FILE="$PROJECT_DIR/$deb_file"
        elif [ -f "$deb_file" ]; then
            SOURCE_FILE="$deb_file"
        else
            echo "Warning: Skipping .deb file not found: $deb_file (checked: $PROJECT_DIR/$deb_file and $deb_file)"
            continue
        fi
        
        # Get just the filename
        DEB_FILENAME=$(basename "$SOURCE_FILE")
        TARGET_FILE="$DEB_TEMP_DIR/$DEB_FILENAME"
        
        # Copy .deb file to chroot
        cp "$SOURCE_FILE" "$TARGET_FILE"
        
        # Install the .deb file inside chroot
        progress "Installing $DEB_FILENAME..."
        run_in_chroot "DEBIAN_FRONTEND=noninteractive dpkg -i /tmp/deb-packages/$DEB_FILENAME || apt-get install -f -y"
    done <<< "$DEB_FILES"
    
    # Clean up temporary directory
    rm -rf "$DEB_TEMP_DIR"
    run_in_chroot "rm -rf /tmp/deb-packages" || true
else
    progress "No .deb package files to install"
fi


# ============================================================================
# SECTION 9: INSTALL DEFAULT KERNEL (IF NOT USING CUSTOM KERNEL)
# ============================================================================
# This section installs the Debian kernel if we are not using a custom kernel.
# If STRUX_CUSTOM_KERNEL is true, the kernel will be built separately.
# ============================================================================

# Check if custom kernel is enabled in BSP config
CUSTOM_KERNEL=$(yq '.bsp.boot.kernel.custom_kernel' "$BSP_CONFIG" 2>/dev/null || echo "false")

# Set STRUX_CUSTOM_KERNEL environment variable based on BSP config
if [ "$CUSTOM_KERNEL" = "true" ]; then
    STRUX_CUSTOM_KERNEL="true"
    progress "Custom kernel enabled in BSP config - skipping Debian kernel installation"
else
    STRUX_CUSTOM_KERNEL="false"
fi

export STRUX_CUSTOM_KERNEL


# Fetch kernel from Debian repos (if not building custom kernel)
if [ "${STRUX_CUSTOM_KERNEL:-false}" != "true" ]; then
    progress "Installing Debian kernel..."
    run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends linux-image-$DEBIAN_ARCH"

    # Find and copy the kernel
    progress "Extracting kernel image..."
    VMLINUZ=$(ls "$ROOTFS_DIR/boot/vmlinuz-"* 2>/dev/null | head -n 1)
    if [ -n "$VMLINUZ" ]; then
        mkdir -p "$PROJECT_CACHE_DIR"
        cp "$VMLINUZ" "$PROJECT_CACHE_DIR/vmlinuz"
        echo "Kernel copied to $PROJECT_CACHE_DIR/vmlinuz"
    fi

    # Find and copy the initramfs
    INITRD=$(ls "$ROOTFS_DIR/boot/initrd.img-"* 2>/dev/null | head -n 1)
    if [ -n "$INITRD" ]; then
        mkdir -p "$PROJECT_CACHE_DIR"
        cp "$INITRD" "$PROJECT_CACHE_DIR/initrd.img"
        echo "Initramfs copied to $PROJECT_CACHE_DIR/initrd.img"
    fi

    # Get kernel version for depmod
    KERNEL_VERSION=$(ls "$ROOTFS_DIR/lib/modules" 2>/dev/null | head -n 1)
    if [ -n "$KERNEL_VERSION" ]; then
        progress "Generating module dependencies..."
        run_in_chroot "depmod $KERNEL_VERSION"
        echo "Module dependencies generated for kernel $KERNEL_VERSION"
    fi
else
    progress "Custom kernel enabled - installing custom kernel and generating initramfs"
    
    # Check if custom kernel compiled artifacts exist in cache
    if [ ! -f "$PROJECT_CACHE_DIR/kernel/vmlinuz" ] && [ ! -f "$PROJECT_CACHE_DIR/kernel/Image" ] && [ ! -f "$PROJECT_CACHE_DIR/kernel/bzImage" ]; then
        echo "Error: Custom kernel image not found in $PROJECT_CACHE_DIR/kernel/"
        echo "Expected one of: vmlinuz, Image (ARM64), zImage (ARMHF), or bzImage (x86_64)"
        exit 1
    fi
    
    # Determine kernel image name and architecture-specific path
    if [ "$DEBIAN_ARCH" = "arm64" ]; then
        KERNEL_IMAGE="$PROJECT_CACHE_DIR/kernel/Image"
        KERNEL_NAME="Image"
    elif [ "$DEBIAN_ARCH" = "armhf" ]; then
        KERNEL_IMAGE="$PROJECT_CACHE_DIR/kernel/zImage"
        KERNEL_NAME="zImage"
    else
        KERNEL_IMAGE="$PROJECT_CACHE_DIR/kernel/bzImage"
        KERNEL_NAME="bzImage"
    fi
    
    # Fallback to vmlinuz if architecture-specific image not found
    if [ ! -f "$KERNEL_IMAGE" ]; then
        KERNEL_IMAGE="$PROJECT_CACHE_DIR/kernel/vmlinuz"
        KERNEL_NAME="vmlinuz"
    fi
    
    if [ ! -f "$KERNEL_IMAGE" ]; then
        echo "Error: Custom kernel image not found: $KERNEL_IMAGE"
        exit 1
    fi
    
    # Copy kernel image to cache directory
    progress "Copying custom kernel image..."
    mkdir -p "$PROJECT_CACHE_DIR"
    cp "$KERNEL_IMAGE" "$PROJECT_CACHE_DIR/vmlinuz"
    echo "Custom kernel copied to $PROJECT_CACHE_DIR/vmlinuz"
    
    # Install kernel modules into rootfs (if they exist)
    if [ -d "$PROJECT_CACHE_DIR/kernel/modules" ]; then
        progress "Installing custom kernel modules..."
        KERNEL_VERSION=$(ls "$PROJECT_CACHE_DIR/kernel/modules" 2>/dev/null | head -n 1)
        
        if [ -n "$KERNEL_VERSION" ]; then
            # Copy modules to rootfs
            mkdir -p "$ROOTFS_DIR/lib/modules"
            cp -r "$PROJECT_CACHE_DIR/kernel/modules/$KERNEL_VERSION" "$ROOTFS_DIR/lib/modules/"
            
            # Generate module dependencies
            progress "Generating module dependencies..."
            run_in_chroot "depmod $KERNEL_VERSION"
            echo "Module dependencies generated for kernel $KERNEL_VERSION"
        else
            echo "Warning: No kernel version found in modules directory"
        fi
    else
        echo "Warning: Kernel modules directory not found at $PROJECT_CACHE_DIR/kernel/modules"
    fi
    
    # Install initramfs-tools if not already installed
    progress "Installing initramfs-tools..."
    run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends initramfs-tools" || true
    
    # Generate initramfs using update-initramfs
    if [ -n "$KERNEL_VERSION" ]; then
        progress "Generating initial initramfs for custom kernel..."
        # Generate initramfs
        run_in_chroot "update-initramfs -c -k $KERNEL_VERSION" || {
            echo "Warning: Failed to generate initramfs, trying alternative method..."
            # Alternative: use mkinitcpio-style approach or manual initramfs creation
            run_in_chroot "mkinitramfs -o /boot/initrd.img-$KERNEL_VERSION $KERNEL_VERSION" || true
        }
        
        # Find and copy the generated initramfs
        INITRD=$(ls "$ROOTFS_DIR/boot/initrd.img-$KERNEL_VERSION"* 2>/dev/null | head -n 1)
        if [ -n "$INITRD" ]; then
            mkdir -p "$PROJECT_CACHE_DIR"
            cp "$INITRD" "$PROJECT_CACHE_DIR/initrd.img"
            echo "Initramfs copied to $PROJECT_CACHE_DIR/initrd.img"
        else
            echo "Warning: Initramfs not found after generation"
        fi
    else
        echo "Warning: Cannot generate initramfs without kernel version"
    fi
fi


# ============================================================================
# SECTION 10: CLEANUP
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