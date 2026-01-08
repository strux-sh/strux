#!/bin/bash

set -e

# Define A Function to Print Progress Messages that will be used by the Strux CLI
progress() {
    echo "STRUX_PROGRESS: $1"
}

# Project directory (mounted at /project in Docker container)
PROJECT_DIR="/project"
CAGE_SOURCE_DIR="$PROJECT_DIR/dist/cage"
CAGE_BINARY="$PROJECT_DIR/dist/cache/cage"

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
# Configure and compile Cage using meson
# ============================================================================

cd "$CAGE_SOURCE_DIR"

progress "Configuring Cage with meson..."

# Configure with meson
meson setup build --buildtype=release || {
    echo "Error: Failed to configure Cage with meson"
    exit 1
}

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
mkdir -p "$PROJECT_DIR/dist/cache"

# Copy the binary
cp build/cage "$CAGE_BINARY" || {
    echo "Error: Failed to copy Cage binary"
    exit 1
}

# Make the binary executable
chmod +x "$CAGE_BINARY"

progress "Cage compiled successfully"
