#!/bin/bash

set -e

progress() {
    echo "STRUX_PROGRESS: $1"
}

progress "Post-processing Root Filesystem..."

# Project directory (mounted at /project in Docker container)
PROJECT_DIR="/project"
PROJECT_DIST_DIR="/project/dist"
ROOTFS_DIR="/tmp/rootfs"

# Create a temporary directory for the root filesystem
mkdir -p "$ROOTFS_DIR"

# Extract the root filesystem tarball into the temporary directory
tar -xzf "$PROJECT_DIR/dist/cache/rootfs-base.tar.gz" -C "$ROOTFS_DIR"

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
    BSP_NAME=$(yq eval '.bsp' "$PROJECT_DIR/strux.yaml" 2>/dev/null || echo "")
    
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
BSP_OVERLAY=$(yq eval '.bsp.rootfs.overlay' "$BSP_CONFIG" 2>/dev/null || echo "")

# Read root project overlay path from strux.yaml
ROOT_OVERLAY=$(yq eval '.rootfs.overlay' "$PROJECT_DIR/strux.yaml" 2>/dev/null || echo "")

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
        rsync -a --no-owner --no-group "$BSP_OVERLAY_PATH/" "$ROOTFS_DIR/"
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
        rsync -a --no-owner --no-group "$ROOT_OVERLAY_PATH/" "$ROOTFS_DIR/"
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

# Copy the main application binary
cp "$PROJECT_DIR/dist/cache/app/main" "$ROOTFS_DIR/strux/main"
chmod +x "$ROOTFS_DIR/strux/main"

# Copy Cage (Our Custom build with Splash Support)
cp "$PROJECT_DIR/dist/cache/cage" "$ROOTFS_DIR/usr/bin/cage"
chmod +x "$ROOTFS_DIR/usr/bin/cage"

# Copy the Frontend
cp -r "$PROJECT_DIR/dist/cache/frontend/dist" "$ROOTFS_DIR/strux/frontend"

# Copy Strux Client (Handles a bunch of system services)
cp "$PROJECT_DIR/dist/cache/client" "$ROOTFS_DIR/strux/client"
chmod +x "$ROOTFS_DIR/strux/client"

# If the .dev-env.json file exists, copy it to the rootfs
if [ -f "$PROJECT_DIR/dist/cache/.dev-env.json" ]; then
    cp "$PROJECT_DIR/dist/cache/.dev-env.json" "$ROOTFS_DIR/strux/.dev-env.json"
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


# ============================================================================
# SECTION 5: ENABLE SYSTEMD SERVICES
# ============================================================================
# Enable systemd services
# ============================================================================

# Enable systemd services
progress "Enabling systemd services..."
chroot /tmp/rootfs systemctl enable seatd.service || true
chroot /tmp/rootfs systemctl enable dbus.service || true
chroot /tmp/rootfs systemctl enable strux.service || true
chroot /tmp/rootfs systemctl enable strux-network.service || true


# Enable Plymouth services for boot splash
chroot /tmp/rootfs systemctl enable plymouth-start.service || true
chroot /tmp/rootfs systemctl enable plymouth-read-write.service || true

# Mask the default Plymouth quit services - we control quit from strux.sh
# This prevents Plymouth from quitting before Cage is ready
chroot /tmp/rootfs systemctl mask plymouth-quit.service || true
chroot /tmp/rootfs systemctl mask plymouth-quit-wait.service || true

# Disable unnecessary services to speed up boot
chroot /tmp/rootfs systemctl mask systemd-timesyncd.service || true
chroot /tmp/rootfs systemctl mask apt-daily.timer || true
chroot /tmp/rootfs systemctl mask apt-daily-upgrade.timer || true

# Enable systemd-networkd for automatic network configuration
chroot /tmp/rootfs systemctl enable systemd-networkd.service || true

# Enable systemd-resolved for DNS resolution
chroot /tmp/rootfs systemctl enable systemd-resolved.service || true

# Configure resolv.conf to use systemd-resolved stub resolver
chroot /tmp/rootfs ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf

# Ensure nsswitch.conf uses resolve for DNS (required for systemd-resolved)
if grep -q "^hosts:" /tmp/rootfs/etc/nsswitch.conf; then
    sed -i 's/^hosts:.*/hosts:          files resolve dns/' /tmp/rootfs/etc/nsswitch.conf
fi

# Disable getty services to prevent login prompt flash during boot
chroot /tmp/rootfs systemctl mask getty@tty1.service || true
chroot /tmp/rootfs systemctl mask getty@tty2.service || true
chroot /tmp/rootfs systemctl mask getty@tty3.service || true
chroot /tmp/rootfs systemctl mask getty@tty4.service || true
chroot /tmp/rootfs systemctl mask getty@tty5.service || true
chroot /tmp/rootfs systemctl mask getty@tty6.service || true
chroot /tmp/rootfs systemctl mask serial-getty@ttyS0.service || true
chroot /tmp/rootfs systemctl mask serial-getty@ttyAMA0.service || true
chroot /tmp/rootfs systemctl mask console-getty.service || true
chroot /tmp/rootfs systemctl mask getty.target || true


# ============================================================================
# SECTION 6: SET HOSTNAME
# ============================================================================
# Set the hostname from YAML configuration
# Priority: strux.yaml hostname > bsp.yaml hostname
# ============================================================================

progress "Configuring hostname..."

# Read hostname from strux.yaml first, then fall back to bsp.yaml
HOSTNAME=$(yq eval '.hostname' "$PROJECT_DIR/strux.yaml" 2>/dev/null || echo "")

# If not found in strux.yaml, try bsp.yaml
if [ -z "$HOSTNAME" ] || [ "$HOSTNAME" = "null" ]; then
    HOSTNAME=$(yq eval '.bsp.hostname' "$BSP_CONFIG" 2>/dev/null || echo "")
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
# SECTION 7: CREATE PLYMOUTH THEME AND BOOT SPLASH, REGENERATE INITRAMFS
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

progress "Regenerating initramfs..."

# Find the kernel version
KERNEL_VERSION=$(ls /tmp/rootfs/lib/modules 2>/dev/null | head -n 1)

if [ -n "$KERNEL_VERSION" ]; then
# Update initramfs with Plymouth
chroot /tmp/rootfs /bin/bash -c "update-initramfs -u -k $KERNEL_VERSION" || echo "Warning: initramfs update failed"

# Copy updated initramfs to dist (use dev prefix in dev mode)
INITRD=$(ls /tmp/rootfs/boot/initrd.img-* 2>/dev/null | head -n 1)
if [ -n "$INITRD" ]; then
    if [ "$STRUX_DEV_MODE" = "1" ]; then
    cp "$INITRD" /project/dist/cache/dev-initrd.img
    echo "Updated initramfs copied to dist/cache/dev-initrd.img"
    else
    cp "$INITRD" /project/dist/cache/initrd.img
    echo "Updated initramfs copied to dist/cache/initrd.img"
    fi
fi
else
echo "Warning: No kernel modules found, skipping initramfs regeneration"
fi

# ============================================================================
# SECTION 8: CLEANUP AND MOUNT POINT UNMOUNTING
# ============================================================================
# Cleanup and unmount point unmounting
# ============================================================================

# Unmount filesystems (mounted earlier for systemd operations)
umount /tmp/rootfs/sys 2>/dev/null || true
umount /tmp/rootfs/proc 2>/dev/null || true
umount /tmp/rootfs/dev/pts 2>/dev/null || true
umount /tmp/rootfs/dev 2>/dev/null || true

# Calculate required size for ext4 image (add 20% headroom)
echo "Calculating rootfs size..."
ROOTFS_SIZE=$(du -sm /tmp/rootfs | cut -f1)
IMAGE_SIZE=$((ROOTFS_SIZE + ROOTFS_SIZE / 5 + 50))  # Add 20% + 50MB buffer
echo "Rootfs is ${ROOTFS_SIZE}MB, creating ${IMAGE_SIZE}MB ext4 image..."

# Create a tarball of the rootfs like we did for the base rootfs
mkdir -p /project/dist/cache 
cd /tmp/rootfs
tar -czf /project/dist/cache/rootfs-post.tar.gz .
echo "Rootfs tarball created successfully."
echo "  Size: $(du -h /project/dist/cache/rootfs-post.tar.gz | cut -f1)"
