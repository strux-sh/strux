#!/bin/bash

set -e

# Define A Function to Print Progress Messages that will be used by the Strux CLI
progress() {
    echo "STRUX_PROGRESS: $1"
}

# Delete the old app directory contents if it exists (this will later be mounted [in dev mode] or copied (in build mode))
rm -rf /project/dist/cache/app/*

# Create the app directory if it doesn't exist
mkdir -p /project/dist/cache/app

cd /project

# ============================================================================
# CONFIGURATION READING FROM YAML FILES
# ============================================================================
# Read the selected BSP from strux.yaml and get its architecture from bsp.yaml
# ============================================================================

progress "Reading configuration from YAML files..."

# Project directory (mounted at /project in Docker container)
PROJECT_DIR="/project"

# Get the active BSP name from strux.yaml
BSP_NAME=$(yq eval '.bsp' "$PROJECT_DIR/strux.yaml" 2>/dev/null || echo "")

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
ARCH=$(yq eval '.bsp.arch' "$BSP_CONFIG" 2>/dev/null || echo "")

if [ -z "$ARCH" ]; then
    echo "Error: Could not read architecture from $BSP_CONFIG"
    exit 1
fi

# ============================================================================
# ARCHITECTURE MAPPING FOR GO CROSS-COMPILATION
# ============================================================================
# Map Strux architecture to Go architecture and cross-compiler
# ============================================================================

# Map architecture to Go architecture
if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "x86_64" ]; then
    GO_ARCH="amd64"
    ARCH_LABEL="x86_64"
    CROSS_COMPILER="x86_64-linux-gnu-gcc"
else
    GO_ARCH="arm64"
    ARCH_LABEL="ARM64"
    CROSS_COMPILER="aarch64-linux-gnu-gcc"
fi

progress "Building Go application for $ARCH_LABEL ($GO_ARCH)..."

# ============================================================================
# GO APPLICATION BUILD
# ============================================================================
# Build the Go application with CGO enabled and cross-compilation
# ============================================================================

# Check if main.go exists
if [ ! -f "$PROJECT_DIR/main.go" ]; then
    echo "Warning: main.go not found at $PROJECT_DIR/main.go, skipping Go build"
    exit 0
fi

# Set up Go private module environment (if needed)
# This can be set via environment variable before running the script
# Example: GO_PRIVATE_ENV="GOPRIVATE=example.com " (note the trailing space if setting env vars)
GO_PRIVATE_ENV="${GO_PRIVATE_ENV:-}"

# Build the Go application with cross-compilation
CGO_ENABLED=1 \
GOOS=linux \
GOARCH="$GO_ARCH" \
CC="$CROSS_COMPILER" \
${GO_PRIVATE_ENV}go build -o /project/dist/cache/app/main .

progress "Go application built successfully"

