/***
 *
 *
 *  U-Boot Build Script
 *
 */

export const BUILD_UBOOT_SCRIPT = function() {
    return `

#!/bin/bash
set -e

echo "Building U-Boot bootloader..."

# Configuration from environment
UBOOT_SOURCE="\${STRUX_UBOOT_SOURCE:-}"
UBOOT_VERSION="\${STRUX_UBOOT_VERSION:-v2024.01}"
UBOOT_TARGET="\${STRUX_UBOOT_TARGET:-qemu_arm64}"
ARCH="\${STRUX_ARCH:-arm64}"
UBOOT_PATCHES="\${STRUX_UBOOT_PATCHES:-}"            # Colon-separated list of patches
UBOOT_EXTRA_MAKE_ARGS="\${STRUX_UBOOT_EXTRA_MAKE_ARGS:-}"  # Extra make arguments
# BSP_DIR and BSP_ARTIFACTS_DIR are set by builder if BSP is used

# Detect host architecture
HOST_ARCH=$(uname -m)
echo "Host architecture: $HOST_ARCH"

# Normalize target architecture and set cross-compilation if needed
case "$ARCH" in
    arm64|aarch64)
        export ARCH=arm64
        # Only cross-compile if host is not arm64
        if [ "$HOST_ARCH" = "aarch64" ] || [ "$HOST_ARCH" = "arm64" ]; then
            export CROSS_COMPILE=""
            echo "Native compilation (arm64 on arm64)"
        else
            export CROSS_COMPILE=aarch64-linux-gnu-
            echo "Cross-compiling to arm64 from $HOST_ARCH"
        fi
        ;;
    amd64|x86_64)
        export ARCH=x86_64
        # Only cross-compile if host is not x86_64
        if [ "$HOST_ARCH" = "x86_64" ]; then
            export CROSS_COMPILE=""
            echo "Native compilation (x86_64 on x86_64)"
        else
            export CROSS_COMPILE=x86_64-linux-gnu-
            echo "Cross-compiling to x86_64 from $HOST_ARCH"
        fi
        ;;
    *)
        echo "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

# Map target to defconfig
case "$UBOOT_TARGET" in
    qemu_arm64|qemu)
        DEFCONFIG="qemu_arm64_defconfig"
        ;;
    rpi_3|rpi3)
        DEFCONFIG="rpi_3_defconfig"
        ;;
    rpi_4|rpi4)
        DEFCONFIG="rpi_4_defconfig"
        ;;
    rpi_5|rpi5|rpi_arm64)
        DEFCONFIG="rpi_arm64_defconfig"
        ;;
    generic_efi|efi)
        DEFCONFIG="qemu_arm64_defconfig"
        ;;
    *)
        echo "Unknown U-Boot target: $UBOOT_TARGET"
        echo "Supported targets: qemu_arm64, rpi_3, rpi_4, rpi_5, generic_efi"
        echo "Using target as defconfig directly: \${UBOOT_TARGET}_defconfig"
        DEFCONFIG="\${UBOOT_TARGET}_defconfig"
        ;;
esac

echo "Target: $UBOOT_TARGET"
echo "Defconfig: $DEFCONFIG"
echo "Version/branch: $UBOOT_VERSION"

UBOOT_SRC="/tmp/uboot-build"
mkdir -p "$UBOOT_SRC"
cd "$UBOOT_SRC"

# Source resolution: local path, git URL, or download from denx.de
if [ -n "$UBOOT_SOURCE" ] && [ -d "/project/$UBOOT_SOURCE" ]; then
    # Local folder
    echo "Using local U-Boot source from $UBOOT_SOURCE..."
    rm -rf uboot-src
    cp -r "/project/$UBOOT_SOURCE" uboot-src
    cd uboot-src
elif [ -n "$UBOOT_SOURCE" ] && echo "$UBOOT_SOURCE" | grep -qE "^(https?://|git@)"; then
    # Git repository
    echo "Cloning U-Boot source from $UBOOT_SOURCE (branch: $UBOOT_VERSION)..."
    rm -rf uboot-src
    git clone --depth 1 --branch "$UBOOT_VERSION" "$UBOOT_SOURCE" uboot-src
    cd uboot-src
else
    # Download from denx.de
    # Strip 'v' prefix if present for download URL
    VERSION_NUM="\${UBOOT_VERSION#v}"
    UBOOT_TARBALL="u-boot-\${VERSION_NUM}.tar.bz2"
    UBOOT_URL="https://ftp.denx.de/pub/u-boot/\${UBOOT_TARBALL}"

    if [ ! -d "u-boot-\${VERSION_NUM}" ]; then
        echo "Downloading U-Boot \${VERSION_NUM} from denx.de..."
        if [ ! -f "$UBOOT_TARBALL" ]; then
            wget -q --show-progress "$UBOOT_URL"
        fi
        echo "Extracting U-Boot source..."
        tar -xf "$UBOOT_TARBALL"
    fi
    cd "u-boot-\${VERSION_NUM}"
fi

# Apply patches if specified
if [ -n "$UBOOT_PATCHES" ]; then
    echo "Applying U-Boot patches..."
    IFS=':' read -ra PATCHES <<< "$UBOOT_PATCHES"
    for patch in "\${PATCHES[@]}"; do
        if [ -z "$patch" ]; then
            continue
        fi

        patch_file=""
        if echo "$patch" | grep -qE "^https?://"; then
            # Download patch from URL
            echo "  Downloading patch: $patch"
            patch_file="/tmp/$(basename "$patch")"
            wget -q -O "$patch_file" "$patch"
        elif [ -f "$patch" ]; then
            # Local file (absolute path)
            patch_file="$patch"
        elif [ -f "/project/$patch" ]; then
            # Local file (relative to project)
            patch_file="/project/$patch"
        else
            echo "  Warning: Patch not found: $patch"
            continue
        fi

        echo "  Applying patch: $(basename "$patch_file")"
        git apply "$patch_file" 2>/dev/null || patch -p1 < "$patch_file"
    done
fi

# Clean previous build
echo "Cleaning previous build..."
make distclean 2>/dev/null || true

# Apply defconfig
echo "Applying defconfig: \${DEFCONFIG}..."
make "$DEFCONFIG"

# Build U-Boot with extra make args if specified
NPROC=$(nproc)
echo "Building U-Boot with $NPROC parallel jobs..."
if [ -n "$UBOOT_EXTRA_MAKE_ARGS" ]; then
    echo "Extra make args: $UBOOT_EXTRA_MAKE_ARGS"
    make -j"$NPROC" $UBOOT_EXTRA_MAKE_ARGS
else
    make -j"$NPROC"
fi

# Create output directory
mkdir -p /project/dist/uboot

# Copy output files based on target
echo "Copying U-Boot binaries..."

# Common output files
[ -f "u-boot.bin" ] && cp u-boot.bin /project/dist/uboot/
[ -f "u-boot" ] && cp u-boot /project/dist/uboot/
[ -f "u-boot.elf" ] && cp u-boot.elf /project/dist/uboot/

# For Raspberry Pi targets
[ -f "u-boot.bin" ] && cp u-boot.bin /project/dist/uboot/

# Generate boot script for automatic boot
echo "Generating boot script..."
cat > /project/dist/uboot/boot.cmd << 'EOF'
# Strux OS U-Boot Boot Script
# Auto-generated - modify as needed

echo "Strux OS Bootloader"
echo "==================="

# Set load addresses (adjust for your platform)
setenv kernel_addr_r 0x40000000
setenv ramdisk_addr_r 0x44000000
setenv fdt_addr_r 0x48000000

# Boot arguments - minimal for kiosk with Plymouth splash
setenv bootargs "quiet splash loglevel=0 logo.nologo vt.handoff=7 rd.plymouth.show-delay=0 plymouth.ignore-serial-consoles systemd.show_status=false console=tty1 fbcon=map:0 vt.global_cursor_default=0"

# Try to load from various sources
echo "Loading kernel and initramfs..."

# Try MMC first (SD card / eMMC)
if test -e mmc 0:1 /vmlinuz; then
    load mmc 0:1 \${kernel_addr_r} /vmlinuz
    load mmc 0:1 \${ramdisk_addr_r} /rootfs.cpio.gz
    if test -e mmc 0:1 /dtb; then
        load mmc 0:1 \${fdt_addr_r} /dtb
        booti \${kernel_addr_r} \${ramdisk_addr_r}:\${filesize} \${fdt_addr_r}
    else
        booti \${kernel_addr_r} \${ramdisk_addr_r}:\${filesize} -
    fi
fi

# Try virtio (QEMU)
if test -e virtio 0 /vmlinuz; then
    load virtio 0 \${kernel_addr_r} /vmlinuz
    load virtio 0 \${ramdisk_addr_r} /rootfs.cpio.gz
    booti \${kernel_addr_r} \${ramdisk_addr_r}:\${filesize} -
fi

echo "Boot failed - no kernel found"
EOF

# Compile boot script to boot.scr
if command -v mkimage >/dev/null 2>&1; then
    mkimage -A arm64 -T script -C none -n "Strux Boot" \
        -d /project/dist/uboot/boot.cmd /project/dist/uboot/boot.scr
    echo "Created boot.scr"
else
    echo "Warning: mkimage not found, boot.scr not created"
fi

# List output files
echo ""
echo "U-Boot build complete!"
echo "Output files in /project/dist/uboot/:"
ls -la /project/dist/uboot/

    `
}