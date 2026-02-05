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
KERNEL_OUTPUT_DIR="$KERNEL_BUILD_DIR"

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

# Get kernel configuration from BSP config
KERNEL_SOURCE=$(yq '.bsp.boot.kernel.source' "$BSP_CONFIG" 2>/dev/null || echo "")
KERNEL_VERSION=$(yq '.bsp.boot.kernel.version' "$BSP_CONFIG" 2>/dev/null || echo "")
KERNEL_DEFCONFIG=$(yq '.bsp.boot.kernel.defconfig' "$BSP_CONFIG" 2>/dev/null | xargs || echo "")
# Handle null or empty defconfig - default to "defconfig"
if [ -z "$KERNEL_DEFCONFIG" ] || [ "$KERNEL_DEFCONFIG" = "null" ]; then
    KERNEL_DEFCONFIG="defconfig"
fi
KERNEL_FRAGMENTS=$(yq -r '.bsp.boot.kernel.fragments[]' "$BSP_CONFIG" 2>/dev/null || echo "")
KERNEL_PATCHES=$(yq '.bsp.boot.kernel.patches[]' "$BSP_CONFIG" 2>/dev/null || echo "")
KERNEL_DTS=$(yq '.bsp.boot.kernel.device_tree.dts' "$BSP_CONFIG" 2>/dev/null || echo "")
KERNEL_DTS_OVERLAYS=$(yq '.bsp.boot.kernel.device_tree.overlays[]' "$BSP_CONFIG" 2>/dev/null || echo "")
KERNEL_DTS_INCLUDE_PATHS=$(yq '.bsp.boot.kernel.device_tree.include_paths[]' "$BSP_CONFIG" 2>/dev/null || echo "")

if [ -z "$KERNEL_SOURCE" ]; then
    echo "Error: Kernel source not specified in $BSP_CONFIG"
    exit 1
fi

# Trim whitespace and remove surrounding quotes from yq output
KERNEL_SOURCE=$(echo "$KERNEL_SOURCE" | xargs | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")

# ============================================================================
# ARCHITECTURE MAPPING FOR KERNEL CROSS-COMPILATION
# ============================================================================
# Map Strux architecture to kernel ARCH and cross-compiler
# ============================================================================

# Map architecture to kernel ARCH and cross-compiler
if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "x86_64" ]; then
    KERNEL_ARCH="x86_64"
    CROSS_COMPILE=""
    ARCH_LABEL="x86_64"
    KERNEL_IMAGE="bzImage"
elif [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
    KERNEL_ARCH="arm64"
    CROSS_COMPILE="aarch64-linux-gnu-"
    ARCH_LABEL="ARM64"
    KERNEL_IMAGE="Image"
elif [ "$ARCH" = "armhf" ] || [ "$ARCH" = "armv7" ] || [ "$ARCH" = "arm" ]; then
    KERNEL_ARCH="arm"
    CROSS_COMPILE="arm-linux-gnueabihf-"
    ARCH_LABEL="ARMv7/ARMHF"
    KERNEL_IMAGE="zImage"
else
    echo "Error: Unsupported architecture: $ARCH"
    exit 1
fi

progress "Building Linux kernel for $ARCH_LABEL..."

# Display cross-compilation info
if [ -n "$CROSS_COMPILE" ]; then
    progress "Cross-compilation enabled: CROSS_COMPILE=$CROSS_COMPILE"
    progress "Target architecture: $KERNEL_ARCH"
    progress "Compiler: ${CROSS_COMPILE}gcc"
    # Verify cross-compiler exists
    if command -v "${CROSS_COMPILE}gcc" >/dev/null 2>&1; then
        progress "Cross-compiler found: $(which ${CROSS_COMPILE}gcc)"
        progress "Cross-compiler version: $(${CROSS_COMPILE}gcc --version | head -1)"
    else
        echo "Warning: Cross-compiler ${CROSS_COMPILE}gcc not found in PATH"
    fi
else
    progress "Native compilation (no cross-compiler)"
    progress "Target architecture: $KERNEL_ARCH (matches host)"
fi

# ============================================================================
# SOURCE FETCHING
# ============================================================================
# Parse URL fragment for git ref and fetch kernel source
# ============================================================================

# Parse URL and optional git ref from fragment
SOURCE_URL="${KERNEL_SOURCE%%#*}"
GIT_REF="${KERNEL_SOURCE#*#}"
if [ "$GIT_REF" = "$KERNEL_SOURCE" ]; then
    GIT_REF=""  # No fragment present
fi

# Trim whitespace and remove quotes from GIT_REF as well
GIT_REF=$(echo "$GIT_REF" | xargs | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")

progress "Fetching kernel source from $SOURCE_URL${GIT_REF:+ (ref: $GIT_REF)}..."

# Create kernel source directory
mkdir -p "$KERNEL_SOURCE_DIR"

# Detect source type and fetch
if [[ "$SOURCE_URL" =~ \.(tar\.gz|tar\.xz|tar\.bz2|tgz)$ ]]; then
    # Tarball source
    progress "Downloading kernel tarball..."
    cd "$KERNEL_SOURCE_DIR"
    
    # Extract version from URL or use provided version
    TARBALL_NAME=$(basename "$SOURCE_URL")
    wget -q --show-progress -O "$TARBALL_NAME" "$SOURCE_URL" || {
        echo "Error: Failed to download kernel tarball"
        exit 1
    }
    
    progress "Extracting kernel tarball..."
    tar xf "$TARBALL_NAME" --strip-components=1 || {
        echo "Error: Failed to extract kernel tarball"
        exit 1
    }
    
    rm -f "$TARBALL_NAME"
else
    # Git source
    progress "Cloning kernel repository..."
    
    # Check if we already have the source with the correct ref
    if [ -d "$KERNEL_SOURCE_DIR/.git" ]; then
        cd "$KERNEL_SOURCE_DIR"
        # Fix Git ownership issues in Docker (files mounted from host)
        git config --global --add safe.directory "$KERNEL_SOURCE_DIR" 2>/dev/null || true
        
        if [ -n "$GIT_REF" ]; then
            # Check current ref (could be branch, tag, or commit)
            CURRENT_REF=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
            CURRENT_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "")
            TARGET_COMMIT=$(git rev-parse "$GIT_REF" 2>/dev/null || echo "")
            
            # If we can't resolve the target ref, fetch from origin
            if [ -z "$TARGET_COMMIT" ]; then
                progress "Fetching ref $GIT_REF from origin..."
                git fetch origin "$GIT_REF" 2>&1 || {
                    # If specific ref fetch fails, try fetching all refs
                    progress "Fetching all refs from origin..."
                    git fetch origin 2>&1 || {
                        echo "Error: Failed to fetch from origin"
                        exit 1
                    }
                }
                # Try to resolve again after fetch
                TARGET_COMMIT=$(git rev-parse "$GIT_REF" 2>/dev/null || git rev-parse "origin/$GIT_REF" 2>/dev/null || echo "")
            fi
            
            # Check if we need to switch
            if [ -z "$TARGET_COMMIT" ]; then
                echo "Error: Ref '$GIT_REF' not found in repository"
                echo "Available branches:"
                git branch -a 2>/dev/null | head -20 || true
                exit 1
            fi
            
            if [ "$CURRENT_COMMIT" != "$TARGET_COMMIT" ]; then
                progress "Switching to ref: $GIT_REF"
                # Try checkout - if it's a remote branch, create local tracking branch
                if git checkout "$GIT_REF" 2>&1; then
                    progress "Switched to $GIT_REF"
                elif git checkout -b "$GIT_REF" "origin/$GIT_REF" 2>&1; then
                    progress "Created local branch $GIT_REF tracking origin/$GIT_REF"
                else
                    echo "Error: Failed to checkout ref: $GIT_REF"
                    echo "Tried: git checkout $GIT_REF"
                    echo "Tried: git checkout -b $GIT_REF origin/$GIT_REF"
                    exit 1
                fi
            else
                progress "Already on ref: $GIT_REF"
            fi
        fi
    else
        # Clone fresh
        if [ -n "$GIT_REF" ]; then
            git clone --depth 1 --branch "$GIT_REF" "$SOURCE_URL" "$KERNEL_SOURCE_DIR" || {
                echo "Error: Failed to clone kernel repository with ref: $GIT_REF"
                exit 1
            }
        else
            git clone --depth 1 "$SOURCE_URL" "$KERNEL_SOURCE_DIR" || {
                echo "Error: Failed to clone kernel repository"
                exit 1
            }
        fi
        
        # Fix Git ownership issues in Docker (files mounted from host)
        # Must be done after clone since directory didn't exist before
        git config --global --add safe.directory "$KERNEL_SOURCE_DIR" 2>/dev/null || true
    fi
    
    cd "$KERNEL_SOURCE_DIR"
fi

progress "Kernel source ready at $KERNEL_SOURCE_DIR"

# ============================================================================
# PATCH APPLICATION
# ============================================================================
# Apply patches from bsp.yaml configuration
# ============================================================================

if [ -n "$KERNEL_PATCHES" ]; then
    progress "Applying kernel patches..."
    
    # Convert patches to array (handle both single and multiple patches)
    PATCH_ARRAY=()
    while IFS= read -r patch; do
        [ -n "$patch" ] && PATCH_ARRAY+=("$patch")
    done <<< "$KERNEL_PATCHES"
    
    for patch in "${PATCH_ARRAY[@]}"; do
        # Resolve patch path (relative to BSP folder or absolute)
        if [[ "$patch" =~ ^\./ ]]; then
            PATCH_PATH="$BSP_FOLDER/${patch#./}"
        else
            PATCH_PATH="$BSP_FOLDER/$patch"
        fi
        
        if [ -f "$PATCH_PATH" ]; then
            progress "Applying patch: $patch"
            patch -p1 < "$PATCH_PATH" || {
                echo "Error: Failed to apply patch: $patch"
                exit 1
            }
        else
            echo "Warning: Patch file not found: $PATCH_PATH"
        fi
    done
fi

# ============================================================================
# KERNEL CONFIGURATION
# ============================================================================
# Configure kernel: use saved config or defconfig, then apply fragments
# ============================================================================

progress "Configuring kernel..."

# Path to saved kernel config in BSP folder
BSP_KERNEL_CONFIG="$BSP_FOLDER/configs/kernel.config"

# Load configuration in priority order:
# 1. Use saved BSP kernel.config if it exists
# 2. Otherwise use defconfig from bsp.yaml
if [ -f "$BSP_KERNEL_CONFIG" ]; then
    progress "Using saved kernel config from bsp/$BSP_NAME/configs/kernel.config"
    cp "$BSP_KERNEL_CONFIG" .config
    # Run olddefconfig to set any new options to defaults
    make ARCH="$KERNEL_ARCH" ${CROSS_COMPILE:+CROSS_COMPILE="$CROSS_COMPILE"} olddefconfig || {
        echo "Error: Failed to update kernel config with olddefconfig"
        exit 1
    }
else
    # Start with defconfig
    progress "Applying defconfig: $KERNEL_DEFCONFIG"
    make ARCH="$KERNEL_ARCH" ${CROSS_COMPILE:+CROSS_COMPILE="$CROSS_COMPILE"} "$KERNEL_DEFCONFIG" || {
        echo "Error: Failed to apply defconfig: $KERNEL_DEFCONFIG"
        exit 1
    }
fi

# Apply fragments if any
if [ -n "$KERNEL_FRAGMENTS" ]; then
    progress "Applying kernel configuration fragments..."
    
    # Convert fragments to array
    FRAGMENT_ARRAY=()
    while IFS= read -r fragment; do
        [ -n "$fragment" ] && FRAGMENT_ARRAY+=("$fragment")
    done <<< "$KERNEL_FRAGMENTS"
    
    # Create temporary directory for fragment files
    FRAGMENT_TMP_DIR=$(mktemp -d)
    FRAGMENT_FILES=()
    
    for fragment in "${FRAGMENT_ARRAY[@]}"; do
        # Check if fragment is inline (multiline string) or file path
        if [[ "$fragment" =~ ^\./ ]] || [[ "$fragment" =~ ^[^/]+\.config$ ]]; then
            # File path fragment
            if [[ "$fragment" =~ ^\./ ]]; then
                FRAGMENT_PATH="$BSP_FOLDER/${fragment#./}"
            else
                FRAGMENT_PATH="$BSP_FOLDER/$fragment"
            fi
            
            if [ -f "$FRAGMENT_PATH" ]; then
                FRAGMENT_FILES+=("$FRAGMENT_PATH")
            else
                echo "Warning: Fragment file not found: $FRAGMENT_PATH"
            fi
        else
            # Inline fragment (multiline config)
            # Use printf '%b' to interpret escape sequences like \n from yq output
            FRAGMENT_TMP_FILE="$FRAGMENT_TMP_DIR/fragment_${#FRAGMENT_FILES[@]}.config"
            printf '%b\n' "$fragment" > "$FRAGMENT_TMP_FILE"
            FRAGMENT_FILES+=("$FRAGMENT_TMP_FILE")
        fi
    done
    
    # Use merge_config.sh to apply fragments
    if [ ${#FRAGMENT_FILES[@]} -gt 0 ]; then
        # merge_config.sh expects: base_config fragment1 fragment2 ...
        # We'll merge .config with all fragments
        "$(pwd)/scripts/kconfig/merge_config.sh" -m .config "${FRAGMENT_FILES[@]}" || {
            echo "Error: Failed to merge kernel configuration fragments"
            rm -rf "$FRAGMENT_TMP_DIR"
            exit 1
        }
        
        # merge_config.sh creates .config.old, clean it up
        rm -f .config.old
        
        progress "Applied ${#FRAGMENT_FILES[@]} configuration fragment(s)"
    fi
    
    rm -rf "$FRAGMENT_TMP_DIR"
fi

# Save final config for reference
cp .config "$KERNEL_BUILD_DIR/.config" 2>/dev/null || true

progress "Kernel configuration complete"

# ============================================================================
# KERNEL BUILD
# ============================================================================
# Build kernel image, modules, and device tree blobs
# ============================================================================

progress "Building kernel image..."

# Build kernel image
make -j$(nproc) ARCH="$KERNEL_ARCH" ${CROSS_COMPILE:+CROSS_COMPILE="$CROSS_COMPILE"} "$KERNEL_IMAGE" 2>&1 | tee /tmp/kernel-build.log || {
    echo ""
    echo "Error: Failed to build kernel image"
    echo ""
    echo "This is typically caused by:"
    echo "  1. Missing kernel configuration options (check .config)"
    echo "  2. Kernel source code bugs or missing patches"
    echo "  3. Incompatible kernel version with your architecture"
    echo ""
    echo "Last 30 lines of build output:"
    tail -30 /tmp/kernel-build.log 2>/dev/null || echo "Build log not available"
    echo ""
    echo "To debug:"
    echo "  1. Check the error messages above for missing functions or undefined references"
    echo "  2. Review kernel configuration: make ARCH=$KERNEL_ARCH menuconfig"
    echo "  3. Check if patches are needed for your kernel version"
    echo "  4. Verify kernel source compatibility with your target architecture"
    exit 1
}

progress "Building kernel modules..."

# Build modules
make -j$(nproc) ARCH="$KERNEL_ARCH" ${CROSS_COMPILE:+CROSS_COMPILE="$CROSS_COMPILE"} modules || {
    echo "Error: Failed to build kernel modules"
    exit 1
}

# Build device tree blobs if DTS is specified
if [ -n "$KERNEL_DTS" ] && [ "$KERNEL_DTS" != "null" ]; then
    progress "Building device tree blobs..."
    
    # Trim whitespace and quotes from KERNEL_DTS
    KERNEL_DTS=$(echo "$KERNEL_DTS" | xargs | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
    
    # Check if this is an external DTS file (starts with ./ or is an absolute path outside kernel)
    if [[ "$KERNEL_DTS" =~ ^\./ ]]; then
        # External DTS file - resolve path relative to BSP folder
        EXTERNAL_DTS_PATH="$BSP_FOLDER/${KERNEL_DTS#./}"
        
        if [ ! -f "$EXTERNAL_DTS_PATH" ]; then
            echo "Error: External DTS file not found: $EXTERNAL_DTS_PATH"
            exit 1
        fi
        
        progress "Using external DTS file: $EXTERNAL_DTS_PATH"
        
        # Get the base name of the DTS file
        DTS_BASENAME=$(basename "$EXTERNAL_DTS_PATH")
        DTB_BASENAME="${DTS_BASENAME%.dts}.dtb"
        
        # Determine the kernel DTS include directories based on architecture
        if [ "$KERNEL_ARCH" = "arm64" ]; then
            DTS_INCLUDE_DIR="arch/arm64/boot/dts"
        elif [ "$KERNEL_ARCH" = "arm" ]; then
            DTS_INCLUDE_DIR="arch/arm/boot/dts"
        elif [ "$KERNEL_ARCH" = "x86_64" ]; then
            DTS_INCLUDE_DIR="arch/x86/boot/dts"
        else
            DTS_INCLUDE_DIR="arch/$KERNEL_ARCH/boot/dts"
        fi
        
        # Create output directory for the DTB
        DTB_OUTPUT_PATH="$KERNEL_OUTPUT_DIR/dtbs"
        mkdir -p "$DTB_OUTPUT_PATH"
        
        progress "Compiling external DTS with kernel includes..."
        
        # Build the kernel's DTC first if it doesn't exist
        if [ ! -f "scripts/dtc/dtc" ]; then
            progress "Building kernel's device tree compiler..."
            make ARCH="$KERNEL_ARCH" ${CROSS_COMPILE:+CROSS_COMPILE="$CROSS_COMPILE"} scripts/dtc/dtc || {
                echo "Error: Failed to build kernel's DTC"
                exit 1
            }
        fi
        
        # Compile the external DTS file using cpp (C preprocessor) + kernel's dtc
        # This allows referencing internal kernel DTS includes without copying the file
        progress "Preprocessing DTS file..."
        
        # Run the C preprocessor with kernel include paths
        # This handles #include directives for internal kernel DTS files
        cpp -nostdinc \
            -I "$DTS_INCLUDE_DIR" \
            -I "$DTS_INCLUDE_DIR/include" \
            -I "include" \
            -I "scripts/dtc/include-prefixes" \
            -undef -D__DTS__ -x assembler-with-cpp \
            "$EXTERNAL_DTS_PATH" \
            -o "/tmp/preprocessed-${DTS_BASENAME}" 2>&1 || {
            echo "Error: Failed to preprocess DTS file"
            echo "Make sure your DTS includes exist in the kernel source tree"
            exit 1
        }
        
        progress "Compiling DTB: $DTB_BASENAME"
        
        # Compile the preprocessed DTS to DTB using the kernel's dtc
        scripts/dtc/dtc \
            -I dts -O dtb \
            -i "$DTS_INCLUDE_DIR" \
            -o "$DTB_OUTPUT_PATH/$DTB_BASENAME" \
            "/tmp/preprocessed-${DTS_BASENAME}" 2>&1 || {
            echo "Error: Failed to compile device tree"
            echo ""
            echo "DTC output:"
            scripts/dtc/dtc -I dts -O dtb -i "$DTS_INCLUDE_DIR" "/tmp/preprocessed-${DTS_BASENAME}" 2>&1 || true
            exit 1
        }
        
        # Clean up preprocessed file
        rm -f "/tmp/preprocessed-${DTS_BASENAME}"
        
        progress "External DTB compiled: $DTB_BASENAME"
        
        # Store the DTB name for later verification
        CUSTOM_DTB_NAME="$DTB_BASENAME"
        EXTERNAL_DTB_ALREADY_COPIED="true"
    else
        # Built-in DTS or just build all DTBs
        # Build DTBs
        make -j$(nproc) ARCH="$KERNEL_ARCH" ${CROSS_COMPILE:+CROSS_COMPILE="$CROSS_COMPILE"} dtbs || {
            echo "Error: Failed to build device tree blobs"
            exit 1
        }
    fi
    
    # Handle DTS overlays if specified
    if [ -n "$KERNEL_DTS_OVERLAYS" ]; then
        progress "Compiling device tree overlays..."
        
        OVERLAY_ARRAY=()
        while IFS= read -r overlay; do
            [ -n "$overlay" ] && OVERLAY_ARRAY+=("$overlay")
        done <<< "$KERNEL_DTS_OVERLAYS"
        
        for overlay in "${OVERLAY_ARRAY[@]}"; do
            # Resolve overlay path
            if [[ "$overlay" =~ ^\./ ]]; then
                OVERLAY_PATH="$BSP_FOLDER/${overlay#./}"
            else
                OVERLAY_PATH="$BSP_FOLDER/$overlay"
            fi
            
            if [ -f "$OVERLAY_PATH" ]; then
                progress "Compiling overlay: $overlay"
                # Compile overlay to DTB
                dtc -@ -I dts -O dtb -o "${OVERLAY_PATH%.dtso}.dtbo" "$OVERLAY_PATH" || {
                    echo "Warning: Failed to compile overlay: $overlay"
                }
            else
                echo "Warning: Overlay file not found: $OVERLAY_PATH"
            fi
        done
    fi
fi

# ============================================================================
# INSTALL KERNEL ARTIFACTS
# ============================================================================
# Copy kernel image, modules, and DTBs to output directory
# ============================================================================

progress "Installing kernel artifacts..."

mkdir -p "$KERNEL_OUTPUT_DIR"

# Copy kernel image
KERNEL_IMAGE_PATH=""
if [ "$KERNEL_ARCH" = "x86_64" ]; then
    KERNEL_IMAGE_PATH="arch/x86/boot/bzImage"
elif [ "$KERNEL_ARCH" = "arm64" ]; then
    KERNEL_IMAGE_PATH="arch/arm64/boot/Image"
elif [ "$KERNEL_ARCH" = "arm" ]; then
    KERNEL_IMAGE_PATH="arch/arm/boot/zImage"
fi

if [ -n "$KERNEL_IMAGE_PATH" ] && [ -f "$KERNEL_IMAGE_PATH" ]; then
    cp "$KERNEL_IMAGE_PATH" "$KERNEL_OUTPUT_DIR/$KERNEL_IMAGE" || {
        echo "Error: Failed to copy kernel image"
        exit 1
    }
    cp "$KERNEL_OUTPUT_DIR/$KERNEL_IMAGE" "$KERNEL_OUTPUT_DIR/kernel.img" || {
        echo "Error: Failed to copy kernel image to kernel.img"
        exit 1
    }
    progress "Kernel image copied: $KERNEL_IMAGE (kernel.img)"
fi

# Install modules
MODULES_DIR="$KERNEL_OUTPUT_DIR/modules"
mkdir -p "$MODULES_DIR"
make ARCH="$KERNEL_ARCH" ${CROSS_COMPILE:+CROSS_COMPILE="$CROSS_COMPILE"} INSTALL_MOD_PATH="$MODULES_DIR" modules_install || {
    echo "Error: Failed to install kernel modules"
    exit 1
}
progress "Kernel modules installed"

# Copy device tree blobs
if [ -n "$KERNEL_DTS" ] && [ "$KERNEL_DTS" != "null" ]; then
    DTB_OUTPUT_DIR="$KERNEL_OUTPUT_DIR/dtbs"
    mkdir -p "$DTB_OUTPUT_DIR"
    
    # If we compiled an external DTB, it's already in the output directory
    # Still copy any kernel-built DTBs (from make dtbs) if they exist
    if [ "$EXTERNAL_DTB_ALREADY_COPIED" != "true" ]; then
        # Find and copy all DTBs from kernel build
        DTB_ARCH_DIR=""
        if [ "$KERNEL_ARCH" = "arm64" ]; then
            DTB_ARCH_DIR="arch/arm64/boot/dts"
        elif [ "$KERNEL_ARCH" = "arm" ]; then
            DTB_ARCH_DIR="arch/arm/boot/dts"
        fi
        
        if [ -n "$DTB_ARCH_DIR" ] && [ -d "$DTB_ARCH_DIR" ]; then
            # Count DTBs found
            DTB_COUNT=$(find "$DTB_ARCH_DIR" -name "*.dtb" 2>/dev/null | wc -l)
            progress "Found $DTB_COUNT DTB files to copy"
            
            find "$DTB_ARCH_DIR" -name "*.dtb" -exec cp {} "$DTB_OUTPUT_DIR/" \; || true
            progress "Device tree blobs copied"
        fi
    else
        # Verify the external DTB was compiled successfully
        if [ -n "$CUSTOM_DTB_NAME" ] && [ -f "$DTB_OUTPUT_DIR/$CUSTOM_DTB_NAME" ]; then
            progress "Custom DTB verified: $CUSTOM_DTB_NAME"
        elif [ -n "$CUSTOM_DTB_NAME" ]; then
            echo "Warning: Custom DTB not found in output: $CUSTOM_DTB_NAME"
        fi
    fi
    
    # Copy compiled overlays if any
    if [ -n "$KERNEL_DTS_OVERLAYS" ]; then
        OVERLAY_ARRAY=()
        while IFS= read -r overlay; do
            [ -n "$overlay" ] && OVERLAY_ARRAY+=("$overlay")
        done <<< "$KERNEL_DTS_OVERLAYS"
        
        for overlay in "${OVERLAY_ARRAY[@]}"; do
            if [[ "$overlay" =~ ^\./ ]]; then
                OVERLAY_PATH="$BSP_FOLDER/${overlay#./}"
            else
                OVERLAY_PATH="$BSP_FOLDER/$overlay"
            fi
            
            DTB_OVERLAY="${OVERLAY_PATH%.dtso}.dtbo"
            if [ -f "$DTB_OVERLAY" ]; then
                cp "$DTB_OVERLAY" "$DTB_OUTPUT_DIR/" || true
            fi
        done
    fi
fi

# Copy kernel config for reference
cp .config "$KERNEL_OUTPUT_DIR/.config" 2>/dev/null || true

progress "Kernel build completed successfully"
