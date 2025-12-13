/***
 *
 *
 *  Post RootFS Build Script
 *
 */

import type { Config } from "../types/config"

export const POST_ROOTFS_BUILD_SCRIPT = function(config: Config) {
    return `#!/bin/bash

set -e

progress() {
    echo "STRUX_PROGRESS: $1"
}

progress "Post-processing Root Filesystem..."

mkdir -p /tmp/rootfs

# Extract the cached base rootfs
tar -xzf /project/dist/.cache/rootfs-base.tar.gz -C /tmp/rootfs

ROOTFS_DIR="/tmp/rootfs"

${config.rootfs.overlay ? `# Apply rootfs overlay
progress "Applying rootfs overlay..."
if [ -d "${config.rootfs.overlay}" ]; then
    # Use rsync to copy overlay files, preserving permissions and overwriting existing files
    # -a: archive mode (preserves permissions, timestamps, etc.)
    # -r: recursive
    # --no-owner: don't preserve ownership (we're copying into rootfs)
    # --no-group: don't preserve group (we're copying into rootfs)
    rsync -a --no-owner --no-group "${config.rootfs.overlay}/" "$ROOTFS_DIR/"
    echo "Rootfs overlay applied successfully"
else
    echo "Warning: Overlay directory '${config.rootfs.overlay}' does not exist, skipping overlay"
fi
` : ""}



# Copy init script
cp /tmp/init.sh /tmp/rootfs/init
chmod +x /tmp/rootfs/init

# Install network script (for systemd strux-network.service)
cp /tmp/network.sh /tmp/rootfs/usr/bin/strux-network.sh
chmod +x /tmp/rootfs/usr/bin/strux-network.sh

# Copy App
cp /project/dist/app /tmp/rootfs/usr/bin/strux-app
chmod +x /tmp/rootfs/usr/bin/strux-app

# Copy Cage (our custom build with splash support)
cp /project/dist/cage /tmp/rootfs/usr/bin/cage
chmod +x /tmp/rootfs/usr/bin/cage

# Copy Frontend Assets
# FRONTEND_PATH is set by the builder (defaults to ./frontend, or ./frontend/dist for Vite builds)
FRONTEND_SRC="\${FRONTEND_PATH:-frontend}"
if [ -d "/project/\${FRONTEND_SRC}" ]; then
  rm -rf /tmp/rootfs/frontend
  cp -r "/project/\${FRONTEND_SRC}" /tmp/rootfs/frontend
  echo "Copied frontend from \${FRONTEND_SRC}"
fi

# Copy Extension
cp /project/dist/libstrux-extension.so /tmp/rootfs/usr/lib/wpe-web-extensions/

# Install Kiosk startup script (substitute config values)
# This is called by systemd strux.service
sed -e "s/__INITIAL_LOAD_COLOR__/\${INITIAL_LOAD_COLOR:-000000}/g" \
    -e "s/__DISPLAY_RESOLUTION__/\${DISPLAY_RESOLUTION:-1920x1080}/g" \
    /tmp/strux.sh > /tmp/rootfs/usr/bin/strux-start.sh
chmod +x /tmp/rootfs/usr/bin/strux-start.sh

# Install splash logo if enabled
if [ "$SPLASH_ENABLED" = "true" ]; then
  echo "Installing boot splash..."

  # Install logo for Cage splash (Wayland compositor)
  mkdir -p /tmp/rootfs/usr/share/strux
  cp /project/dist/splash-logo.png /tmp/rootfs/usr/share/strux/logo.png

  # Install same logo for Plymouth theme (early boot splash)
  cp /project/dist/splash-logo.png /tmp/rootfs/usr/share/plymouth/themes/strux/logo.png

  echo "Boot splash installed (Plymouth + Cage)"

  # Regenerate initramfs to include Plymouth with the logo
  echo "Regenerating initramfs with Plymouth..."

  # Mount necessary filesystems for chroot
  mount --bind /dev /tmp/rootfs/dev || true
  mount --bind /dev/pts /tmp/rootfs/dev/pts || true
  mount --bind /proc /tmp/rootfs/proc || true
  mount --bind /sys /tmp/rootfs/sys || true

  # Find the kernel version
  KERNEL_VERSION=$(ls /tmp/rootfs/lib/modules 2>/dev/null | head -n 1)

  if [ -n "$KERNEL_VERSION" ]; then
    # Update initramfs with Plymouth
    chroot /tmp/rootfs /bin/bash -c "update-initramfs -u -k $KERNEL_VERSION" || echo "Warning: initramfs update failed"

    # Copy updated initramfs to dist
    INITRD=$(ls /tmp/rootfs/boot/initrd.img-* 2>/dev/null | head -n 1)
    if [ -n "$INITRD" ]; then
      cp "$INITRD" /project/dist/initrd.img
      echo "Updated initramfs copied to dist/initrd.img"
    fi
  else
    echo "Warning: No kernel modules found, skipping initramfs regeneration"
  fi

  # Unmount filesystems
  umount /tmp/rootfs/sys 2>/dev/null || true
  umount /tmp/rootfs/proc 2>/dev/null || true
  umount /tmp/rootfs/dev/pts 2>/dev/null || true
  umount /tmp/rootfs/dev 2>/dev/null || true
fi

# Calculate required size for ext4 image (add 20% headroom)
echo "Calculating rootfs size..."
ROOTFS_SIZE=$(du -sm /tmp/rootfs | cut -f1)
IMAGE_SIZE=$((ROOTFS_SIZE + ROOTFS_SIZE / 5 + 50))  # Add 20% + 50MB buffer
echo "Rootfs is \${ROOTFS_SIZE}MB, creating \${IMAGE_SIZE}MB ext4 image..."

# Create ext4 disk image
dd if=/dev/zero of=/project/dist/rootfs.ext4 bs=1M count=\${IMAGE_SIZE}
mkfs.ext4 -F /project/dist/rootfs.ext4

# Mount and copy rootfs contents
mkdir -p /tmp/ext4mount
mount -o loop /project/dist/rootfs.ext4 /tmp/ext4mount
cp -a /tmp/rootfs/* /tmp/ext4mount/
umount /tmp/ext4mount

echo "Rootfs ext4 image ready (using cached base)."


`
}