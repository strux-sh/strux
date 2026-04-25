#!/bin/bash

set -eo pipefail

PROJECT_DIR="/project"
CACHE_DIR="${BSP_CACHE_DIR:-$PROJECT_DIR/dist/cache}"
KERNEL_SOURCE_DIR="$CACHE_DIR/kernel-source"
BSP_NAME="${PRESELECTED_BSP}"
BSP_FOLDER="$PROJECT_DIR/bsp/$BSP_NAME"
BSP_CONFIG="$BSP_FOLDER/bsp.yaml"
BSP_KERNEL_CONFIG="$BSP_FOLDER/configs/kernel.config"

# Get architecture and kernel config from bsp.yaml
ARCH=$(yq '.bsp.arch' "$BSP_CONFIG" 2>/dev/null | xargs || echo "")
KERNEL_DEFCONFIG=$(yq '.bsp.boot.kernel.defconfig' "$BSP_CONFIG" 2>/dev/null | xargs || echo "")
# Handle null or empty defconfig - default to "defconfig"
if [ -z "$KERNEL_DEFCONFIG" ] || [ "$KERNEL_DEFCONFIG" = "null" ]; then
    KERNEL_DEFCONFIG="defconfig"
fi
SAVE_CONFIG="${SAVE_CONFIG:-false}"

if [ -z "$ARCH" ]; then
    echo "Error: Could not read architecture from $BSP_CONFIG"
    exit 1
fi

if [ "$ARCH" = "host" ]; then
    ARCH="${TARGET_ARCH:-$(dpkg --print-architecture 2>/dev/null || echo "")}"
    if [ -z "$ARCH" ] || [ "$ARCH" = "host" ]; then
        echo "Error: Could not resolve host architecture"
        exit 1
    fi
    echo "Resolved host architecture to $ARCH"
fi

# Map architecture to kernel ARCH and cross-compiler
if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "x86_64" ]; then
    KERNEL_ARCH="x86_64"
    CROSS_COMPILE=""
elif [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
    KERNEL_ARCH="arm64"
    CROSS_COMPILE="aarch64-linux-gnu-"
elif [ "$ARCH" = "armhf" ] || [ "$ARCH" = "armv7" ] || [ "$ARCH" = "arm" ]; then
    KERNEL_ARCH="arm"
    CROSS_COMPILE="arm-linux-gnueabihf-"
else
    echo "Error: Unsupported architecture: $ARCH"
    exit 1
fi

cd "$KERNEL_SOURCE_DIR"

# Load configuration in priority order:
# 1. Use saved BSP kernel.config if it exists
# 2. Otherwise use defconfig from bsp.yaml
if [ -f "$BSP_KERNEL_CONFIG" ]; then
    echo "Loading saved kernel config from bsp/$BSP_NAME/configs/kernel.config"
    cp "$BSP_KERNEL_CONFIG" .config
    # Run olddefconfig to update any new options
    make ARCH="$KERNEL_ARCH" ${CROSS_COMPILE:+CROSS_COMPILE="$CROSS_COMPILE"} olddefconfig
elif [ ! -f .config ]; then
    echo "Applying defconfig: $KERNEL_DEFCONFIG"
    make ARCH="$KERNEL_ARCH" ${CROSS_COMPILE:+CROSS_COMPILE="$CROSS_COMPILE"} "$KERNEL_DEFCONFIG" || {
        echo "Error: Failed to apply defconfig: $KERNEL_DEFCONFIG"
        exit 1
    }
fi

# Run menuconfig
echo "Opening menuconfig..."
make ARCH="$KERNEL_ARCH" ${CROSS_COMPILE:+CROSS_COMPILE="$CROSS_COMPILE"} menuconfig

# Always save the config back to BSP folder so changes persist
mkdir -p "$BSP_FOLDER/configs"
cp .config "$BSP_KERNEL_CONFIG"
echo "Configuration saved to bsp/$BSP_NAME/configs/kernel.config"

# If --save was specified, also generate a minimal fragment (savedefconfig)
if [ "$SAVE_CONFIG" = "true" ]; then
    FRAGMENT_OUTPUT="$BSP_FOLDER/configs/kernel.fragment"
    make ARCH="$KERNEL_ARCH" ${CROSS_COMPILE:+CROSS_COMPILE="$CROSS_COMPILE"} savedefconfig
    mv defconfig "$FRAGMENT_OUTPUT"
    echo "Minimal config fragment saved to bsp/$BSP_NAME/configs/kernel.fragment"
fi
