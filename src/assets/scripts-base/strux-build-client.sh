#!/bin/bash

set -eo pipefail

# Trap errors and print the failing command/line
trap 'echo "Error: Command failed at line $LINENO with exit code $?: $BASH_COMMAND" >&2' ERR

# Define a Function to Print Progress Messages that will be used by the Strux CLI
progress() {
    echo "STRUX_PROGRESS: $1"
}

progress "Building Strux Client (Go)..."

# ============================================================================
# CONFIGURATION READING FROM YAML FILES
# ============================================================================
# Read the selected BSP from strux.yaml and get its architecture from bsp.yaml
# ============================================================================

progress "Reading configuration from YAML files..."

# Project directory (mounted at /project in Docker container)
PROJECT_DIR="/project"
CLIENT_SOURCE_DIR="$PROJECT_DIR/dist/artifacts/client"

# Get the active BSP name from strux.yaml
if [ -n "$PRESELECTED_BSP" ]; then
    BSP_NAME="$PRESELECTED_BSP"
else
    BSP_NAME=$(yq '.bsp' "$PROJECT_DIR/strux.yaml" 2>/dev/null || echo "")
fi

if [ -z "$BSP_NAME" ]; then
    echo "Error: Could not read BSP name from $PROJECT_DIR/strux.yaml"
    exit 1
fi

# Construct BSP folder path
BSP_FOLDER="$PROJECT_DIR/bsp/$BSP_NAME"
BSP_CONFIG="$BSP_FOLDER/bsp.yaml"

if [ ! -f "$BSP_CONFIG" ]; then
    echo "Error: BSP configuration file not found: $BSP_CONFIG"
    exit 1
fi

# Get architecture from BSP config
ARCH=$(yq '.bsp.arch' "$BSP_CONFIG" 2>/dev/null | xargs || echo "")

if [ -z "$ARCH" ]; then
    echo "Error: Could not read architecture from $BSP_CONFIG"
    exit 1
fi

# ============================================================================
# ARCHITECTURE MAPPING FOR GO CROSS-COMPILATION
# ============================================================================
# Map Strux architecture to Go GOARCH and cross-compiler
# ============================================================================

# Map architecture to Go target
if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "x86_64" ]; then
    GO_ARCH="amd64"
    ARCH_LABEL="x86_64"
    CROSS_COMPILER="x86_64-linux-gnu-gcc"
elif [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
    GO_ARCH="arm64"
    ARCH_LABEL="ARM64"
    CROSS_COMPILER="aarch64-linux-gnu-gcc"
elif [ "$ARCH" = "armhf" ] || [ "$ARCH" = "armv7" ] || [ "$ARCH" = "arm" ]; then
    GO_ARCH="arm"
    GOARM="7"
    ARCH_LABEL="ARMv7/ARMHF"
    CROSS_COMPILER="arm-linux-gnueabihf-gcc"
else
    echo "Error: Unsupported architecture: $ARCH"
    exit 1
fi

progress "Building Strux Client for $ARCH_LABEL..."

# ============================================================================
# GO CLIENT BUILD
# ============================================================================
# Build the Go client with cross-compilation
# ============================================================================

# Use BSP_CACHE_DIR if provided, otherwise fallback to default
CACHE_DIR="${BSP_CACHE_DIR:-/project/dist/cache}"

# Ensure the cache directory exists
mkdir -p "$CACHE_DIR"

# Build to a temp directory inside the container
BUILD_TMP="/tmp/strux-client-build"
mkdir -p "$BUILD_TMP"

# Change to client source directory
cd "$CLIENT_SOURCE_DIR"

# Download Go dependencies
progress "Downloading Go dependencies..."

# Always run go mod tidy first to ensure go.sum is up to date
# This is necessary because the source files are copied fresh each build
go mod tidy

# Then download all dependencies
go mod download

# Build the client binary
progress "Compiling Strux Client for $ARCH_LABEL..."

CGO_ENABLED=1 \
GOOS=linux \
GOARCH="$GO_ARCH" \
GOARM="${GOARM:-}" \
CC="$CROSS_COMPILER" \
go build -o "$BUILD_TMP/client-$BSP_NAME" .

# Copy the built binary to the BSP-specific cache directory
cp "$BUILD_TMP/client-$BSP_NAME" "$CACHE_DIR/client"

# Make it executable
chmod +x "$CACHE_DIR/client"

# Clean up temp directory
rm -rf "$BUILD_TMP"

progress "Strux Client built successfully for $ARCH_LABEL"
