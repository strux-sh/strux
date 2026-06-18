#!/bin/bash

set -eo pipefail

# Define A Function to Print Progress Messages that will be used by the Strux CLI
progress() {
    echo "STRUX_PROGRESS: $1"
}

PROJECT_DIR="${PROJECT_DIR:-/project}"
CACHE_DIR="${BSP_CACHE_DIR:-$PROJECT_DIR/dist/cache}"
KERNEL_SOURCE_DIR="$CACHE_DIR/kernel-source"

# Get kernel source from environment or bsp.yaml
if [ -z "$KERNEL_SOURCE" ]; then
    BSP_NAME="${PRESELECTED_BSP}"
    BSP_FOLDER="$PROJECT_DIR/bsp/$BSP_NAME"
    BSP_CONFIG="$BSP_FOLDER/bsp.yaml"
    
    if [ ! -f "$BSP_CONFIG" ]; then
        echo "Error: BSP configuration file not found: $BSP_CONFIG"
        exit 1
    fi
    
    KERNEL_SOURCE=$(yq '.bsp.boot.kernel.source' "$BSP_CONFIG" 2>/dev/null || echo "")
fi

if [ -z "$KERNEL_SOURCE" ]; then
    echo "Error: Kernel source not specified"
    exit 1
fi

# Trim whitespace and remove surrounding quotes from yq output
KERNEL_SOURCE=$(echo "$KERNEL_SOURCE" | xargs | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")

# Parse URL and optional git ref
SOURCE_URL="${KERNEL_SOURCE%%#*}"
GIT_REF="${KERNEL_SOURCE#*#}"
if [ "$GIT_REF" = "$KERNEL_SOURCE" ]; then
    GIT_REF=""  # No fragment present
fi

# Trim whitespace and remove quotes from GIT_REF as well
GIT_REF=$(echo "$GIT_REF" | xargs | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")

progress "Fetching kernel source from $SOURCE_URL${GIT_REF:+ (ref: $GIT_REF)}..."

mkdir -p "$KERNEL_SOURCE_DIR"

# Detect source type and fetch
if [[ "$SOURCE_URL" =~ \.(tar\.gz|tar\.xz|tar\.bz2|tgz)$ ]]; then
    # Tarball source
    if [ ! -d "$KERNEL_SOURCE_DIR" ] || [ -z "$(ls -A $KERNEL_SOURCE_DIR 2>/dev/null)" ]; then
        progress "Downloading kernel tarball..."
        cd "$KERNEL_SOURCE_DIR"
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
        progress "Kernel source already exists, skipping download"
    fi
else
    # Git source
    if [ ! -d "$KERNEL_SOURCE_DIR/.git" ]; then
        progress "Cloning kernel repository..."
        
        if [ -n "$GIT_REF" ]; then
            # --depth 1 --branch only works for branches and tags. If the ref
            # is a commit hash, fall back to a shallow fetch of that commit
            # (GitHub supports uploadpack.allowReachableSHA1InWant), and as a
            # last resort a full clone + checkout.
            if git clone --depth 1 --branch "$GIT_REF" "$SOURCE_URL" "$KERNEL_SOURCE_DIR" 2>/dev/null; then
                progress "Shallow clone succeeded (branch/tag: $GIT_REF)"
            else
                progress "Shallow branch clone failed, trying commit hash fetch..."
                rm -rf "$KERNEL_SOURCE_DIR"
                mkdir -p "$KERNEL_SOURCE_DIR"
                cd "$KERNEL_SOURCE_DIR"
                git init
                # The cache dir is a bind mount; mark it safe BEFORE fetching
                # or git aborts with "detected dubious ownership".
                git config --global --add safe.directory "$KERNEL_SOURCE_DIR" 2>/dev/null || true
                git remote add origin "$SOURCE_URL"
                # Fetching by commit SHA needs wire protocol v2 on GitHub.
                FETCH_ERR=$(mktemp)
                if git -c protocol.version=2 fetch --depth 1 origin "$GIT_REF" 2>"$FETCH_ERR"; then
                    rm -f "$FETCH_ERR"
                    git checkout FETCH_HEAD || {
                        echo "Error: Failed to checkout fetched commit: $GIT_REF"
                        exit 1
                    }
                    progress "Shallow commit fetch succeeded ($GIT_REF)"
                else
                    echo "Shallow commit fetch failed:" >&2
                    cat "$FETCH_ERR" >&2 || true
                    rm -f "$FETCH_ERR"
                    progress "Shallow fetch not supported, falling back to full clone..."
                    cd /
                    rm -rf "$KERNEL_SOURCE_DIR"
                    git clone "$SOURCE_URL" "$KERNEL_SOURCE_DIR" || {
                        echo "Error: Failed to clone kernel repository with ref: $GIT_REF"
                        exit 1
                    }
                    cd "$KERNEL_SOURCE_DIR"
                    git checkout "$GIT_REF" || {
                        echo "Error: Failed to checkout ref: $GIT_REF"
                        exit 1
                    }
                fi
            fi
        else
            git clone --depth 1 "$SOURCE_URL" "$KERNEL_SOURCE_DIR" || {
                echo "Error: Failed to clone kernel repository"
                exit 1
            }
        fi
        
        # Fix Git ownership issues in Docker (files mounted from host)
        # Must be done after clone since directory didn't exist before
        git config --global --add safe.directory "$KERNEL_SOURCE_DIR" 2>/dev/null || true
    else
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
    fi
fi

progress "Kernel source ready at $KERNEL_SOURCE_DIR"
