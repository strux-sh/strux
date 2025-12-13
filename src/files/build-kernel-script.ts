/***
 *
 *
 *  Kernel Build Script
 *
 */

export const BUILD_KERNEL_SCRIPT = function() {


    return `
#!/bin/bash
set -e

echo "Building custom Linux kernel..."

# Configuration from environment
KERNEL_SOURCE="\${STRUX_KERNEL_SOURCE:-}"
KERNEL_VERSION="\${STRUX_KERNEL_VERSION:-6.6.0}"
KERNEL_DEFCONFIG="\${STRUX_KERNEL_DEFCONFIG:-defconfig}"
ARCH="\${STRUX_ARCH:-arm64}"
KERNEL_PATCHES="\${STRUX_KERNEL_PATCHES:-}"      # Colon-separated list of patches
KERNEL_FRAGMENTS="\${STRUX_KERNEL_FRAGMENTS:-}"  # Colon-separated list of fragment paths
EXTERNAL_DTS="\${STRUX_EXTERNAL_DTS:-}"          # Colon-separated list of external DTS files
DT_OVERLAYS="\${STRUX_DT_OVERLAYS:-}"            # Colon-separated list of DT overlays
PRIMARY_DTB="\${STRUX_PRIMARY_DTB:-}"            # Primary DTB to use for boot
FRAGMENTS_DIR="/project/kernel"

# Detect host architecture
HOST_ARCH=$(uname -m)
echo "Host architecture: $HOST_ARCH"

# Normalize target architecture and set cross-compilation if needed
case "$ARCH" in
    arm64|aarch64)
        export ARCH=arm64
        KERNEL_IMAGE="Image"
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
        KERNEL_IMAGE="bzImage"
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

echo "Target architecture: $ARCH"
echo "Kernel version/branch: $KERNEL_VERSION"

KERNEL_SRC="/tmp/kernel-build"
mkdir -p "$KERNEL_SRC"
cd "$KERNEL_SRC"

# Source resolution: local path, git URL, or download from kernel.org
if [ -n "$KERNEL_SOURCE" ] && [ -d "/project/$KERNEL_SOURCE" ]; then
    # Local folder
    echo "Using local kernel source from $KERNEL_SOURCE..."
    rm -rf kernel-src
    cp -r "/project/$KERNEL_SOURCE" kernel-src
    cd kernel-src
elif [ -n "$KERNEL_SOURCE" ] && echo "$KERNEL_SOURCE" | grep -qE "^(https?://|git@)"; then
    # Git repository
    echo "Cloning kernel source from $KERNEL_SOURCE (branch: $KERNEL_VERSION)..."
    rm -rf kernel-src
    git clone --depth 1 --branch "$KERNEL_VERSION" "$KERNEL_SOURCE" kernel-src
    cd kernel-src
else
    # Download from kernel.org
    MAJOR_VERSION="\${KERNEL_VERSION%%.*}"
    KERNEL_TARBALL="linux-\${KERNEL_VERSION}.tar.xz"
    KERNEL_URL="https://cdn.kernel.org/pub/linux/kernel/v\${MAJOR_VERSION}.x/\${KERNEL_TARBALL}"

    if [ ! -d "linux-\${KERNEL_VERSION}" ]; then
        echo "Downloading kernel \${KERNEL_VERSION} from kernel.org..."
        if [ ! -f "$KERNEL_TARBALL" ]; then
            wget -q --show-progress "$KERNEL_URL"
        fi
        echo "Extracting kernel source..."
        tar -xf "$KERNEL_TARBALL"
    fi
    cd "linux-\${KERNEL_VERSION}"
fi

# Apply patches if specified
if [ -n "$KERNEL_PATCHES" ]; then
    echo "Applying kernel patches..."
    IFS=':' read -ra PATCHES <<< "\${KERNEL_PATCHES}"
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

# Clean previous build artifacts
echo "Cleaning previous build..."
make mrproper

# Apply base defconfig
echo "Applying base defconfig: \${KERNEL_DEFCONFIG}..."
make "$KERNEL_DEFCONFIG"

# Merge user config fragments (if any exist in project/kernel/)
if [ -d "$FRAGMENTS_DIR" ]; then
    for fragment in "$FRAGMENTS_DIR"/*.config; do
        if [ -f "$fragment" ]; then
            echo "Merging fragment: $(basename "$fragment")"
            ./scripts/kconfig/merge_config.sh -m .config "$fragment"
        fi
    done
fi

# Merge BSP config fragments (from KERNEL_FRAGMENTS env var)
if [ -n "$KERNEL_FRAGMENTS" ]; then
    echo "Merging BSP kernel config fragments..."
    IFS=':' read -ra FRAGS <<< "$KERNEL_FRAGMENTS"
    for fragment in "\${FRAGS[@]}"; do
        if [ -z "$fragment" ]; then
            continue
        fi

        frag_file=""
        if [ -f "$fragment" ]; then
            frag_file="$fragment"
        elif [ -f "/project/$fragment" ]; then
            frag_file="/project/$fragment"
        else
            echo "  Warning: Fragment not found: $fragment"
            continue
        fi

        echo "  Merging fragment: $(basename "$frag_file")"
        ./scripts/kconfig/merge_config.sh -m .config "$frag_file"
    done
fi

# Ensure essential kiosk options are enabled
echo "Ensuring essential kiosk kernel options..."
./scripts/config --enable CONFIG_DRM
./scripts/config --enable CONFIG_DRM_VIRTIO_GPU
./scripts/config --enable CONFIG_VIRTIO
./scripts/config --enable CONFIG_VIRTIO_PCI
./scripts/config --enable CONFIG_VIRTIO_CONSOLE
./scripts/config --enable CONFIG_INPUT_EVDEV
./scripts/config --enable CONFIG_FB
./scripts/config --enable CONFIG_FRAMEBUFFER_CONSOLE
./scripts/config --enable CONFIG_VT
./scripts/config --enable CONFIG_VT_CONSOLE
./scripts/config --enable CONFIG_UNIX
./scripts/config --enable CONFIG_INET
./scripts/config --enable CONFIG_DEVTMPFS
./scripts/config --enable CONFIG_DEVTMPFS_MOUNT
./scripts/config --enable CONFIG_TMPFS
./scripts/config --enable CONFIG_PROC_FS
./scripts/config --enable CONFIG_SYSFS

# Resolve config dependencies
make olddefconfig

# Build kernel
NPROC=$(nproc)
echo "Building kernel with $NPROC parallel jobs..."
make -j"$NPROC" "$KERNEL_IMAGE" modules

# Build device tree blobs for ARM64
if [ "$ARCH" = "arm64" ]; then
    make -j"$NPROC" dtbs 2>/dev/null || echo "No device tree sources found (OK for QEMU)"
fi

# Compile external DTS files (from BSP) - only for ARM architectures
if [ -n "$EXTERNAL_DTS" ]; then
    if [ "$ARCH" = "arm64" ]; then
        echo "Compiling external DTS files..."
        mkdir -p /project/dist/dtbs
        DTS_INCLUDE_PATH="arch/arm64/boot/dts"

        IFS=':' read -ra DTS_FILES <<< "$EXTERNAL_DTS"
        for dts in "\${DTS_FILES[@]}"; do
            if [ -z "$dts" ]; then
                continue
            fi

            dts_file=""
            if [ -f "$dts" ]; then
                dts_file="$dts"
            elif [ -f "/project/$dts" ]; then
                dts_file="/project/$dts"
            else
                echo "  Warning: DTS file not found: $dts"
                continue
            fi

            dtb_name="$(basename "\${dts_file%.dts}.dtb")"
            echo "  Compiling: $(basename "$dts_file") -> $dtb_name"

            # Use kernel's dtc with proper include paths
            cpp -nostdinc -I include -I "$DTS_INCLUDE_PATH" -undef -x assembler-with-cpp "$dts_file" | \
                scripts/dtc/dtc -I dts -O dtb -o "/project/dist/dtbs/$dtb_name" - 2>/dev/null || \
                scripts/dtc/dtc -I dts -O dtb -o "/project/dist/dtbs/$dtb_name" "$dts_file"
        done
    else
        echo "Skipping external DTS compilation (not applicable for $ARCH architecture)"
    fi
fi

# Compile DT overlays (from BSP) - only for ARM architectures
if [ -n "$DT_OVERLAYS" ]; then
    if [ "$ARCH" = "arm64" ]; then
        echo "Compiling DT overlays..."
        mkdir -p /project/dist/dtbs/overlays
        IFS=':' read -ra OVERLAY_FILES <<< "$DT_OVERLAYS"
        for overlay in "\${OVERLAY_FILES[@]}"; do
            if [ -z "$overlay" ]; then
                continue
            fi

            overlay_file=""
            if [ -f "$overlay" ]; then
                overlay_file="$overlay"
            elif [ -f "/project/$overlay" ]; then
                overlay_file="/project/$overlay"
            else
                echo "  Warning: Overlay file not found: $overlay"
                continue
            fi

            dtbo_name="$(basename "\${overlay_file%.dts}.dtbo")"
            echo "  Compiling: $(basename "$overlay_file") -> $dtbo_name"

            scripts/dtc/dtc -@ -I dts -O dtb -o "/project/dist/dtbs/overlays/$dtbo_name" "$overlay_file" 2>/dev/null || \
                echo "  Warning: Failed to compile overlay $overlay_file"
        done
    else
        echo "Skipping DT overlay compilation (not applicable for $ARCH architecture)"
    fi
fi

# Install modules to a temporary location
echo "Installing kernel modules..."
MODULES_INSTALL_DIR="/tmp/kernel-modules"
rm -rf "$MODULES_INSTALL_DIR"
make INSTALL_MOD_PATH="$MODULES_INSTALL_DIR" modules_install

# Get the installed kernel version
INSTALLED_VERSION=$(ls "$MODULES_INSTALL_DIR/lib/modules" | head -n 1)
echo "Kernel version: $INSTALLED_VERSION"

# Copy modules to rootfs (if it exists from base build)
if [ -d "/tmp/rootfs" ]; then
    echo "Installing modules to rootfs..."
    rm -rf /tmp/rootfs/lib/modules/*
    cp -a "$MODULES_INSTALL_DIR/lib/modules/"* /tmp/rootfs/lib/modules/
    # Run depmod
    depmod -b /tmp/rootfs "$INSTALLED_VERSION"
fi

# Copy kernel image to dist
echo "Copying kernel image..."
mkdir -p /project/dist
if [ "$ARCH" = "arm64" ]; then
    cp "arch/arm64/boot/Image" /project/dist/vmlinuz
    # Copy device tree blobs if they exist
    if [ -d "arch/arm64/boot/dts" ]; then
        mkdir -p /project/dist/dtbs
        find arch/arm64/boot/dts -name "*.dtb" -exec cp {} /project/dist/dtbs/ \\; 2>/dev/null || true
        DTB_COUNT=$(find /project/dist/dtbs -name "*.dtb" 2>/dev/null | wc -l)
        if [ "$DTB_COUNT" -gt 0 ]; then
            echo "Copied $DTB_COUNT device tree blobs to dist/dtbs/"
        fi
    fi
else
    cp "arch/x86/boot/bzImage" /project/dist/vmlinuz
fi

# Copy primary DTB if specified
if [ -n "$PRIMARY_DTB" ]; then
    echo "Setting primary DTB: $PRIMARY_DTB"
    primary_path=""

    # Look for the DTB in dist/dtbs first
    if [ -f "/project/dist/dtbs/$PRIMARY_DTB" ]; then
        primary_path="/project/dist/dtbs/$PRIMARY_DTB"
    # Then in kernel's output
    elif [ -f "arch/arm64/boot/dts/$PRIMARY_DTB" ]; then
        primary_path="arch/arm64/boot/dts/$PRIMARY_DTB"
    # Or a full path
    elif [ -f "$PRIMARY_DTB" ]; then
        primary_path="$PRIMARY_DTB"
    fi

    if [ -n "$primary_path" ]; then
        cp "$primary_path" /project/dist/dtb
        echo "  Primary DTB copied to /project/dist/dtb"
    else
        echo "  Warning: Primary DTB not found: $PRIMARY_DTB"
    fi
fi

echo ""
echo "Kernel build complete!"
echo "  Kernel image: /project/dist/vmlinuz"
echo "  Kernel version: $INSTALLED_VERSION"
if [ -n "$PRIMARY_DTB" ] && [ -f "/project/dist/dtb" ]; then
    echo "  Primary DTB: /project/dist/dtb"
fi

    
    `


}