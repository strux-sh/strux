/**
 *
 *
 *  Build base Script
 *
 */

import type { Config } from "../types/config"
import { PLYMOUTH_CONF, PLYMOUTH_SCRIPT, PLYMOUTH_THEME } from "./plymouth/plymouth-theme"
import { NETWORK_SERVICE } from "./systemd/network-service"
import { NETWORK_SERVICE_UNIT } from "./systemd/network-service-unit"
import { STRUX_SERVICE } from "./systemd/strux-service"

export const BUILD_BASE_SCRIPT = function(config: Config) {
    return `#!/bin/bash
set -e

progress() {
    echo "STRUX_PROGRESS: $1"
}

progress "Preparing Base Root Filesystem"

ARCH="${config.arch}"
DEBIAN_SUITE="forky"

ROOTFS_DIR="/tmp/rootfs"

# Map Strux arch to Debian arch
case "$ARCH" in
    arm64|aarch64)
        DEBIAN_ARCH="arm64"
        ;;
    amd64|x86_64)
        DEBIAN_ARCH="amd64"
        ;;
    *)
        echo "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

echo "Building for Debian architecture: $DEBIAN_ARCH"

rm -rf "$ROOTFS_DIR"
mkdir -p "$ROOTFS_DIR"

# Check if we're building for native or cross architecture
HOST_ARCH=$(dpkg --print-architecture 2>/dev/null || echo "unknown")

progress "Running debootstrap (downloading Debian packages)..."


if [ "$DEBIAN_ARCH" = "$HOST_ARCH" ]; then
    # Native architecture - simple debootstrap
    debootstrap \\
        --variant=minbase \\
        --include=ca-certificates \\
        "$DEBIAN_SUITE" \\
        "$ROOTFS_DIR" \\
        http://deb.debian.org/debian
else
    # Cross-architecture - use foreign mode with qemu
    debootstrap \\
        --arch="$DEBIAN_ARCH" \\
        --variant=minbase \\
        --foreign \\
        --include=ca-certificates \\
        "$DEBIAN_SUITE" \\
        "$ROOTFS_DIR" \\
        http://deb.debian.org/debian

    # Copy QEMU static binary for second stage
    if [ "$DEBIAN_ARCH" = "arm64" ]; then
        cp /usr/bin/qemu-aarch64-static "$ROOTFS_DIR/usr/bin/" 2>/dev/null || true
    fi

    # Run second stage inside chroot
    progress "Running debootstrap second stage..."
    chroot "$ROOTFS_DIR" /debootstrap/debootstrap --second-stage
fi

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


# Install systemd and session management
progress "Installing systemd and core packages..."
run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
    systemd \\
    systemd-sysv \\
    libpam-systemd \\
    dbus \\
    seatd \\
    plymouth \\
    plymouth-themes"


# Install graphics stack
progress "Installing graphics stack (Mesa drivers)..."
run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
    mesa-vulkan-drivers \\
    mesa-va-drivers \\
    libgl1-mesa-dri \\
    libgles2 \\
    libegl1 \\
    libgbm1"

# Install architecture-specific GPU drivers
if [ "$DEBIAN_ARCH" = "amd64" ]; then
    progress "Installing Intel/AMD GPU drivers for x86_64..."
    run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
        mesa-vulkan-intel \\
        intel-media-va-driver \\
        libegl-mesa0 \\
        libgl1-mesa-glx \\
        libwayland-egl1" || true
fi


# Install Wayland and browser components
progress "Installing Wayland and WPE WebKit..."
run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
    libwlroots-0.19 \\
    wayland-protocols \\
    libwayland-client0 \\
    libwayland-server0 \\
    cog \\
    libwpewebkit-2.0-1 \\
    libwpe-1.0-1 \\
    libwpebackend-fdo-1.0-1"

# Install fonts and media support
progress "Installing fonts and media support..."
run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
    fonts-dejavu-core \\
    fonts-noto-core \\
    gstreamer1.0-plugins-base \\
    gstreamer1.0-plugins-good"



# Install system utilities
progress "Installing system utilities..."
run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
    udev \\
    kmod \\
    iproute2 \\
    netcat-openbsd \\
    procps \\
    libjson-glib-1.0-0 \\
    wlr-randr \\
    xwayland"

${config.rootfs?.packages && config.rootfs.packages.length > 0 ? `# Install custom packages from config
progress "Installing custom packages..."
run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
    ${config.rootfs.packages.join(" \\\n    ")}"
` : ""}

${config.rootfs?.deb_packages && config.rootfs.deb_packages.length > 0 ? `# Copy and install .deb files
progress "Copying .deb files to dist folder..."
mkdir -p /project/dist/deb-packages
${config.rootfs.deb_packages.map((debPackage: string) => {
        // Resolve path: if relative, prepend /project/; if starts with ./, remove it first
        const normalizedPath = debPackage.startsWith("./") ? debPackage.slice(2) : debPackage
        const sourcePath = normalizedPath.startsWith("/") ? normalizedPath : `/project/${normalizedPath}`
        const fileName = debPackage.split("/").pop()
        return `cp "${sourcePath}" /project/dist/deb-packages/${fileName}`
    }).join("\n")}

progress "Copying .deb files to rootfs..."
${config.rootfs.deb_packages.map((debPackage: string) => {
        const fileName = debPackage.split("/").pop()
        return `cp "/project/dist/deb-packages/${fileName}" "$ROOTFS_DIR/tmp/"`
    }).join("\n")}

progress "Installing .deb files..."
run_in_chroot "DEBIAN_FRONTEND=noninteractive dpkg -i /tmp/${config.rootfs.deb_packages.map((f: string) => f.split("/").pop()).join(" /tmp/")}" || true
run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -f -y" || true
` : ""}


# Configure Systemd services

cat > "$ROOTFS_DIR/etc/systemd/system/strux.service" << 'EOF'
${STRUX_SERVICE}
EOF

cat > "$ROOTFS_DIR/etc/systemd/system/strux-network.service" << 'EOF'
${NETWORK_SERVICE_UNIT}
EOF

mkdir -p "$ROOTFS_DIR/etc/systemd/network"

cat > "$ROOTFS_DIR/etc/systemd/network/20-ethernet.network" << 'EOF'
${NETWORK_SERVICE}
EOF

${config.boot.service_files && config.boot.service_files.length > 0 ? `# Copy custom systemd service files
progress "Installing custom systemd service files..."
${config.boot.service_files.map((serviceFile: string) => {
        const fileName = serviceFile.split("/").pop()
        return `cp "${serviceFile}" "$ROOTFS_DIR/etc/systemd/system/${fileName}"`
    }).join("\n")}
` : ""}

# Enable systemd services
run_in_chroot "systemctl enable seatd.service"
run_in_chroot "systemctl enable dbus.service"
run_in_chroot "systemctl enable strux.service"
run_in_chroot "systemctl enable strux-network.service"

${config.boot.service_files && config.boot.service_files.length > 0 ? `# Enable custom systemd services
${config.boot.service_files.map((serviceFile: string) => {
        const fileName = serviceFile.split("/").pop()
        const serviceName = fileName?.replace(/\.service$/, "") ?? fileName
        return `run_in_chroot "systemctl enable '${serviceName}.service' || true"`
    }).join("\n")}
` : ""}

# Enable Plymouth services for boot splash
run_in_chroot "systemctl enable plymouth-start.service || true"
run_in_chroot "systemctl enable plymouth-read-write.service || true"

# Mask the default Plymouth quit services - we control quit from strux.sh
# This prevents Plymouth from quitting before Cage is ready
run_in_chroot "systemctl mask plymouth-quit.service || true"
run_in_chroot "systemctl mask plymouth-quit-wait.service || true"

# Disable unnecessary services to speed up boot
run_in_chroot "systemctl mask systemd-timesyncd.service || true"
run_in_chroot "systemctl mask systemd-resolved.service || true"
run_in_chroot "systemctl mask apt-daily.timer || true"
run_in_chroot "systemctl mask apt-daily-upgrade.timer || true"

# Enable systemd-networkd for automatic network configuration
run_in_chroot "systemctl enable systemd-networkd.service || true"

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

progress "Creating Plymouth theme and boot splash..."

mkdir -p "$ROOTFS_DIR/usr/share/plymouth/themes/strux"

cat > "$ROOTFS_DIR/usr/share/plymouth/themes/strux/strux.plymouth" << 'EOF'
${PLYMOUTH_THEME}
EOF

cat > "$ROOTFS_DIR/usr/share/plymouth/themes/strux/strux.script" << 'EOF'
${PLYMOUTH_SCRIPT}
EOF

# Set Strux as the default Plymouth theme
run_in_chroot "plymouth-set-default-theme strux || true"

mkdir -p "$ROOTFS_DIR/etc/plymouth"
cat > "$ROOTFS_DIR/etc/plymouth/plymouthd.conf" << 'EOF'
${PLYMOUTH_CONF}
EOF

# Ensure initramfs includes Plymouth
mkdir -p "$ROOTFS_DIR/etc/initramfs-tools/conf.d"
echo "FRAMEBUFFER=y" > "$ROOTFS_DIR/etc/initramfs-tools/conf.d/plymouth"


# Configure hostname
echo "${config.hostname}" > "$ROOTFS_DIR/etc/hostname"
cat > "$ROOTFS_DIR/etc/hosts" << 'EOF'
127.0.0.1   localhost ${config.hostname}
::1         localhost ${config.hostname}
EOF

# Create necessary directories
mkdir -p "$ROOTFS_DIR/usr/share/strux"
mkdir -p "$ROOTFS_DIR/usr/lib/wpe-web-extensions"

# Fetch kernel from Debian repos (if not building custom kernel)
${config.boot?.kernel ? "STRUX_CUSTOM_KERNEL=\"true\"" : "STRUX_CUSTOM_KERNEL=\"false\""}
if [ "\${STRUX_CUSTOM_KERNEL:-false}" != "true" ]; then
    progress "Installing Debian kernel..."
    run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends linux-image-$DEBIAN_ARCH"

    # Find and copy the kernel
    progress "Extracting kernel image..."
    VMLINUZ=$(ls "$ROOTFS_DIR/boot/vmlinuz-"* 2>/dev/null | head -n 1)
    if [ -n "$VMLINUZ" ]; then
        cp "$VMLINUZ" /project/dist/vmlinuz
        echo "Kernel copied to /project/dist/vmlinuz"
    fi

    # Find and copy the initramfs
    INITRD=$(ls "$ROOTFS_DIR/boot/initrd.img-"* 2>/dev/null | head -n 1)
    if [ -n "$INITRD" ]; then
        cp "$INITRD" /project/dist/initrd.img
        echo "Initramfs copied to /project/dist/initrd.img"
    fi

    # Get kernel version for depmod
    KERNEL_VERSION=$(ls "$ROOTFS_DIR/lib/modules" 2>/dev/null | head -n 1)
    if [ -n "$KERNEL_VERSION" ]; then
        progress "Generating module dependencies..."
        run_in_chroot "depmod $KERNEL_VERSION"
        echo "Module dependencies generated for kernel $KERNEL_VERSION"
    fi
fi

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

# Remove QEMU static binary (not needed in final image)
rm -f "$ROOTFS_DIR/usr/bin/qemu-aarch64-static"

# Save the base rootfs as a tarball for caching
progress "Saving base rootfs cache..."
mkdir -p /project/dist/.cache
cd "$ROOTFS_DIR"
tar -czf /project/dist/.cache/rootfs-base.tar.gz .

echo "Base rootfs cache created successfully."
echo "  Size: $(du -h /project/dist/.cache/rootfs-base.tar.gz | cut -f1)"

`


}
