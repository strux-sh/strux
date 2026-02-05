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
BOOTLOADER_SOURCE_DIR="$CACHE_DIR/bootloader-source"
BOOTLOADER_BUILD_DIR="$CACHE_DIR/bootloader"
BOOTLOADER_OUTPUT_DIR="$BOOTLOADER_BUILD_DIR"

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

# Get bootloader configuration from BSP config
BOOTLOADER_TYPE=$(yq '.bsp.boot.bootloader.type' "$BSP_CONFIG" 2>/dev/null | xargs || echo "")
BOOTLOADER_SOURCE=$(yq '.bsp.boot.bootloader.source' "$BSP_CONFIG" 2>/dev/null || echo "")
BOOTLOADER_VERSION=$(yq '.bsp.boot.bootloader.version' "$BSP_CONFIG" 2>/dev/null || echo "")
BOOTLOADER_DEFCONFIG=$(yq '.bsp.boot.bootloader.defconfig' "$BSP_CONFIG" 2>/dev/null | xargs || echo "")
BOOTLOADER_FRAGMENTS=$(yq -r '.bsp.boot.bootloader.fragments[]' "$BSP_CONFIG" 2>/dev/null || echo "")
BOOTLOADER_PATCHES=$(yq '.bsp.boot.bootloader.patches[]' "$BSP_CONFIG" 2>/dev/null || echo "")
BOOTLOADER_DTS=$(yq '.bsp.boot.bootloader.device_tree.dts' "$BSP_CONFIG" 2>/dev/null | xargs || echo "")
BOOT_BLOBS_COUNT=$(yq '.bsp.boot.bootloader.blobs | length' "$BSP_CONFIG" 2>/dev/null || echo "0")

# Skip if custom or none - BSP scripts handle it
if [ "$BOOTLOADER_TYPE" = "custom" ] || [ "$BOOTLOADER_TYPE" = "none" ]; then
    progress "Bootloader type is '$BOOTLOADER_TYPE' - skipping built-in build"
    exit 0
fi

if [ -z "$BOOT_BLOBS_COUNT" ] || [ "$BOOT_BLOBS_COUNT" = "null" ]; then
    BOOT_BLOBS_COUNT=0
fi

BOOTLOADER_MAKE_VARS=()

if [ -z "$BOOTLOADER_SOURCE" ]; then
    echo "Error: Bootloader source not specified in $BSP_CONFIG"
    exit 1
fi

# Trim whitespace and remove surrounding quotes from yq output
BOOTLOADER_SOURCE=$(echo "$BOOTLOADER_SOURCE" | xargs | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
BOOTLOADER_DTS=$(echo "$BOOTLOADER_DTS" | xargs | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
BOOTLOADER_DEFCONFIG=$(echo "$BOOTLOADER_DEFCONFIG" | xargs | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")

# ============================================================================
# OPTIONAL BOOT BLOBS
# ============================================================================
# Stage optional firmware blobs and map known roles to U-Boot make variables
# ============================================================================

if [ "$BOOT_BLOBS_COUNT" -gt 0 ]; then
    progress "Staging boot blobs..."

    BLOBS_DIR="$BOOTLOADER_OUTPUT_DIR/blobs"
    mkdir -p "$BLOBS_DIR"
    : > "$BLOBS_DIR/manifest.tsv"

    for ((i=0; i<BOOT_BLOBS_COUNT; i++)); do
        BLOB_ID=$(yq -r ".bsp.boot.bootloader.blobs[$i].id" "$BSP_CONFIG" 2>/dev/null | xargs || echo "")
        BLOB_ROLE=$(yq -r ".bsp.boot.bootloader.blobs[$i].role" "$BSP_CONFIG" 2>/dev/null | xargs || echo "")
        BLOB_PATH=$(yq -r ".bsp.boot.bootloader.blobs[$i].path" "$BSP_CONFIG" 2>/dev/null | xargs || echo "")
        BLOB_REQUIRED=$(yq -r ".bsp.boot.bootloader.blobs[$i].required" "$BSP_CONFIG" 2>/dev/null | xargs || echo "")
        BLOB_SHA256=$(yq -r ".bsp.boot.bootloader.blobs[$i].sha256" "$BSP_CONFIG" 2>/dev/null | xargs || echo "")
        BLOB_MAKE_VAR=$(yq -r ".bsp.boot.bootloader.blobs[$i].make_var" "$BSP_CONFIG" 2>/dev/null | xargs || echo "")

        if [ "$BLOB_ID" = "null" ] || [ -z "$BLOB_ID" ]; then
            BLOB_ID="blob_$i"
        fi

        if [ "$BLOB_ROLE" = "null" ] || [ -z "$BLOB_ROLE" ]; then
            BLOB_ROLE="unknown"
        fi

        if [ "$BLOB_PATH" = "null" ] || [ -z "$BLOB_PATH" ]; then
            if [ "$BLOB_REQUIRED" = "true" ]; then
                echo "Error: Required boot blob missing path: $BLOB_ID"
                exit 1
            fi
            echo "Warning: Boot blob missing path, skipping: $BLOB_ID"
            continue
        fi

        if [[ "$BLOB_PATH" =~ ^\./ ]]; then
            RESOLVED_BLOB_PATH="$BSP_FOLDER/${BLOB_PATH#./}"
        elif [[ "$BLOB_PATH" =~ ^/ ]]; then
            RESOLVED_BLOB_PATH="$BLOB_PATH"
        else
            RESOLVED_BLOB_PATH="$BSP_FOLDER/$BLOB_PATH"
        fi

        if [ ! -f "$RESOLVED_BLOB_PATH" ]; then
            if [ "$BLOB_REQUIRED" = "true" ]; then
                echo "Error: Required boot blob not found: $BLOB_ID ($RESOLVED_BLOB_PATH)"
                exit 1
            fi
            echo "Warning: Boot blob not found, skipping: $BLOB_ID ($RESOLVED_BLOB_PATH)"
            continue
        fi

        if [ -n "$BLOB_SHA256" ] && [ "$BLOB_SHA256" != "null" ]; then
            if command -v sha256sum >/dev/null 2>&1; then
                echo "$BLOB_SHA256  $RESOLVED_BLOB_PATH" | sha256sum -c - || {
                    echo "Error: SHA256 mismatch for blob: $BLOB_ID"
                    exit 1
                }
            elif command -v shasum >/dev/null 2>&1; then
                echo "$BLOB_SHA256  $RESOLVED_BLOB_PATH" | shasum -a 256 -c - || {
                    echo "Error: SHA256 mismatch for blob: $BLOB_ID"
                    exit 1
                }
            else
                echo "Warning: No sha256 tool found; skipping checksum for $BLOB_ID"
            fi
        fi

        mkdir -p "$BLOBS_DIR/$BLOB_ROLE"
        cp "$RESOLVED_BLOB_PATH" "$BLOBS_DIR/$BLOB_ROLE/$BLOB_ID"
        printf "%s\t%s\t%s\n" "$BLOB_ID" "$BLOB_ROLE" "$RESOLVED_BLOB_PATH" >> "$BLOBS_DIR/manifest.tsv"
        progress "Staged blob: $BLOB_ID ($BLOB_ROLE)"

        if [ -n "$BLOB_MAKE_VAR" ] && [ "$BLOB_MAKE_VAR" != "null" ]; then
            BOOTLOADER_MAKE_VARS+=("$BLOB_MAKE_VAR=$RESOLVED_BLOB_PATH")
        else
            case "$BLOB_ROLE" in
                bl31)
                    BOOTLOADER_MAKE_VARS+=("BL31=$RESOLVED_BLOB_PATH")
                    ;;
                bl32|tee)
                    BOOTLOADER_MAKE_VARS+=("TEE=$RESOLVED_BLOB_PATH")
                    ;;
            esac
        fi
    done
fi

# ============================================================================
# ARCHITECTURE MAPPING FOR BOOTLOADER CROSS-COMPILATION
# ============================================================================
# Map Strux architecture to bootloader ARCH and cross-compiler
# ============================================================================

# Map architecture to bootloader ARCH and cross-compiler
if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "x86_64" ]; then
    BOOTLOADER_ARCH="x86"
    CROSS_COMPILE=""
    ARCH_LABEL="x86_64"
elif [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
    BOOTLOADER_ARCH="arm64"
    CROSS_COMPILE="aarch64-linux-gnu-"
    ARCH_LABEL="ARM64"
elif [ "$ARCH" = "armhf" ] || [ "$ARCH" = "armv7" ] || [ "$ARCH" = "arm" ]; then
    BOOTLOADER_ARCH="arm"
    CROSS_COMPILE="arm-linux-gnueabihf-"
    ARCH_LABEL="ARMv7/ARMHF"
else
    echo "Error: Unsupported architecture: $ARCH"
    exit 1
fi

progress "Building bootloader ($BOOTLOADER_TYPE) for $ARCH_LABEL..."

# Display cross-compilation info
if [ -n "$CROSS_COMPILE" ]; then
    progress "Cross-compilation enabled: CROSS_COMPILE=$CROSS_COMPILE"
    progress "Target architecture: $BOOTLOADER_ARCH"
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
    progress "Target architecture: $BOOTLOADER_ARCH (matches host)"
fi

# ============================================================================
# SOURCE FETCHING
# ============================================================================
# Parse URL fragment for git ref and fetch bootloader source
# ============================================================================

# Parse URL and optional git ref from fragment
SOURCE_URL="${BOOTLOADER_SOURCE%%#*}"
GIT_REF="${BOOTLOADER_SOURCE#*#}"
if [ "$GIT_REF" = "$BOOTLOADER_SOURCE" ]; then
    GIT_REF=""  # No fragment present
fi

# Trim whitespace and remove quotes from GIT_REF as well
GIT_REF=$(echo "$GIT_REF" | xargs | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")

progress "Fetching bootloader source from $SOURCE_URL${GIT_REF:+ (ref: $GIT_REF)}..."

# Create bootloader source directory
mkdir -p "$BOOTLOADER_SOURCE_DIR"

# Detect source type and fetch
if [[ "$SOURCE_URL" =~ \.(tar\.gz|tar\.xz|tar\.bz2|tgz)$ ]]; then
    # Tarball source
    progress "Downloading bootloader tarball..."
    cd "$BOOTLOADER_SOURCE_DIR"
    
    TARBALL_NAME=$(basename "$SOURCE_URL")
    wget -q --show-progress -O "$TARBALL_NAME" "$SOURCE_URL" || {
        echo "Error: Failed to download bootloader tarball"
        exit 1
    }
    
    progress "Extracting bootloader tarball..."
    tar xf "$TARBALL_NAME" --strip-components=1 || {
        echo "Error: Failed to extract bootloader tarball"
        exit 1
    }
    
    rm -f "$TARBALL_NAME"
else
    # Git source
    progress "Cloning bootloader repository..."
    
    # Check if we already have the source with the correct ref
    if [ -d "$BOOTLOADER_SOURCE_DIR/.git" ]; then
        cd "$BOOTLOADER_SOURCE_DIR"
        # Fix Git ownership issues in Docker (files mounted from host)
        git config --global --add safe.directory "$BOOTLOADER_SOURCE_DIR" 2>/dev/null || true
        
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
            git clone --depth 1 --branch "$GIT_REF" "$SOURCE_URL" "$BOOTLOADER_SOURCE_DIR" || {
                echo "Error: Failed to clone bootloader repository with ref: $GIT_REF"
                exit 1
            }
        else
            git clone --depth 1 "$SOURCE_URL" "$BOOTLOADER_SOURCE_DIR" || {
                echo "Error: Failed to clone bootloader repository"
                exit 1
            }
        fi
        
        # Fix Git ownership issues in Docker (files mounted from host)
        # Must be done after clone since directory didn't exist before
        git config --global --add safe.directory "$BOOTLOADER_SOURCE_DIR" 2>/dev/null || true
    fi
    
    cd "$BOOTLOADER_SOURCE_DIR"
fi

progress "Bootloader source ready at $BOOTLOADER_SOURCE_DIR"

chown -R root:root "$BOOTLOADER_SOURCE_DIR"

# ============================================================================
# OPTIONAL BOOTLOADER DEVICE TREE
# ============================================================================
# Allow BSP to provide a custom U-Boot device tree for SPL/U-Boot init
# ============================================================================

BOOTLOADER_DTS_NAME=""
BOOTLOADER_DTS_CONFIG=""
BOOTLOADER_OF_LIST_CONFIG=""
BOOTLOADER_SPL_OF_LIST_CONFIG=""

if [ -n "$BOOTLOADER_DTS" ] && [ "$BOOTLOADER_DTS" != "null" ]; then
    if [[ "$BOOTLOADER_DTS" =~ ^\./ ]]; then
        BOOTLOADER_DTS_PATH="$BSP_FOLDER/${BOOTLOADER_DTS#./}"
    elif [[ "$BOOTLOADER_DTS" =~ ^/ ]]; then
        BOOTLOADER_DTS_PATH="$BOOTLOADER_DTS"
    else
        BOOTLOADER_DTS_PATH=""
        BOOTLOADER_DTS_NAME="${BOOTLOADER_DTS%.dts}"
    fi

    if [ -n "$BOOTLOADER_DTS_PATH" ]; then
        if [ ! -f "$BOOTLOADER_DTS_PATH" ]; then
            echo "Error: Bootloader DTS not found: $BOOTLOADER_DTS_PATH"
            exit 1
        fi

        BOOTLOADER_DTS_BASENAME="$(basename "$BOOTLOADER_DTS_PATH")"
        BOOTLOADER_DTS_NAME="${BOOTLOADER_DTS_BASENAME%.dts}"

        mkdir -p "$BOOTLOADER_SOURCE_DIR/arch/arm/dts"
        cp "$BOOTLOADER_DTS_PATH" "$BOOTLOADER_SOURCE_DIR/arch/arm/dts/$BOOTLOADER_DTS_BASENAME"
        progress "Staged bootloader DTS: $BOOTLOADER_DTS_BASENAME"
    fi

    if [ -n "$BOOTLOADER_DTS_NAME" ]; then
        BOOTLOADER_DTS_CONFIG="CONFIG_DEFAULT_DEVICE_TREE=\"${BOOTLOADER_DTS_NAME}\""
        BOOTLOADER_OF_LIST_CONFIG="CONFIG_OF_LIST=\"${BOOTLOADER_DTS_NAME}\""
        BOOTLOADER_SPL_OF_LIST_CONFIG="CONFIG_SPL_OF_LIST=\"${BOOTLOADER_DTS_NAME}\""
        progress "Using bootloader default device tree: $BOOTLOADER_DTS_NAME"
    fi
fi

# ============================================================================
# PATCH APPLICATION
# ============================================================================
# Apply patches from bsp.yaml configuration
# ============================================================================

if [ -n "$BOOTLOADER_PATCHES" ]; then
    progress "Applying bootloader patches..."
    
    # Convert patches to array (handle both single and multiple patches)
    PATCH_ARRAY=()
    while IFS= read -r patch; do
        [ -n "$patch" ] && PATCH_ARRAY+=("$patch")
    done <<< "$BOOTLOADER_PATCHES"
    
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
# BOOTLOADER BUILD
# ============================================================================
# Build U-Boot or GRUB based on type
# ============================================================================

mkdir -p "$BOOTLOADER_OUTPUT_DIR"

chown -R root:root "$BOOTLOADER_OUTPUT_DIR"
if [ "$BOOTLOADER_TYPE" = "u-boot" ]; then
    progress "Building U-Boot..."
    
    # Create build directory
    mkdir -p "$BOOTLOADER_BUILD_DIR"
    cd "$BOOTLOADER_SOURCE_DIR"

    # If we are reusing a cached source checkout, ensure the *source* tree is clean.
    # U-Boot will error when using O= if the source tree contains build artifacts
    # (e.g. a stray .config created by merge_config.sh).
    if [ -f "$BOOTLOADER_SOURCE_DIR/.config" ] || [ -d "$BOOTLOADER_SOURCE_DIR/include/config" ] || [ -d "$BOOTLOADER_SOURCE_DIR/include/generated" ]; then
        progress "Cleaning U-Boot source tree (mrproper)..."
        make ARCH="$BOOTLOADER_ARCH" ${CROSS_COMPILE:+CROSS_COMPILE="$CROSS_COMPILE"} mrproper || true
    fi
    
    # Handle defconfig
    if [ -z "$BOOTLOADER_DEFCONFIG" ] || [ "$BOOTLOADER_DEFCONFIG" = "null" ]; then
        echo "Error: U-Boot defconfig not specified in $BSP_CONFIG"
        exit 1
    fi

    DEFCONFIG_PATH="$BOOTLOADER_SOURCE_DIR/configs/$BOOTLOADER_DEFCONFIG"
    
    # Apply defconfig
    progress "Applying U-Boot defconfig: $BOOTLOADER_DEFCONFIG"
    make O="$BOOTLOADER_BUILD_DIR" ARCH="$BOOTLOADER_ARCH" ${CROSS_COMPILE:+CROSS_COMPILE="$CROSS_COMPILE"} "$BOOTLOADER_DEFCONFIG" || {
        echo "Error: Failed to apply U-Boot defconfig: $BOOTLOADER_DEFCONFIG"
        exit 1
    }

    # Some older/vendor U-Boot trees ignore O= for defconfig and write .config in the source tree.
    # Detect that case and recover so subsequent O= builds use the correct configuration.
    if [ ! -s "$BOOTLOADER_BUILD_DIR/.config" ]; then
        progress "Defconfig did not create $BOOTLOADER_BUILD_DIR/.config; retrying in source tree for compatibility..."
        make ARCH="$BOOTLOADER_ARCH" ${CROSS_COMPILE:+CROSS_COMPILE="$CROSS_COMPILE"} "$BOOTLOADER_DEFCONFIG" || {
            echo "Error: Failed to apply U-Boot defconfig in source tree: $BOOTLOADER_DEFCONFIG"
            exit 1
        }

        if [ ! -s "$BOOTLOADER_SOURCE_DIR/.config" ]; then
            echo "Error: Defconfig did not generate .config in source tree"
            exit 1
        fi

        cp "$BOOTLOADER_SOURCE_DIR/.config" "$BOOTLOADER_BUILD_DIR/.config"
        progress "Copied .config from source tree into O= build directory"

        # Keep the source tree clean for O= builds
        make ARCH="$BOOTLOADER_ARCH" ${CROSS_COMPILE:+CROSS_COMPILE="$CROSS_COMPILE"} mrproper || true

        # Regenerate auto.conf in O=
        make O="$BOOTLOADER_BUILD_DIR" ARCH="$BOOTLOADER_ARCH" ${CROSS_COMPILE:+CROSS_COMPILE="$CROSS_COMPILE"} olddefconfig || {
            echo "Error: Failed to re-sync U-Boot configuration in O= build directory"
            exit 1
        }
    fi

    # Sanity check: ensure defconfig actually selected RK3288 / ARMv7
    if ! grep -qE '^CONFIG_ROCKCHIP_RK3288=y|^CONFIG_TARGET_EVB_RK3288=y' "$BOOTLOADER_BUILD_DIR/.config"; then
        echo "Error: U-Boot defconfig did not enable RK3288 symbols."
        echo "Check that $BOOTLOADER_DEFCONFIG is the correct defconfig for this tree."
        echo "Detected config summary:"
        grep -E '^CONFIG_SYS_CPU=|^CONFIG_SYS_ARCH=|^CONFIG_CPU_V7=|^CONFIG_ARMV7=' "$BOOTLOADER_BUILD_DIR/.config" || true
        exit 1
    fi

    
    # Apply fragments if any
    if [ -n "$BOOTLOADER_FRAGMENTS" ]; then
        progress "Applying U-Boot configuration fragments..."
        
        # Convert fragments to array
        FRAGMENT_ARRAY=()
        while IFS= read -r fragment; do
            [ -n "$fragment" ] && FRAGMENT_ARRAY+=("$fragment")
        done <<< "$BOOTLOADER_FRAGMENTS"
        
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
                FRAGMENT_TMP_FILE="$FRAGMENT_TMP_DIR/fragment_${#FRAGMENT_FILES[@]}.config"
                printf '%b\n' "$fragment" > "$FRAGMENT_TMP_FILE"
                FRAGMENT_FILES+=("$FRAGMENT_TMP_FILE")
            fi
        done
        
        # IMPORTANT:
        # Do NOT run U-Boot's merge_config.sh in the source tree when using O= builds.
        # It can write a stray .config / generated files into $BOOTLOADER_SOURCE_DIR,
        # which makes the source tree "not clean" and causes subsequent make invocations to fail.
        #
        # Instead, apply fragments directly to the O= build directory's .config and then
        # run olddefconfig to materialize include/config/auto.conf etc. inside O=.
        if [ ${#FRAGMENT_FILES[@]} -gt 0 ]; then
            # Manually merge fragments by appending them to the end of the build .config.
            # Kconfig uses "last assignment wins", so later fragments override earlier values.
            for fragment_file in "${FRAGMENT_FILES[@]}"; do
                cat "$fragment_file" >> "$BOOTLOADER_BUILD_DIR/.config"
            done

            # Re-sync the merged config and generate required auto files in O=
            make O="$BOOTLOADER_BUILD_DIR" ARCH="$BOOTLOADER_ARCH" ${CROSS_COMPILE:+CROSS_COMPILE="$CROSS_COMPILE"} olddefconfig || {
                echo "Error: Failed to apply merged U-Boot configuration (olddefconfig)"
                rm -rf "$FRAGMENT_TMP_DIR"
                exit 1
            }
            
            rm -rf "$FRAGMENT_TMP_DIR"
            progress "Applied ${#FRAGMENT_FILES[@]} configuration fragment(s)"
        fi
    fi

    # Apply bootloader device tree override after fragments (if provided)
    if [ -n "$BOOTLOADER_DTS_CONFIG" ]; then
        echo "$BOOTLOADER_DTS_CONFIG" >> "$BOOTLOADER_BUILD_DIR/.config"
        if [ -n "$BOOTLOADER_OF_LIST_CONFIG" ]; then
            # Ensure CONFIG_OF_LIST includes our DTS so binman can find it
            echo "$BOOTLOADER_OF_LIST_CONFIG" >> "$BOOTLOADER_BUILD_DIR/.config"
        fi
        if [ -n "$BOOTLOADER_SPL_OF_LIST_CONFIG" ]; then
            echo "$BOOTLOADER_SPL_OF_LIST_CONFIG" >> "$BOOTLOADER_BUILD_DIR/.config"
        fi
        make O="$BOOTLOADER_BUILD_DIR" ARCH="$BOOTLOADER_ARCH" ${CROSS_COMPILE:+CROSS_COMPILE="$CROSS_COMPILE"} olddefconfig || {
            echo "Error: Failed to apply bootloader device tree config"
            exit 1
        }
        progress "Applied bootloader device tree config: $BOOTLOADER_DTS_NAME"
    fi
    
    # Build U-Boot
    progress "Compiling U-Boot..."
    chown -R root:root "$BOOTLOADER_BUILD_DIR"
    make -j$(nproc) ARCH="$BOOTLOADER_ARCH" CROSS_COMPILE="$CROSS_COMPILE" || {
        echo "Error: Failed to build U-Boot"
        exit 1
    }
    
    # Copy U-Boot artifacts to output directory
    progress "Installing U-Boot artifacts..."
    mkdir -p "$BOOTLOADER_OUTPUT_DIR"
    
    # Copy common U-Boot outputs
    if [ "$BOOTLOADER_BUILD_DIR" != "$BOOTLOADER_OUTPUT_DIR" ]; then
        if [ -f "$BOOTLOADER_BUILD_DIR/u-boot.bin" ]; then
            cp "$BOOTLOADER_BUILD_DIR/u-boot.bin" "$BOOTLOADER_OUTPUT_DIR/"
        fi
        if [ -f "$BOOTLOADER_BUILD_DIR/u-boot.itb" ]; then
            cp "$BOOTLOADER_BUILD_DIR/u-boot.itb" "$BOOTLOADER_OUTPUT_DIR/"
        fi
        if [ -f "$BOOTLOADER_BUILD_DIR/u-boot.img" ]; then
            cp "$BOOTLOADER_BUILD_DIR/u-boot.img" "$BOOTLOADER_OUTPUT_DIR/"
        fi
    fi
    
    # Copy SPL if it exists
    if [ -d "$BOOTLOADER_BUILD_DIR/spl" ]; then
        mkdir -p "$BOOTLOADER_OUTPUT_DIR/spl"
        cp -r "$BOOTLOADER_BUILD_DIR/spl"/* "$BOOTLOADER_OUTPUT_DIR/spl/" 2>/dev/null || true
    fi
    
    # Copy config for reference
    cp "$BOOTLOADER_BUILD_DIR/.config" "$BOOTLOADER_OUTPUT_DIR/.config" 2>/dev/null || true
    
    progress "U-Boot build completed successfully"
    
elif [ "$BOOTLOADER_TYPE" = "grub" ]; then
    progress "Building GRUB..."
    
    # GRUB build logic would go here
    # This is a placeholder - GRUB builds differently than U-Boot
    echo "Warning: GRUB build not yet implemented"
    echo "GRUB build requires different build system (autotools)"
    
    # For now, create a placeholder output
    mkdir -p "$BOOTLOADER_OUTPUT_DIR"
    touch "$BOOTLOADER_OUTPUT_DIR/.grub-placeholder"
    
    progress "GRUB build placeholder created (not yet implemented)"
    
else
    echo "Error: Unsupported bootloader type: $BOOTLOADER_TYPE"
    exit 1
fi

progress "Bootloader build completed successfully"
