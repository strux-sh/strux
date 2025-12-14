/***
 *
 *
 *  Post RootFS Build Script
 *
 */

import type { Config } from "../types/config"
import { NETWORK_SERVICE } from "./systemd/network-service"
import { NETWORK_SERVICE_UNIT } from "./systemd/network-service-unit"
import { STRUX_DEV_WATCHER_PATH } from "./systemd/strux-dev-watcher.path"
import { STRUX_DEV_WATCHER_SERVICE } from "./systemd/strux-dev-watcher.service"
import { STRUX_DEV_WATCHER_TIMER } from "./systemd/strux-dev-watcher.timer"
import { STRUX_DEV_WATCHER_SCRIPT } from "./strux-dev-watcher-script"
import { STRUX_MOUNT_SETUP_SERVICE } from "./systemd/strux-mount-setup.service"
import { STRUX_SERVICE } from "./systemd/strux-service"

export const POST_ROOTFS_BUILD_SCRIPT = function(config: Config, devMode = false) {
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

# Copy App (skip in dev mode - will be mounted via virtfs)
if [ "$STRUX_DEV_MODE" != "1" ]; then
    cp /project/dist/app /tmp/rootfs/usr/bin/strux-app
    chmod +x /tmp/rootfs/usr/bin/strux-app
fi

# Copy Cage (our custom build with splash support)
cp /project/dist/cage /tmp/rootfs/usr/bin/cage
chmod +x /tmp/rootfs/usr/bin/cage

# Copy Frontend Assets (skip in dev mode - will be proxied from host)
if [ "$STRUX_DEV_MODE" != "1" ]; then
    # FRONTEND_PATH is set by the builder (defaults to ./frontend, or ./frontend/dist for Vite builds)
    FRONTEND_SRC="\${FRONTEND_PATH:-frontend}"
    if [ -d "/project/\${FRONTEND_SRC}" ]; then
      rm -rf /tmp/rootfs/frontend
      cp -r "/project/\${FRONTEND_SRC}" /tmp/rootfs/frontend
      echo "Copied frontend from \${FRONTEND_SRC}"
    fi
fi

# Copy Extension
cp /project/dist/libstrux-extension.so /tmp/rootfs/usr/lib/wpe-web-extensions/

# Install Kiosk startup script (substitute config values)
# This is called by systemd strux.service
sed -e "s/__INITIAL_LOAD_COLOR__/\${INITIAL_LOAD_COLOR:-000000}/g" \
    -e "s/__DISPLAY_RESOLUTION__/\${DISPLAY_RESOLUTION:-1920x1080}/g" \
    /tmp/strux.sh > /tmp/rootfs/usr/bin/strux-start.sh
chmod +x /tmp/rootfs/usr/bin/strux-start.sh

# Configure Systemd services
progress "Installing systemd services..."

cat > /tmp/rootfs/etc/systemd/system/strux.service << 'EOF'
${STRUX_SERVICE}
EOF

cat > /tmp/rootfs/etc/systemd/system/strux-network.service << 'EOF'
${NETWORK_SERVICE_UNIT}
EOF

mkdir -p /tmp/rootfs/etc/systemd/network

cat > /tmp/rootfs/etc/systemd/network/20-ethernet.network << 'EOF'
${NETWORK_SERVICE}
EOF

${config.boot.service_files && config.boot.service_files.length > 0 ? `# Copy custom systemd service files
progress "Installing custom systemd service files..."
${config.boot.service_files.map((serviceFile: string) => {
        const fileName = serviceFile.split("/").pop()
        return `cp "${serviceFile}" /tmp/rootfs/etc/systemd/system/${fileName}`
    }).join("\n")}
` : ""}

# Mount necessary filesystems for chroot operations
mount --bind /dev /tmp/rootfs/dev || true
mount --bind /dev/pts /tmp/rootfs/dev/pts || true
mount --bind /proc /tmp/rootfs/proc || true
mount --bind /sys /tmp/rootfs/sys || true

# Enable systemd services
progress "Enabling systemd services..."
chroot /tmp/rootfs systemctl enable seatd.service || true
chroot /tmp/rootfs systemctl enable dbus.service || true
chroot /tmp/rootfs systemctl enable strux.service || true
chroot /tmp/rootfs systemctl enable strux-network.service || true

${config.boot.service_files && config.boot.service_files.length > 0 ? `# Enable custom systemd services
${config.boot.service_files.map((serviceFile: string) => {
        const fileName = serviceFile.split("/").pop()
        const serviceName = fileName?.replace(/\.service$/, "") ?? fileName
        return `chroot /tmp/rootfs systemctl enable '${serviceName}.service' || true`
    }).join("\n")}
` : ""}

# Enable Plymouth services for boot splash
chroot /tmp/rootfs systemctl enable plymouth-start.service || true
chroot /tmp/rootfs systemctl enable plymouth-read-write.service || true

# Mask the default Plymouth quit services - we control quit from strux.sh
# This prevents Plymouth from quitting before Cage is ready
chroot /tmp/rootfs systemctl mask plymouth-quit.service || true
chroot /tmp/rootfs systemctl mask plymouth-quit-wait.service || true

# Disable unnecessary services to speed up boot
chroot /tmp/rootfs systemctl mask systemd-timesyncd.service || true
chroot /tmp/rootfs systemctl mask systemd-resolved.service || true
chroot /tmp/rootfs systemctl mask apt-daily.timer || true
chroot /tmp/rootfs systemctl mask apt-daily-upgrade.timer || true

# Enable systemd-networkd for automatic network configuration
chroot /tmp/rootfs systemctl enable systemd-networkd.service || true

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

${devMode ? `# Install dev watcher systemd units (dev mode only)
cat > /tmp/rootfs/etc/systemd/system/strux-dev-watcher.path << 'EOF'
${STRUX_DEV_WATCHER_PATH}
EOF

cat > /tmp/rootfs/etc/systemd/system/strux-dev-watcher.service << 'EOF'
${STRUX_DEV_WATCHER_SERVICE}
EOF

cat > /tmp/rootfs/etc/systemd/system/strux-dev-watcher.timer << 'EOF'
${STRUX_DEV_WATCHER_TIMER}
EOF

# Create systemd mount unit for virtfs (dev mode)
# Note: systemd mount units require the directory to exist and be empty
cat > /tmp/rootfs/etc/systemd/system/strux.mount << 'EOF'
[Unit]
Description=Strux Dev Mode VirtFS Mount
After=local-fs.target systemd-udevd.service
Before=strux.service
DefaultDependencies=no

[Mount]
What=strux
Where=/strux
Type=9p
Options=trans=virtio,version=9p2000.L

[Install]
WantedBy=local-fs.target
EOF

# Install dev mount setup service
cat > /tmp/rootfs/etc/systemd/system/strux-mount-setup.service << 'EOF'
${STRUX_MOUNT_SETUP_SERVICE}
EOF

# Install simple dev watcher script (non-systemd approach)
cat > /tmp/rootfs/usr/bin/strux-dev-watcher.sh << 'EOF'
${STRUX_DEV_WATCHER_SCRIPT}
EOF

chmod +x /tmp/rootfs/usr/bin/strux-dev-watcher.sh

# Enable mount setup service
chroot /tmp/rootfs systemctl enable strux-mount-setup.service || true
chroot /tmp/rootfs systemctl add-wants multi-user.target strux-mount-setup.service || true
` : ""}

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

  # Find the kernel version
  KERNEL_VERSION=$(ls /tmp/rootfs/lib/modules 2>/dev/null | head -n 1)

  if [ -n "$KERNEL_VERSION" ]; then
    # Update initramfs with Plymouth
    chroot /tmp/rootfs /bin/bash -c "update-initramfs -u -k $KERNEL_VERSION" || echo "Warning: initramfs update failed"

    # Copy updated initramfs to dist (use dev prefix in dev mode)
    INITRD=$(ls /tmp/rootfs/boot/initrd.img-* 2>/dev/null | head -n 1)
    if [ -n "$INITRD" ]; then
      if [ "$STRUX_DEV_MODE" = "1" ]; then
        cp "$INITRD" /project/dist/dev-initrd.img
        echo "Updated initramfs copied to dist/dev-initrd.img"
      else
        cp "$INITRD" /project/dist/initrd.img
        echo "Updated initramfs copied to dist/initrd.img"
      fi
    fi
  else
    echo "Warning: No kernel modules found, skipping initramfs regeneration"
  fi
fi

# Unmount filesystems (mounted earlier for systemd operations)
umount /tmp/rootfs/sys 2>/dev/null || true
umount /tmp/rootfs/proc 2>/dev/null || true
umount /tmp/rootfs/dev/pts 2>/dev/null || true
umount /tmp/rootfs/dev 2>/dev/null || true

# Calculate required size for ext4 image (add 20% headroom)
echo "Calculating rootfs size..."
ROOTFS_SIZE=$(du -sm /tmp/rootfs | cut -f1)
IMAGE_SIZE=$((ROOTFS_SIZE + ROOTFS_SIZE / 5 + 50))  # Add 20% + 50MB buffer
echo "Rootfs is \${ROOTFS_SIZE}MB, creating \${IMAGE_SIZE}MB ext4 image..."

# Create ext4 disk image (use dev prefix in dev mode)
if [ "$STRUX_DEV_MODE" = "1" ]; then
    ROOTFS_OUTPUT="/project/dist/dev-rootfs.ext4"
else
    ROOTFS_OUTPUT="/project/dist/rootfs.ext4"
fi

progress "Creating ext4 image..."

dd if=/dev/zero of="$ROOTFS_OUTPUT" bs=1M count=\${IMAGE_SIZE}
mkfs.ext4 -F "$ROOTFS_OUTPUT"

# Mount and copy rootfs contents
mkdir -p /tmp/ext4mount
mount -o loop "$ROOTFS_OUTPUT" /tmp/ext4mount
cp -a /tmp/rootfs/* /tmp/ext4mount/
umount /tmp/ext4mount

if [ "$STRUX_DEV_MODE" = "1" ]; then
    echo "Dev rootfs ext4 image ready: $ROOTFS_OUTPUT"
else
    echo "Rootfs ext4 image ready (using cached base): $ROOTFS_OUTPUT"
fi


`
}