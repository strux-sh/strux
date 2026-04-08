#!/bin/bash

set -eo pipefail

# Trap errors and print the failing command/line
trap 'echo "Error: Command failed at line $LINENO with exit code $?: $BASH_COMMAND" >&2' ERR
# Define A Function to Print Progress Messages that will be used by the Strux CLI
progress() {
    echo "STRUX_PROGRESS: $1"
}

# Project directory (mounted at /project in Docker container)
PROJECT_DIR="/project"
# Screen daemon source is bundled with the CLI and copied to dist/artifacts/screen
SCREEN_SOURCE_DIR="$PROJECT_DIR/dist/artifacts/screen"
# Use BSP_CACHE_DIR if provided, otherwise fallback to default
CACHE_DIR="${BSP_CACHE_DIR:-$PROJECT_DIR/dist/cache}"
SCREEN_BINARY="$CACHE_DIR/screen"

# ============================================================================
# CONFIGURATION READING FROM YAML FILES
# ============================================================================

progress "Reading configuration from YAML files..."

# Get the active BSP name
if [ -n "$PRESELECTED_BSP" ]; then
    BSP_NAME="$PRESELECTED_BSP"
else
    BSP_NAME=$(yq '.bsp' "$PROJECT_DIR/strux.yaml" 2>/dev/null || echo "")
    if [ -z "$BSP_NAME" ]; then
        echo "Error: Could not read BSP name from $PROJECT_DIR/strux.yaml"
        exit 1
    fi
fi

BSP_FOLDER="$PROJECT_DIR/bsp/$BSP_NAME"
BSP_CONFIG="$BSP_FOLDER/bsp.yaml"

if [ ! -f "$BSP_CONFIG" ]; then
    echo "Error: BSP configuration file not found: $BSP_CONFIG"
    exit 1
fi

ARCH=$(yq '.bsp.arch' "$BSP_CONFIG" 2>/dev/null | xargs || echo "")

if [ -z "$ARCH" ]; then
    echo "Error: Could not read architecture from $BSP_CONFIG"
    exit 1
fi

# ============================================================================
# ARCHITECTURE MAPPING FOR MESON CROSS-COMPILATION
# ============================================================================

if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "x86_64" ]; then
    TARGET_ARCH="x86_64"
    MESON_CPU_FAMILY="x86_64"
    ARCH_LABEL="x86_64"
    CROSS_CC="x86_64-linux-gnu-gcc"
    CROSS_CXX="x86_64-linux-gnu-g++"
    CROSS_STRIP="x86_64-linux-gnu-strip"
elif [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
    TARGET_ARCH="aarch64"
    MESON_CPU_FAMILY="aarch64"
    ARCH_LABEL="ARM64"
    CROSS_CC="aarch64-linux-gnu-gcc"
    CROSS_CXX="aarch64-linux-gnu-g++"
    CROSS_STRIP="aarch64-linux-gnu-strip"
elif [ "$ARCH" = "armhf" ] || [ "$ARCH" = "armv7" ] || [ "$ARCH" = "arm" ]; then
    TARGET_ARCH="arm"
    MESON_CPU_FAMILY="arm"
    ARCH_LABEL="ARMv7/ARMHF"
    CROSS_CC="arm-linux-gnueabihf-gcc"
    CROSS_CXX="arm-linux-gnueabihf-g++"
    CROSS_STRIP="arm-linux-gnueabihf-strip"
else
    echo "Error: Unsupported architecture: $ARCH"
    exit 1
fi

# Check if cross-compilation is needed
HOST_ARCH=$(dpkg --print-architecture 2>/dev/null || echo "unknown")
case "$HOST_ARCH" in
    amd64) HOST_ARCH_NORMALIZED="x86_64" ;;
    arm64) HOST_ARCH_NORMALIZED="arm64" ;;
    armhf) HOST_ARCH_NORMALIZED="armhf" ;;
    *) HOST_ARCH_NORMALIZED="$HOST_ARCH" ;;
esac

if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "x86_64" ]; then
    TARGET_ARCH_NORMALIZED="x86_64"
elif [ "$ARCH" = "armhf" ] || [ "$ARCH" = "armv7" ] || [ "$ARCH" = "arm" ]; then
    TARGET_ARCH_NORMALIZED="armhf"
else
    TARGET_ARCH_NORMALIZED="arm64"
fi

NEED_CROSS_COMPILE=false
if [ "$HOST_ARCH_NORMALIZED" != "$TARGET_ARCH_NORMALIZED" ]; then
    NEED_CROSS_COMPILE=true
fi

# ============================================================================
# VERIFY SOURCE EXISTS
# ============================================================================

if [ ! -d "$SCREEN_SOURCE_DIR" ]; then
    echo "Error: Screen daemon source not found at $SCREEN_SOURCE_DIR"
    exit 1
fi

progress "Screen daemon source found at $SCREEN_SOURCE_DIR"

# ============================================================================
# BUILD SCREEN DAEMON
# ============================================================================

cd "$SCREEN_SOURCE_DIR"

MESON_CROSS_FILE=""
if [ "$NEED_CROSS_COMPILE" = true ]; then
    progress "Preparing meson cross-compilation for $ARCH_LABEL..."

    if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "x86_64" ]; then
        ARCH_PKG_CONFIG_DIR="/usr/lib/x86_64-linux-gnu/pkgconfig"
    elif [ "$ARCH" = "armhf" ] || [ "$ARCH" = "armv7" ] || [ "$ARCH" = "arm" ]; then
        ARCH_PKG_CONFIG_DIR="/usr/lib/arm-linux-gnueabihf/pkgconfig"
    else
        ARCH_PKG_CONFIG_DIR="/usr/lib/aarch64-linux-gnu/pkgconfig"
    fi

    PKG_CONFIG_PATH="${ARCH_PKG_CONFIG_DIR}:/usr/share/pkgconfig"
    PKG_CONFIG_LIBDIR="${ARCH_PKG_CONFIG_DIR}:/usr/share/pkgconfig"

    PKG_CONFIG_WRAPPER="/tmp/pkg-config-cross-screen-${TARGET_ARCH}.sh"
    cat > "$PKG_CONFIG_WRAPPER" <<WRAPPER
#!/bin/bash
export PKG_CONFIG_PATH="${PKG_CONFIG_PATH}"
export PKG_CONFIG_LIBDIR="${PKG_CONFIG_LIBDIR}"
export PKG_CONFIG_SYSROOT_DIR=""
export PKG_CONFIG_ALLOW_SYSTEM_CFLAGS=1
export PKG_CONFIG_ALLOW_SYSTEM_LIBS=1
/usr/bin/pkg-config "\$@"
WRAPPER
    chmod +x "$PKG_CONFIG_WRAPPER"

    MESON_CROSS_FILE="/tmp/meson-cross-screen-${TARGET_ARCH}.ini"
    cat > "$MESON_CROSS_FILE" <<EOF
[binaries]
c = '${CROSS_CC}'
cpp = '${CROSS_CXX}'
strip = '${CROSS_STRIP}'
pkg-config = '${PKG_CONFIG_WRAPPER}'

[host_machine]
system = 'linux'
cpu_family = '${MESON_CPU_FAMILY}'
cpu = '${TARGET_ARCH}'
endian = 'little'

[properties]
needs_exe_wrapper = true
EOF
else
    progress "Building for native architecture ($ARCH_LABEL)..."
fi

progress "Configuring strux-screen with meson for $ARCH_LABEL..."

# Fix clock skew
find . -type f -exec touch {} + 2>/dev/null || true

# Clean build directory
if [ -d "build" ]; then
    rm -rf build
fi

# Configure
if [ "$NEED_CROSS_COMPILE" = true ]; then
    meson setup build --buildtype=release --cross-file="$MESON_CROSS_FILE" || {
        echo "Error: Failed to configure strux-screen with meson"
        exit 1
    }
else
    meson setup build --buildtype=release || {
        echo "Error: Failed to configure strux-screen with meson"
        exit 1
    }
fi

progress "Compiling strux-screen..."

meson compile -C build || {
    echo "Error: Failed to compile strux-screen"
    exit 1
}

# ============================================================================
# COPY BINARY
# ============================================================================

progress "Copying strux-screen binary..."

mkdir -p "$CACHE_DIR"
cp build/strux-screen "$SCREEN_BINARY" || {
    echo "Error: Failed to copy strux-screen binary"
    exit 1
}

chmod +x "$SCREEN_BINARY"

progress "strux-screen compiled successfully"
