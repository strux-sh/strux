#!/bin/bash

set -e

# Define A Function to Print Progress Messages that will be used by the Strux CLI
progress() {
    echo "STRUX_PROGRESS: $1"
}

# Project directory (mounted at /project in Docker container)
PROJECT_DIR="/project"
EXTENSION_SOURCE_DIR="$PROJECT_DIR/dist/extension"
EXTENSION_BUILD_DIR="$PROJECT_DIR/dist/cache/extension_build"
EXTENSION_BINARY="$PROJECT_DIR/dist/cache/libstrux-extension.so"

# ============================================================================
# CHECK IF EXTENSION SOURCE EXISTS
# ============================================================================
# Check if extension source directory already exists to avoid re-cloning
# ============================================================================

if [ -d "$EXTENSION_SOURCE_DIR" ]; then
    progress "Extension source already exists, skipping clone"
else
    progress "Cloning WPE extension source..."
    
    # Create dist directory if it doesn't exist
    mkdir -p "$PROJECT_DIR/dist"
    
    # Clone the WPE extension repository
    git clone https://github.com/strux-dev/strux-wpe-extension.git "$EXTENSION_SOURCE_DIR" || {
        echo "Error: Failed to clone WPE extension repository"
        exit 1
    }
    
    progress "WPE Extension source cloned"
fi

# ============================================================================
# BUILD WPE EXTENSION
# ============================================================================
# Configure and compile WPE extension using cmake and make
# ============================================================================

progress "Preparing build directory..."

# Create build directory
mkdir -p "$EXTENSION_BUILD_DIR"

cd "$EXTENSION_BUILD_DIR"

progress "Configuring WPE extension with cmake..."

# Configure with cmake
cmake "$EXTENSION_SOURCE_DIR" || {
    echo "Error: Failed to configure WPE extension with cmake"
    exit 1
}

progress "Compiling WPE extension..."

# Compile with make
make || {
    echo "Error: Failed to compile WPE extension"
    exit 1
}

# ============================================================================
# COPY WPE EXTENSION LIBRARY
# ============================================================================
# Copy the compiled library to the dist directory
# ============================================================================

progress "Copying WPE extension library..."

# Create cache directory if it doesn't exist
mkdir -p "$PROJECT_DIR/dist/cache"

# Copy the library
cp libstrux-extension.so "$EXTENSION_BINARY" || {
    echo "Error: Failed to copy WPE extension library"
    exit 1
}

progress "WPE Extension compiled successfully"

