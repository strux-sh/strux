#!/bin/bash

set -eo pipefail

# Trap errors and print the failing command/line
trap 'echo "Error: Command failed at line $LINENO with exit code $?: $BASH_COMMAND" >&2' ERR

progress() {
    echo "STRUX_PROGRESS: $1"
}

progress "Post-processing Root Filesystem..."

# Project directory (mounted at /project in Docker container)
PROJECT_DIR="/project"
PROJECT_DIST_DIR="/project/dist"
ROOTFS_DIR="/tmp/rootfs"

# Use BSP_CACHE_DIR if provided, otherwise fallback to default
BSP_CACHE="${BSP_CACHE_DIR:-/project/dist/cache}"
# Shared cache for architecture-agnostic artifacts like frontend
SHARED_CACHE="${SHARED_CACHE_DIR:-/project/dist/cache}"

# Function to run commands in chroot
run_in_chroot() {
    chroot "$ROOTFS_DIR" /bin/bash -c "$1"
}

# Create a temporary directory for the root filesystem
mkdir -p "$ROOTFS_DIR"

# Extract the root filesystem tarball into the temporary directory (from BSP-specific cache)
tar -xzf "$BSP_CACHE/rootfs-base.tar.gz" -C "$ROOTFS_DIR"

# Create the Strux Directory
mkdir -p "$ROOTFS_DIR/strux"

# ============================================================================
# SECTION 1: CONFIGURATION READING FROM YAML FILES
# ============================================================================
# Read the selected BSP and overlay paths from configuration files
# ============================================================================

progress "Reading configuration from YAML files..."

# Get the active BSP name - check environment variable first, then fall back to strux.yaml
if [ -n "$PRESELECTED_BSP" ]; then
    BSP_NAME="$PRESELECTED_BSP"
else
    BSP_NAME=$(yq '.bsp' "$PROJECT_DIR/strux.yaml" 2>/dev/null || echo "")
    
    if [ -z "$BSP_NAME" ]; then
        echo "Error: Could not read BSP name from $PROJECT_DIR/strux.yaml and PRESELECTED_BSP is not set"
        exit 1
    fi
fi

# Construct BSP folder path
BSP_FOLDER="$PROJECT_DIR/bsp/$BSP_NAME"
BSP_CONFIG="$BSP_FOLDER/bsp.yaml"

if [ ! -f "$BSP_CONFIG" ]; then
    echo "Error: BSP configuration file not found: $BSP_CONFIG"
    exit 1
fi

# ============================================================================
# SECTION 2: APPLY ROOTFS OVERLAYS
# ============================================================================
# Apply overlays in order: BSP overlay first, then root project overlay
# Root project overlay takes precedence (copied last)
# ============================================================================

# Read BSP overlay path from BSP config
BSP_OVERLAY=$(yq -r '.bsp.rootfs.overlay' "$BSP_CONFIG" 2>/dev/null || echo "")

# Read root project overlay path from strux.yaml
ROOT_OVERLAY=$(yq -r '.rootfs.overlay' "$PROJECT_DIR/strux.yaml" 2>/dev/null || echo "")

# Apply BSP overlay first (if it exists)
if [ -n "$BSP_OVERLAY" ]; then
    # Resolve BSP overlay path
    # If it starts with ./, resolve relative to BSP folder, otherwise relative to project root
    if [[ "$BSP_OVERLAY" == ./* ]]; then
        # Remove ./ prefix and resolve relative to BSP folder
        BSP_OVERLAY_PATH="$BSP_FOLDER/${BSP_OVERLAY#./}"
    else
        # Resolve relative to project root
        BSP_OVERLAY_PATH="$PROJECT_DIR/$BSP_OVERLAY"
    fi
    
    if [ -d "$BSP_OVERLAY_PATH" ]; then
        progress "Applying BSP rootfs overlay..."
        # Use rsync to copy overlay files, preserving permissions and overwriting existing files
        # -a: archive mode (preserves permissions, timestamps, etc.)
        # -r: recursive
        # --no-owner: don't preserve ownership (we're copying into rootfs)
        # --no-group: don't preserve group (we're copying into rootfs)
        rsync -a -K --no-owner --no-group "$BSP_OVERLAY_PATH/" "$ROOTFS_DIR/"
        progress "BSP rootfs overlay applied successfully"
    else
        echo "Warning: BSP overlay directory '$BSP_OVERLAY_PATH' does not exist, skipping BSP overlay"
    fi
fi

# Apply root project overlay second (takes precedence)
if [ -n "$ROOT_OVERLAY" ]; then
    # Root overlay is always relative to project root
    # Normalize path (remove ./ prefix if present)
    normalized_overlay="${ROOT_OVERLAY#./}"
    ROOT_OVERLAY_PATH="$PROJECT_DIR/$normalized_overlay"
    
    if [ -d "$ROOT_OVERLAY_PATH" ]; then
        progress "Applying rootfs overlay..."
        # Use rsync to copy overlay files, preserving permissions and overwriting existing files
        # -a: archive mode (preserves permissions, timestamps, etc.)
        # -r: recursive
        # --no-owner: don't preserve ownership (we're copying into rootfs)
        # --no-group: don't preserve group (we're copying into rootfs)
        rsync -a -K --no-owner --no-group "$ROOT_OVERLAY_PATH/" "$ROOTFS_DIR/"
        progress "Rootfs overlay applied successfully"
    else
        echo "Warning: Overlay directory '$ROOT_OVERLAY_PATH' does not exist, skipping overlay"
    fi
fi


# ============================================================================
# SECTION 3: COPY STRUX SCRIPTS AND BINARIES
# ============================================================================
# Copy the init script, network script, main application binary, Cage, Frontend, and Systemd services
# ============================================================================


progress "Copying Strux Scripts and Binaries..."

# Copy the init script
cp "$PROJECT_DIR/dist/artifacts/scripts/init.sh" "$ROOTFS_DIR/init"
chmod +x "$ROOTFS_DIR/init"

# Copy the strux.sh script
cp "$PROJECT_DIR/dist/artifacts/scripts/strux.sh" "$ROOTFS_DIR/strux/strux.sh"
chmod +x "$ROOTFS_DIR/strux/strux.sh"

# Install the network script (It is used by strux-network.service)
cp "$PROJECT_DIR/dist/artifacts/scripts/strux-network.sh" "$ROOTFS_DIR/usr/bin/strux-network.sh"
chmod +x "$ROOTFS_DIR/usr/bin/strux-network.sh"

# Copy the main application binary (from BSP-specific cache)
cp "$BSP_CACHE/app/main" "$ROOTFS_DIR/strux/main"
chmod +x "$ROOTFS_DIR/strux/main"

# Copy Cage (Our Custom build with Splash Support) - from BSP-specific cache
cp "$BSP_CACHE/cage" "$ROOTFS_DIR/usr/bin/cage"
chmod +x "$ROOTFS_DIR/usr/bin/cage"

# Copy the Frontend (from shared cache - architecture-agnostic)
cp -r "$SHARED_CACHE/frontend" "$ROOTFS_DIR/strux/frontend"

# Copy Strux Client (Handles a bunch of system services) - from BSP-specific cache
cp "$BSP_CACHE/client" "$ROOTFS_DIR/strux/client"
chmod +x "$ROOTFS_DIR/strux/client"

# Copy WPE WebKit Extension (provides JS bridge for strux.* API) - from BSP-specific cache
mkdir -p "$ROOTFS_DIR/usr/lib/wpe-web-extensions"
cp "$BSP_CACHE/libstrux-extension.so" "$ROOTFS_DIR/usr/lib/wpe-web-extensions/libstrux-extension.so"

# If the .dev-env.json file exists, copy it to the rootfs (from BSP-specific cache)
if [ -f "$BSP_CACHE/.dev-env.json" ]; then
    cp "$BSP_CACHE/.dev-env.json" "$ROOTFS_DIR/strux/.dev-env.json"
fi

# Read custom Cage environment variables from bsp.yaml
CAGE_ENV_COUNT=$(yq -r '.bsp.cage.env // [] | length' "$BSP_CONFIG" 2>/dev/null || echo "0")
if [ "$CAGE_ENV_COUNT" -gt 0 ]; then
    progress "Writing custom Cage environment variables..."
    yq -r '.bsp.cage.env[]' "$BSP_CONFIG" > "$ROOTFS_DIR/strux/.cage-env"
fi


# Copy the Systemd Services
progress "Copying Systemd Services..."

# Copy the Strux Service
cp "$PROJECT_DIR/dist/artifacts/systemd/strux.service" "$ROOTFS_DIR/etc/systemd/system/strux.service"

# Copy the Network Service Unit
cp "$PROJECT_DIR/dist/artifacts/systemd/strux-network.service" "$ROOTFS_DIR/etc/systemd/system/strux-network.service"

# Copy the 20-Ethernet.network Service
cp "$PROJECT_DIR/dist/artifacts/systemd/20-ethernet.network" "$ROOTFS_DIR/etc/systemd/network/20-ethernet.network"


# ============================================================================
# SECTION 4: MOUNT NECESSARY FILESYSTEMS FOR CHROOT OPERATIONS
# ============================================================================
# Mount necessary filesystems for chroot operations
# ============================================================================



# Mount necessary filesystems for chroot operations
mount --bind /dev /tmp/rootfs/dev || true
mount --bind /dev/pts /tmp/rootfs/dev/pts || true
mount --bind /proc /tmp/rootfs/proc || true
mount --bind /sys /tmp/rootfs/sys || true

# Copy QEMU static binary for cross-arch chroot if needed
if [ "$HOST_ARCH" != "$TARGET_ARCH" ]; then
    if [ "$TARGET_ARCH" = "arm64" ] && [ -f /usr/bin/qemu-aarch64-static ]; then
        cp /usr/bin/qemu-aarch64-static "$ROOTFS_DIR/usr/bin/" 2>/dev/null || true
    elif [ "$TARGET_ARCH" = "armhf" ] && [ -f /usr/bin/qemu-arm-static ]; then
        cp /usr/bin/qemu-arm-static "$ROOTFS_DIR/usr/bin/" 2>/dev/null || true
    fi
fi


# ============================================================================
# SECTION 5: INSTALL KERNEL
# ============================================================================
# This section installs the kernel into the rootfs. It handles both:
# - Default Debian kernel: installed via apt-get
# - Custom kernel: copied from pre-built artifacts in cache
# This was moved from strux-build-base.sh so that kernel changes
# don't require a full base rootfs rebuild (debootstrap + packages).
# ============================================================================

progress "Installing kernel..."

# Get architecture from BSP config
ARCH=$(yq '.bsp.arch' "$BSP_CONFIG" 2>/dev/null | xargs || echo "")

if [ -z "$ARCH" ]; then
    echo "Error: Could not read architecture from $BSP_CONFIG"
    exit 1
fi

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

# Check if custom kernel is enabled in BSP config
CUSTOM_KERNEL=$(yq '.bsp.boot.kernel.custom_kernel' "$BSP_CONFIG" 2>/dev/null || echo "false")

if [ "$CUSTOM_KERNEL" = "true" ]; then
    STRUX_CUSTOM_KERNEL="true"
else
    STRUX_CUSTOM_KERNEL="false"
fi

export STRUX_CUSTOM_KERNEL

if [ "${STRUX_CUSTOM_KERNEL:-false}" != "true" ]; then
    # ---- Default Debian Kernel ----
    progress "Installing Debian kernel..."
    run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get update"
    run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends linux-image-$DEBIAN_ARCH"

    # Find and copy the kernel to cache
    progress "Extracting kernel image..."
    VMLINUZ=$(ls "$ROOTFS_DIR/boot/vmlinuz-"* 2>/dev/null | head -n 1)
    if [ -n "$VMLINUZ" ]; then
        mkdir -p "$BSP_CACHE"
        cp "$VMLINUZ" "$BSP_CACHE/vmlinuz"
        echo "Kernel copied to $BSP_CACHE/vmlinuz"
    fi

    # Get kernel version for depmod
    KERNEL_VERSION=$(ls "$ROOTFS_DIR/lib/modules" 2>/dev/null | head -n 1)
    if [ -n "$KERNEL_VERSION" ]; then
        progress "Generating module dependencies..."
        run_in_chroot "depmod $KERNEL_VERSION"
        echo "Module dependencies generated for kernel $KERNEL_VERSION"
    fi
else
    # ---- Custom Kernel ----
    progress "Custom kernel enabled - installing custom kernel..."

    # Read kernel version from BSP config (if provided)
    KERNEL_VERSION=$(yq '.bsp.boot.kernel.version' "$BSP_CONFIG" 2>/dev/null | xargs || echo "")
    if [ "$KERNEL_VERSION" = "null" ]; then
        KERNEL_VERSION=""
    fi

    # Determine kernel image name and architecture-specific path
    if [ "$DEBIAN_ARCH" = "arm64" ]; then
        KERNEL_IMAGE="$BSP_CACHE/kernel/Image"
        KERNEL_NAME="Image"
    elif [ "$DEBIAN_ARCH" = "armhf" ]; then
        KERNEL_IMAGE="$BSP_CACHE/kernel/zImage"
        KERNEL_NAME="zImage"
    else
        KERNEL_IMAGE="$BSP_CACHE/kernel/bzImage"
        KERNEL_NAME="bzImage"
    fi

    # Fallback to vmlinuz if architecture-specific image not found
    if [ ! -f "$KERNEL_IMAGE" ]; then
        KERNEL_IMAGE="$BSP_CACHE/kernel/vmlinuz"
        KERNEL_NAME="vmlinuz"
    fi

    if [ ! -f "$KERNEL_IMAGE" ]; then
        echo "Error: Custom kernel image not found: $KERNEL_IMAGE"
        exit 1
    fi

    # Copy kernel image to cache directory
    progress "Copying custom kernel image..."
    mkdir -p "$BSP_CACHE"
    cp "$KERNEL_IMAGE" "$BSP_CACHE/vmlinuz"
    echo "Custom kernel copied to $BSP_CACHE/vmlinuz"

    # Install to rootfs /boot/ for consistency with standard kernel
    progress "Installing custom kernel to rootfs /boot/..."
    mkdir -p "$ROOTFS_DIR/boot"
    if [ -n "$KERNEL_VERSION" ]; then
        cp "$KERNEL_IMAGE" "$ROOTFS_DIR/boot/vmlinuz-$KERNEL_VERSION"
        ln -sf "vmlinuz-$KERNEL_VERSION" "$ROOTFS_DIR/boot/vmlinuz"
        echo "Custom kernel installed to $ROOTFS_DIR/boot/vmlinuz-$KERNEL_VERSION"
    else
        cp "$KERNEL_IMAGE" "$ROOTFS_DIR/boot/vmlinuz"
        echo "Custom kernel installed to $ROOTFS_DIR/boot/vmlinuz"
    fi

    # Install kernel modules into rootfs (if they exist)
    KERNEL_MODULES_PATH="$BSP_CACHE/kernel/modules/lib/modules"

    if [ -d "$KERNEL_MODULES_PATH" ]; then
        progress "Installing custom kernel modules..."
        KERNEL_VERSION=$(ls "$KERNEL_MODULES_PATH" 2>/dev/null | head -n 1)

        if [ -n "$KERNEL_VERSION" ]; then
            # Copy modules to rootfs
            mkdir -p "$ROOTFS_DIR/lib/modules"
            cp -r "$KERNEL_MODULES_PATH/$KERNEL_VERSION" "$ROOTFS_DIR/lib/modules/"

            # Generate module dependencies
            progress "Generating module dependencies..."
            run_in_chroot "depmod $KERNEL_VERSION"
            echo "Module dependencies generated for kernel $KERNEL_VERSION"
        else
            echo "Warning: No kernel version found in modules directory"
        fi
    else
        echo "Warning: Kernel modules directory not found at $KERNEL_MODULES_PATH"
        echo "  (Expected path: $BSP_CACHE/kernel/modules/lib/modules/<version>)"
    fi

    # Install initramfs-tools if not already installed
    progress "Installing initramfs-tools..."
    run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get update"
    run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends initramfs-tools" || true

    # Copy DTBs to rootfs /boot/dtbs/ if they exist
    DTB_SOURCE_DIR="$BSP_CACHE/kernel/dtbs"
    if [ -d "$DTB_SOURCE_DIR" ] && [ -n "$(ls -A "$DTB_SOURCE_DIR" 2>/dev/null)" ]; then
        progress "Copying device tree blobs to rootfs /boot/dtbs/..."
        mkdir -p "$ROOTFS_DIR/boot/dtbs"
        cp -r "$DTB_SOURCE_DIR"/* "$ROOTFS_DIR/boot/dtbs/" 2>/dev/null || true
        echo "Device tree blobs copied to $ROOTFS_DIR/boot/dtbs/"
    fi
fi


# ============================================================================
# SECTION 6: ENABLE SYSTEMD SERVICES
# ============================================================================
# Enable systemd services
# ============================================================================

# Enable systemd services
progress "Enabling systemd services..."
run_in_chroot "systemctl enable seatd.service || true"
run_in_chroot "systemctl enable dbus.service || true"
run_in_chroot "systemctl enable strux.service || true"
run_in_chroot "systemctl enable strux-network.service || true"


# Enable Plymouth services for boot splash
run_in_chroot "systemctl enable plymouth-start.service || true"
run_in_chroot "systemctl enable plymouth-read-write.service || true"

# Mask the default Plymouth quit services - we control quit from strux.sh
# This prevents Plymouth from quitting before Cage is ready
run_in_chroot "systemctl mask plymouth-quit.service || true"
run_in_chroot "systemctl mask plymouth-quit-wait.service || true"

# Disable unnecessary services to speed up boot
run_in_chroot "systemctl mask systemd-timesyncd.service || true"
run_in_chroot "systemctl mask apt-daily.timer || true"
run_in_chroot "systemctl mask apt-daily-upgrade.timer || true"

# Enable systemd-networkd for automatic network configuration
run_in_chroot "systemctl enable systemd-networkd.service || true"

# Enable systemd-networkd-wait-online to make network-online.target work
# This ensures services depending on network-online.target wait for DHCP
run_in_chroot "systemctl enable systemd-networkd-wait-online.service || true"

# Enable systemd-resolved for DNS resolution
run_in_chroot "systemctl enable systemd-resolved.service || true"

# Configure resolv.conf to use systemd-resolved stub resolver
run_in_chroot "ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf"

# Ensure nsswitch.conf uses resolve for DNS (required for systemd-resolved)
if grep -q "^hosts:" /tmp/rootfs/etc/nsswitch.conf; then
    sed -i 's/^hosts:.*/hosts:          files resolve dns/' /tmp/rootfs/etc/nsswitch.conf
fi

# Disable getty services to prevent login prompt flash during boot
run_in_chroot "systemctl mask getty@tty1.service || true"
run_in_chroot "systemctl mask getty@tty2.service || true"
run_in_chroot "systemctl mask getty@tty3.service || true"
run_in_chroot "systemctl mask getty@tty4.service || true"
run_in_chroot "systemctl mask getty@tty5.service || true"
run_in_chroot "systemctl mask getty@tty6.service || true"
run_in_chroot "systemctl mask serial-getty@ttyS0.service || true"
run_in_chroot "systemctl mask serial-getty@ttyAMA0.service || true"
run_in_chroot "systemctl mask console-getty.service || true"
run_in_chroot "systemctl mask getty.target || true"


# ============================================================================
# SECTION 7: SET HOSTNAME
# ============================================================================
# Set the hostname from YAML configuration
# Priority: strux.yaml hostname > bsp.yaml hostname
# ============================================================================

progress "Configuring hostname..."

# Read hostname from strux.yaml first, then fall back to bsp.yaml
HOSTNAME=$(yq '.hostname' "$PROJECT_DIR/strux.yaml" 2>/dev/null || echo "")

# If not found in strux.yaml, try bsp.yaml
if [ -z "$HOSTNAME" ] || [ "$HOSTNAME" = "null" ]; then
    HOSTNAME=$(yq '.bsp.hostname' "$BSP_CONFIG" 2>/dev/null || echo "")
fi

# If still not found, use a default
if [ -z "$HOSTNAME" ] || [ "$HOSTNAME" = "null" ]; then
    HOSTNAME="strux"
    echo "Warning: No hostname found in YAML files, using default: $HOSTNAME"
fi

# Configure hostname
echo "$HOSTNAME" > "$ROOTFS_DIR/etc/hostname"

# Configure hosts file
cat > "$ROOTFS_DIR/etc/hosts" << EOF
127.0.0.1   localhost $HOSTNAME
::1         localhost $HOSTNAME
EOF

echo "Hostname configured as: $HOSTNAME"

# ============================================================================

# ============================================================================
# SECTION 8: CREATE PLYMOUTH THEME AND BOOT SPLASH, REGENERATE INITRAMFS
# ============================================================================
# Create the Plymouth theme and boot splash
# ============================================================================

progress "Creating plymouth theme and boot splash..."

mkdir -p "$ROOTFS_DIR/usr/share/plymouth/themes/strux"

cp "$PROJECT_DIST_DIR/artifacts/plymouth/strux.plymouth" "$ROOTFS_DIR/usr/share/plymouth/themes/strux/strux.plymouth"
cp "$PROJECT_DIST_DIR/artifacts/plymouth/strux.script" "$ROOTFS_DIR/usr/share/plymouth/themes/strux/strux.script"

# Set Strux as the default Plymouth theme
run_in_chroot "plymouth-set-default-theme strux || true"

mkdir -p "$ROOTFS_DIR/etc/plymouth"

cp "$PROJECT_DIST_DIR/artifacts/plymouth/plymouthd.conf" "$ROOTFS_DIR/etc/plymouth/plymouthd.conf"

# Ensure initramfs includes Plymouth
mkdir -p "$ROOTFS_DIR/etc/initramfs-tools/conf.d"
echo "FRAMEBUFFER=y" > "$ROOTFS_DIR/etc/initramfs-tools/conf.d/plymouth"

cp "$PROJECT_DIST_DIR/artifacts/logo.png" "$ROOTFS_DIR/strux/logo.png"
cp "$PROJECT_DIST_DIR/artifacts/logo.png" "$ROOTFS_DIR/usr/share/plymouth/themes/strux/logo.png"

progress "Generating initramfs with Plymouth..."

# Find the kernel version
KERNEL_VERSION=$(ls /tmp/rootfs/lib/modules 2>/dev/null | head -n 1)

if [ -n "$KERNEL_VERSION" ]; then
    if [ "${STRUX_CUSTOM_KERNEL:-false}" = "true" ]; then
        # Custom kernel: create initramfs from scratch (no initrd exists yet)
        run_in_chroot "update-initramfs -c -k $KERNEL_VERSION" || {
            echo "Warning: Failed to generate initramfs, trying alternative method..."
            run_in_chroot "mkinitramfs -o /boot/initrd.img-$KERNEL_VERSION $KERNEL_VERSION" || true
        }
    else
        # Default Debian kernel: update existing initramfs (apt already created one)
        run_in_chroot "update-initramfs -u -k $KERNEL_VERSION" || echo "Warning: initramfs update failed"
    fi

    # Copy initramfs to BSP-specific cache and create symlink in rootfs
    INITRD=$(ls /tmp/rootfs/boot/initrd.img-* 2>/dev/null | head -n 1)
    if [ -n "$INITRD" ]; then
        cp "$INITRD" "$BSP_CACHE/initrd.img"
        echo "Initramfs copied to $BSP_CACHE/initrd.img"

        # Create symlink so /boot/initrd.img exists (needed by bootloaders like U-Boot/extlinux)
        INITRD_BASENAME=$(basename "$INITRD")
        ln -sf "$INITRD_BASENAME" "$ROOTFS_DIR/boot/initrd.img"
        echo "Initramfs symlink created: /boot/initrd.img -> $INITRD_BASENAME"
    fi
else
    echo "Warning: No kernel modules found, skipping initramfs generation"
fi

# ============================================================================
# SECTION 9: CLEANUP AND MOUNT POINT UNMOUNTING
# ============================================================================
# Cleanup and unmount point unmounting
# ============================================================================

# Unmount filesystems (mounted earlier for systemd operations)
umount /tmp/rootfs/sys 2>/dev/null || true
umount /tmp/rootfs/proc 2>/dev/null || true
umount /tmp/rootfs/dev/pts 2>/dev/null || true
umount /tmp/rootfs/dev 2>/dev/null || true

# Remove QEMU static binaries (not needed in final image)
rm -f /tmp/rootfs/usr/bin/qemu-aarch64-static
rm -f /tmp/rootfs/usr/bin/qemu-arm-static

# Calculate required size for ext4 image (add 20% headroom)
echo "Calculating rootfs size..."
ROOTFS_SIZE=$(du -sm /tmp/rootfs | cut -f1)
IMAGE_SIZE=$((ROOTFS_SIZE + ROOTFS_SIZE / 5 + 50))  # Add 20% + 50MB buffer
echo "Rootfs is ${ROOTFS_SIZE}MB, creating ${IMAGE_SIZE}MB ext4 image..."

# Create a tarball of the rootfs like we did for the base rootfs
progress "Creating post-processed rootfs tarball..."
mkdir -p "$BSP_CACHE"
cd /tmp/rootfs
tar -czf "$BSP_CACHE/rootfs-post.tar.gz" .
echo "Rootfs tarball created successfully."
echo "  Size: $(du -h "$BSP_CACHE/rootfs-post.tar.gz" | cut -f1)"
