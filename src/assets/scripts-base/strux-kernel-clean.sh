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
# Use BSP_CACHE_DIR if provided, otherwise fallback to default
CACHE_DIR="${BSP_CACHE_DIR:-$PROJECT_DIR/dist/cache}"
KERNEL_SOURCE_DIR="$CACHE_DIR/kernel-source"
KERNEL_BUILD_DIR="$CACHE_DIR/kernel"

# ============================================================================
# CLEAN MODE SELECTION
# ============================================================================
# CLEAN_MODE can be:
#   - "mrproper": Run make mrproper (removes config and all generated files)
#   - "clean": Run make clean (removes object files but keeps config)
#   - "full": Delete entire kernel source and build directories
# ============================================================================

CLEAN_MODE="${CLEAN_MODE:-mrproper}"

progress "Cleaning kernel build artifacts (mode: $CLEAN_MODE)..."

case "$CLEAN_MODE" in
    "mrproper")
        if [ -d "$KERNEL_SOURCE_DIR" ]; then
            cd "$KERNEL_SOURCE_DIR"
            
            # Fix Git ownership issues in Docker
            git config --global --add safe.directory "$KERNEL_SOURCE_DIR" 2>/dev/null || true
            
            progress "Running make mrproper..."
            make mrproper || {
                echo "Warning: make mrproper failed, attempting manual cleanup..."
                rm -rf .config .config.old include/config include/generated
                find . -name "*.o" -delete 2>/dev/null || true
                find . -name "*.cmd" -delete 2>/dev/null || true
                find . -name "*.a" -delete 2>/dev/null || true
            }
            
            progress "Kernel source cleaned with mrproper"
        else
            progress "Kernel source directory not found, nothing to clean"
        fi
        ;;
        
    "clean")
        if [ -d "$KERNEL_SOURCE_DIR" ]; then
            cd "$KERNEL_SOURCE_DIR"
            
            progress "Running make clean..."
            make clean || {
                echo "Warning: make clean failed, attempting manual cleanup..."
                find . -name "*.o" -delete 2>/dev/null || true
                find . -name "*.cmd" -delete 2>/dev/null || true
                find . -name "*.a" -delete 2>/dev/null || true
            }
            
            progress "Kernel build artifacts cleaned (config preserved)"
        else
            progress "Kernel source directory not found, nothing to clean"
        fi
        ;;
        
    "full")
        progress "Removing kernel source directory..."
        if [ -d "$KERNEL_SOURCE_DIR" ]; then
            rm -rf "$KERNEL_SOURCE_DIR"
            progress "Kernel source directory removed"
        else
            progress "Kernel source directory not found"
        fi
        
        progress "Removing kernel build directory..."
        if [ -d "$KERNEL_BUILD_DIR" ]; then
            rm -rf "$KERNEL_BUILD_DIR"
            progress "Kernel build directory removed"
        else
            progress "Kernel build directory not found"
        fi
        
        progress "Full kernel clean completed"
        ;;
        
    *)
        echo "Error: Unknown clean mode: $CLEAN_MODE"
        echo "Valid modes: mrproper, clean, full"
        exit 1
        ;;
esac

progress "Kernel clean completed successfully"
