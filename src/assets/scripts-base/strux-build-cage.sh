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
CAGE_SOURCE_DIR="$PROJECT_DIR/dist/cage"
# Use BSP_CACHE_DIR if provided, otherwise fallback to default
CACHE_DIR="${BSP_CACHE_DIR:-$PROJECT_DIR/dist/cache}"
CAGE_BINARY="$CACHE_DIR/cage"

# ============================================================================
# CONFIGURATION READING FROM YAML FILES
# ============================================================================
# Read the selected BSP from strux.yaml and get its architecture from bsp.yaml
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

# Get architecture from BSP config (trim whitespace/newlines)
ARCH=$(yq '.bsp.arch' "$BSP_CONFIG" 2>/dev/null | xargs || echo "")

if [ -z "$ARCH" ]; then
    echo "Error: Could not read architecture from $BSP_CONFIG"
    exit 1
fi

# ============================================================================
# ARCHITECTURE MAPPING FOR MESON CROSS-COMPILATION
# ============================================================================
# Map Strux architecture to cross-compiler toolchain
# ============================================================================

# Map architecture to cross-compiler
if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "x86_64" ]; then
    TARGET_ARCH="x86_64"
    MESON_CPU_FAMILY="x86_64"
    ARCH_LABEL="x86_64"
    CROSS_CC="x86_64-linux-gnu-gcc"
    CROSS_CXX="x86_64-linux-gnu-g++"
    CROSS_STRIP="x86_64-linux-gnu-strip"
    CROSS_PKG_CONFIG="x86_64-linux-gnu-pkg-config"
elif [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
    TARGET_ARCH="aarch64"
    MESON_CPU_FAMILY="aarch64"
    ARCH_LABEL="ARM64"
    CROSS_CC="aarch64-linux-gnu-gcc"
    CROSS_CXX="aarch64-linux-gnu-g++"
    CROSS_STRIP="aarch64-linux-gnu-strip"
    CROSS_PKG_CONFIG="aarch64-linux-gnu-pkg-config"
elif [ "$ARCH" = "armhf" ] || [ "$ARCH" = "armv7" ] || [ "$ARCH" = "arm" ]; then
    TARGET_ARCH="arm"
    MESON_CPU_FAMILY="arm"
    ARCH_LABEL="ARMv7/ARMHF"
    CROSS_CC="arm-linux-gnueabihf-gcc"
    CROSS_CXX="arm-linux-gnueabihf-g++"
    CROSS_STRIP="arm-linux-gnueabihf-strip"
    CROSS_PKG_CONFIG="arm-linux-gnueabihf-pkg-config"
else
    echo "Error: Unsupported architecture: $ARCH"
    exit 1
fi

# Check if we're building for native or cross architecture
HOST_ARCH=$(dpkg --print-architecture 2>/dev/null || echo "unknown")

# Map host architecture for comparison
case "$HOST_ARCH" in
    amd64)
        HOST_ARCH_NORMALIZED="x86_64"
        ;;
    arm64)
        HOST_ARCH_NORMALIZED="arm64"
        ;;
    armhf)
        HOST_ARCH_NORMALIZED="armhf"
        ;;
    *)
        HOST_ARCH_NORMALIZED="$HOST_ARCH"
        ;;
esac

# Normalize target arch for comparison
if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "x86_64" ]; then
    TARGET_ARCH_NORMALIZED="x86_64"
elif [ "$ARCH" = "armhf" ] || [ "$ARCH" = "armv7" ] || [ "$ARCH" = "arm" ]; then
    TARGET_ARCH_NORMALIZED="armhf"
else
    TARGET_ARCH_NORMALIZED="arm64"
fi

# Determine if cross-compilation is needed
NEED_CROSS_COMPILE=false
if [ "$HOST_ARCH_NORMALIZED" != "$TARGET_ARCH_NORMALIZED" ]; then
    NEED_CROSS_COMPILE=true
fi

# ============================================================================
# CHECK IF CAGE SOURCE EXISTS
# ============================================================================
# Check if cage source directory already exists to avoid re-cloning
# ============================================================================

if [ -d "$CAGE_SOURCE_DIR" ]; then
    progress "Cage source already exists, skipping clone"
else
    progress "Cloning Cage source..."
    
    # Create dist directory if it doesn't exist
    mkdir -p "$PROJECT_DIR/dist"
    
    # Clone the Cage repository
    git clone https://github.com/strux-dev/cage.git "$CAGE_SOURCE_DIR" || {
        echo "Error: Failed to clone Cage repository"
        exit 1
    }
    
    progress "Cage source cloned"
fi

# ============================================================================
# BUILD CAGE COMPOSITOR
# ============================================================================
# Configure and compile Cage using meson with cross-compilation if needed
# ============================================================================

cd "$CAGE_SOURCE_DIR"

# Create meson cross-file if cross-compilation is needed
MESON_CROSS_FILE=""
if [ "$NEED_CROSS_COMPILE" = true ]; then
    progress "Preparing meson cross-compilation for $ARCH_LABEL..."
    
    # Create a temporary cross-file
    MESON_CROSS_FILE="/tmp/meson-cross-${TARGET_ARCH}.ini"
    
    # Determine PKG_CONFIG_PATH for cross-architecture libraries
    # Multiarch libraries are typically in /usr/lib/<triplet>
    if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "x86_64" ]; then
        PKG_CONFIG_PATH="/usr/lib/x86_64-linux-gnu/pkgconfig"
    elif [ "$ARCH" = "armhf" ] || [ "$ARCH" = "armv7" ] || [ "$ARCH" = "arm" ]; then
        PKG_CONFIG_PATH="/usr/lib/arm-linux-gnueabihf/pkgconfig"
    else
        PKG_CONFIG_PATH="/usr/lib/aarch64-linux-gnu/pkgconfig"
    fi
    
    cat > "$MESON_CROSS_FILE" <<EOF
[binaries]
c = '${CROSS_CC}'
cpp = '${CROSS_CXX}'
strip = '${CROSS_STRIP}'
pkgconfig = 'pkg-config'

[host_machine]
system = 'linux'
cpu_family = '${MESON_CPU_FAMILY}'
cpu = '${TARGET_ARCH}'
endian = 'little'

[properties]
needs_exe_wrapper = true
pkg_config_libdir = '${PKG_CONFIG_PATH}'
EOF
    
    progress "Cross-compilation file created: $MESON_CROSS_FILE"
else
    progress "Building for native architecture ($ARCH_LABEL)..."
fi

progress "Configuring Cage with meson for $ARCH_LABEL..."

# Fix clock skew issues by resetting file timestamps if build directory exists
# This can happen when Docker container clock drifts from host
if [ -d "build" ]; then
    progress "Resetting file timestamps to fix potential clock skew..."
    find build -type f -exec touch {} + 2>/dev/null || true
fi

# Configure with meson (with cross-file if needed)
if [ "$NEED_CROSS_COMPILE" = true ]; then
    meson setup build --buildtype=release --cross-file="$MESON_CROSS_FILE" || {
        echo "Error: Failed to configure Cage with meson cross-compilation"
        exit 1
    }
else
    meson setup build --buildtype=release || {
        echo "Error: Failed to configure Cage with meson"
        exit 1
    }
fi

progress "Compiling Cage..."

# Compile
meson compile -C build || {
    echo "Error: Failed to compile Cage"
    exit 1
}

# ============================================================================
# COPY CAGE BINARY
# ============================================================================
# Copy the compiled binary to the dist directory
# ============================================================================

progress "Copying Cage binary..."

# Create cache directory if it doesn't exist
mkdir -p "$CACHE_DIR"

# Copy the binary
cp build/cage "$CAGE_BINARY" || {
    echo "Error: Failed to copy Cage binary"
    exit 1
}

# Make the binary executable
chmod +x "$CAGE_BINARY"

progress "Cage compiled successfully"
