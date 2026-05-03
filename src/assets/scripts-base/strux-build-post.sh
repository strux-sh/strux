#!/bin/bash

set -eo pipefail

# Trap errors and print the failing command/line
trap 'echo "Error: Command failed at line $LINENO with exit code $?: $BASH_COMMAND" >&2' ERR

progress() {
    echo "STRUX_PROGRESS: $1"
}

progress "Post-processing Root Filesystem..."

PROJECT_DIR="${PROJECT_DIR:-/project}"
PROJECT_DIST_DIR="${PROJECT_DIST_DIR:-$PROJECT_DIR/dist}"
ROOTFS_DIR="/tmp/rootfs"

# Use BSP_CACHE_DIR if provided, otherwise fallback to default
BSP_CACHE="${BSP_CACHE_DIR:-$PROJECT_DIST_DIR/cache}"
# Shared cache for architecture-agnostic artifacts like frontend
SHARED_CACHE="${SHARED_CACHE_DIR:-$PROJECT_DIST_DIR/cache}"

# Function to run commands in chroot
run_in_chroot() {
    chroot "$ROOTFS_DIR" /bin/bash -c "$1"
}

# Create a temporary directory for the root filesystem
mkdir -p "$ROOTFS_DIR"

# Extract the root filesystem tarball into the temporary directory (from BSP-specific cache)
tar -xzf "$BSP_CACHE/rootfs-base.tar.gz" -C "$ROOTFS_DIR"

# Create the Strux Directory
mkdir -p "$ROOTFS_DIR/strux"

# ============================================================================
# SECTION 4: MOUNT NECESSARY FILESYSTEMS FOR CHROOT OPERATIONS
# ============================================================================
# Mount necessary filesystems for chroot operations
# ============================================================================


# Mount necessary filesystems for chroot operations
mount --bind /dev /tmp/rootfs/dev || true
mount --bind /dev/pts /tmp/rootfs/dev/pts || true
mount --bind /proc /tmp/rootfs/proc || true
mount --bind /sys /tmp/rootfs/sys || true

# Copy QEMU static binary for cross-arch chroot if needed
if [ "$HOST_ARCH" != "$TARGET_ARCH" ]; then
    if [ "$TARGET_ARCH" = "arm64" ] && [ -f /usr/bin/qemu-aarch64-static ]; then
        cp /usr/bin/qemu-aarch64-static "$ROOTFS_DIR/usr/bin/" 2>/dev/null || true
    elif [ "$TARGET_ARCH" = "armhf" ] && [ -f /usr/bin/qemu-arm-static ]; then
        cp /usr/bin/qemu-arm-static "$ROOTFS_DIR/usr/bin/" 2>/dev/null || true
    fi
fi



# ============================================================================
# SECTION 1: CONFIGURATION READING FROM YAML FILES
# ============================================================================
# Read the selected BSP and overlay paths from configuration files
# ============================================================================

progress "Reading configuration from YAML files..."

# Get the active BSP name - check environment variable first, then fall back to strux.yaml
if [ -n "$PRESELECTED_BSP" ]; then
    BSP_NAME="$PRESELECTED_BSP"
else
    BSP_NAME=$(yq '.bsp' "$PROJECT_DIR/strux.yaml" 2>/dev/null || echo "")
    
    if [ -z "$BSP_NAME" ]; then
        echo "Error: Could not read BSP name from $PROJECT_DIR/strux.yaml and PRESELECTED_BSP is not set"
        exit 1
    fi
fi

# Construct BSP folder path
BSP_FOLDER="$PROJECT_DIR/bsp/$BSP_NAME"
BSP_CONFIG="$BSP_FOLDER/bsp.yaml"

if [ ! -f "$BSP_CONFIG" ]; then
    echo "Error: BSP configuration file not found: $BSP_CONFIG"
    exit 1
fi


# ============================================================================
# SECTION 5: CUSTOM PACKAGE INSTALLATION
# ============================================================================
# This section installs user-specified packages from the configuration:
# - Repository packages: Installed via apt-get
# - .deb files: Copied to chroot and installed via dpkg
#
# Path resolution rules:
# - Global packages: relative to project root
# - BSP packages starting with ./: relative to BSP folder
# - BSP packages without ./: relative to project root
# ============================================================================

progress "Collecting custom packages from configuration..."

# Collect packages from global rootfs.packages
GLOBAL_PACKAGES=$(yq '.rootfs.packages[]?' "$PROJECT_DIR/strux.yaml" 2>/dev/null || echo "")

# Collect packages from BSP-specific rootfs.packages
BSP_PACKAGES=$(yq '.bsp.rootfs.packages[]?' "$BSP_CONFIG" 2>/dev/null || echo "")

# Separate repository packages from .deb file paths
REPO_PACKAGES=""
DEB_FILES=""

# Process global packages (relative to project root)
while IFS= read -r package; do
    if [ -z "$package" ]; then
        continue
    fi

    # Check if it's a .deb file (ends with .deb)
    if [[ "$package" == *.deb ]]; then
        # Global packages are relative to project root
        # Normalize path (remove ./ prefix if present)
        normalized_package="${package#./}"

        # Resolve the path relative to project directory
        if [ -f "$PROJECT_DIR/$normalized_package" ]; then
            DEB_FILES="$DEB_FILES$normalized_package\n"
        elif [ -f "$package" ]; then
            # Absolute path
            DEB_FILES="$DEB_FILES$package\n"
        else
            echo "Warning: .deb file not found: $package (checked: $PROJECT_DIR/$normalized_package)"
        fi
    else
        # It's a repository package name
        REPO_PACKAGES="$REPO_PACKAGES$package "
    fi
done <<< "$GLOBAL_PACKAGES"

# Process BSP packages (paths starting with ./ are relative to BSP folder)
while IFS= read -r package; do
    if [ -z "$package" ]; then
        continue
    fi

    # Check if it's a .deb file (ends with .deb)
    if [[ "$package" == *.deb ]]; then
        # BSP packages: if starts with ./, resolve relative to BSP folder, otherwise relative to project root
        if [[ "$package" == ./* ]]; then
            # Remove ./ prefix and resolve relative to BSP folder
            bsp_relative_path="${package#./}"
            if [ -f "$BSP_FOLDER/$bsp_relative_path" ]; then
                DEB_FILES="$DEB_FILES$BSP_FOLDER/$bsp_relative_path\n"
            else
                echo "Warning: .deb file not found: $package (checked: $BSP_FOLDER/$bsp_relative_path)"
            fi
        else
            # Not starting with ./, resolve relative to project root (like global packages)
            normalized_package="${package#./}"
            if [ -f "$PROJECT_DIR/$normalized_package" ]; then
                DEB_FILES="$DEB_FILES$normalized_package\n"
            elif [ -f "$package" ]; then
                # Absolute path
                DEB_FILES="$DEB_FILES$package\n"
            else
                echo "Warning: .deb file not found: $package (checked: $PROJECT_DIR/$normalized_package)"
            fi
        fi
    else
        # It's a repository package name - check if already added (avoid duplicates)
        if [[ ! " $REPO_PACKAGES " =~ " $package " ]]; then
            REPO_PACKAGES="$REPO_PACKAGES$package "
        fi
    fi
done <<< "$BSP_PACKAGES"

# Trim trailing spaces/newlines
REPO_PACKAGES=$(echo "$REPO_PACKAGES" | sed 's/[[:space:]]*$//')
DEB_FILES=$(echo -e "$DEB_FILES" | grep -v '^$' || true)

# Install repository packages from config
if [ -n "$REPO_PACKAGES" ]; then
    progress "Installing repository packages..."
    run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get update"
    run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        $REPO_PACKAGES"
else
    progress "No repository packages to install"
fi

# Copy and install custom .deb package files
if [ -n "$DEB_FILES" ]; then
    progress "Copying and installing custom .deb package files..."

    # Create temporary directory for .deb files in chroot
    DEB_TEMP_DIR="$ROOTFS_DIR/tmp/deb-packages"
    mkdir -p "$DEB_TEMP_DIR"

    # Copy each .deb file to chroot and install it
    while IFS= read -r deb_file; do
        if [ -z "$deb_file" ]; then
            continue
        fi

        # Normalize path (remove ./ prefix if present)
        deb_file="${deb_file#./}"

        # Resolve the path - try relative to project directory first, then absolute
        if [ -f "$PROJECT_DIR/$deb_file" ]; then
            SOURCE_FILE="$PROJECT_DIR/$deb_file"
        elif [ -f "$deb_file" ]; then
            SOURCE_FILE="$deb_file"
        else
            echo "Warning: Skipping .deb file not found: $deb_file (checked: $PROJECT_DIR/$deb_file and $deb_file)"
            continue
        fi

        # Get just the filename
        DEB_FILENAME=$(basename "$SOURCE_FILE")
        TARGET_FILE="$DEB_TEMP_DIR/$DEB_FILENAME"

        # Copy .deb file to chroot
        cp "$SOURCE_FILE" "$TARGET_FILE"

        # Install the .deb file inside chroot
        progress "Installing $DEB_FILENAME..."
        run_in_chroot "DEBIAN_FRONTEND=noninteractive dpkg -i /tmp/deb-packages/$DEB_FILENAME || apt-get install -f -y"
    done <<< "$DEB_FILES"

    # Clean up temporary directory
    rm -rf "$DEB_TEMP_DIR"
    run_in_chroot "rm -rf /tmp/deb-packages" || true
else
    progress "No .deb package files to install"
fi


# ============================================================================
# SECTION 2: APPLY ROOTFS OVERLAYS
# ============================================================================
# Apply overlays in order: BSP overlay first, then root project overlay
# Root project overlay takes precedence (copied last)
# ============================================================================

# Read BSP overlay path from BSP config
BSP_OVERLAY=$(yq -r '.bsp.rootfs.overlay' "$BSP_CONFIG" 2>/dev/null || echo "")

# Read root project overlay path from strux.yaml
ROOT_OVERLAY=$(yq -r '.rootfs.overlay' "$PROJECT_DIR/strux.yaml" 2>/dev/null || echo "")

# Apply BSP overlay first (if it exists)
if [ -n "$BSP_OVERLAY" ]; then
    # Resolve BSP overlay path
    # If it starts with ./, resolve relative to BSP folder, otherwise relative to project root
    if [[ "$BSP_OVERLAY" == ./* ]]; then
        # Remove ./ prefix and resolve relative to BSP folder
        BSP_OVERLAY_PATH="$BSP_FOLDER/${BSP_OVERLAY#./}"
    else
        # Resolve relative to project root
        BSP_OVERLAY_PATH="$PROJECT_DIR/$BSP_OVERLAY"
    fi
    
    if [ -d "$BSP_OVERLAY_PATH" ]; then
        progress "Applying BSP rootfs overlay..."
        # Use rsync to copy overlay files, preserving permissions and overwriting existing files
        # -a: archive mode (preserves permissions, timestamps, etc.)
        # -r: recursive
        # --no-owner: don't preserve ownership (we're copying into rootfs)
        # --no-group: don't preserve group (we're copying into rootfs)
        rsync -a -K --no-owner --no-group "$BSP_OVERLAY_PATH/" "$ROOTFS_DIR/"
        progress "BSP rootfs overlay applied successfully"
    else
        echo "Warning: BSP overlay directory '$BSP_OVERLAY_PATH' does not exist, skipping BSP overlay"
    fi
fi

# Apply root project overlay second (takes precedence)
if [ -n "$ROOT_OVERLAY" ]; then
    # Root overlay is always relative to project root
    # Normalize path (remove ./ prefix if present)
    normalized_overlay="${ROOT_OVERLAY#./}"
    ROOT_OVERLAY_PATH="$PROJECT_DIR/$normalized_overlay"
    
    if [ -d "$ROOT_OVERLAY_PATH" ]; then
        progress "Applying rootfs overlay..."
        # Use rsync to copy overlay files, preserving permissions and overwriting existing files
        # -a: archive mode (preserves permissions, timestamps, etc.)
        # -r: recursive
        # --no-owner: don't preserve ownership (we're copying into rootfs)
        # --no-group: don't preserve group (we're copying into rootfs)
        rsync -a -K --no-owner --no-group "$ROOT_OVERLAY_PATH/" "$ROOTFS_DIR/"
        progress "Rootfs overlay applied successfully"
    else
        echo "Warning: Overlay directory '$ROOT_OVERLAY_PATH' does not exist, skipping overlay"
    fi
fi


# ============================================================================
# SECTION 3: COPY STRUX SCRIPTS AND BINARIES
# ============================================================================
# Copy the init script, network script, main application binary, Cage, Frontend, and Systemd services
# ============================================================================


progress "Copying Strux Scripts and Binaries..."

# Copy the init script
cp "$PROJECT_DIR/dist/artifacts/scripts/init.sh" "$ROOTFS_DIR/init"
chmod +x "$ROOTFS_DIR/init"

# Copy the strux.sh script
cp "$PROJECT_DIR/dist/artifacts/scripts/strux.sh" "$ROOTFS_DIR/strux/strux.sh"
chmod +x "$ROOTFS_DIR/strux/strux.sh"

# Install the network script (It is used by strux-network.service)
cp "$PROJECT_DIR/dist/artifacts/scripts/strux-network.sh" "$ROOTFS_DIR/usr/bin/strux-network.sh"
chmod +x "$ROOTFS_DIR/usr/bin/strux-network.sh"

# Copy the main application binary (from BSP-specific cache)
cp "$BSP_CACHE/app/main" "$ROOTFS_DIR/strux/main"
chmod +x "$ROOTFS_DIR/strux/main"

# Copy Cage (Our Custom build with Splash Support) - from BSP-specific cache
cp "$BSP_CACHE/cage" "$ROOTFS_DIR/usr/bin/cage"
chmod +x "$ROOTFS_DIR/usr/bin/cage"

# Copy the Frontend (from shared cache - architecture-agnostic)
cp -r "$SHARED_CACHE/frontend" "$ROOTFS_DIR/strux/frontend"

# Backward compatibility for apps built with older runtimes.
# Those runtimes serve ./frontend while strux.sh starts the app from /,
# so they resolve the frontend bundle as /frontend.
if [ ! -e "$ROOTFS_DIR/frontend" ] && [ ! -L "$ROOTFS_DIR/frontend" ]; then
    ln -s /strux/frontend "$ROOTFS_DIR/frontend"
fi

# Copy Strux Client (Handles a bunch of system services) - from BSP-specific cache
cp "$BSP_CACHE/client" "$ROOTFS_DIR/strux/client"
chmod +x "$ROOTFS_DIR/strux/client"

# Copy Screen Capture Daemon - from BSP-specific cache
if [ -f "$BSP_CACHE/screen" ]; then
    cp "$BSP_CACHE/screen" "$ROOTFS_DIR/usr/bin/strux-screen"
    chmod +x "$ROOTFS_DIR/usr/bin/strux-screen"
    progress "Installed strux-screen daemon"
fi

# Copy WPE WebKit Extension (provides JS bridge for strux.* API) - from BSP-specific cache
mkdir -p "$ROOTFS_DIR/usr/lib/wpe-web-extensions"
cp "$BSP_CACHE/libstrux-extension.so" "$ROOTFS_DIR/usr/lib/wpe-web-extensions/libstrux-extension.so"

# Copy patched Cog binary (with --autoplay-policy support) over the Debian package version
if [ -f "$BSP_CACHE/cog" ]; then
    cp "$BSP_CACHE/cog" "$ROOTFS_DIR/usr/bin/cog"
    chmod +x "$ROOTFS_DIR/usr/bin/cog"
    progress "Installed patched Cog binary"
fi

# If the .dev-env.json file exists, copy it to the rootfs (from BSP-specific cache)
if [ -f "$BSP_CACHE/.dev-env.json" ]; then
    cp "$BSP_CACHE/.dev-env.json" "$ROOTFS_DIR/strux/.dev-env.json"
fi

# Copy display configuration JSON (written by TypeScript build pipeline)
if [ -f "$BSP_CACHE/.display-config.json" ]; then
    progress "Copying display configuration..."
    cp "$BSP_CACHE/.display-config.json" "$ROOTFS_DIR/strux/.display-config.json"
fi

# Copy input device mapping (maps touch/pointer devices to outputs)
if [ -f "$BSP_CACHE/.input-map" ]; then
    cp "$BSP_CACHE/.input-map" "$ROOTFS_DIR/strux/.input-map"
fi

# Copy the Cog launcher script (user-modifiable)
cp "$PROJECT_DIR/dist/artifacts/scripts/strux-run-cog.sh" "$ROOTFS_DIR/strux/strux-run-cog.sh"
chmod +x "$ROOTFS_DIR/strux/strux-run-cog.sh"

# Copy "not configured" HTML page for unconfigured monitor outputs
cp "$PROJECT_DIR/dist/artifacts/not-configured.html" "$ROOTFS_DIR/strux/.not-configured.html" 2>/dev/null || true

# Copy pre-built Cage environment file from cache (generated during cage build step)
CAGE_ENV_SRC="${BSP_CACHE_DIR:-$PROJECT_DIR/dist/cache}/.cage-env"
if [ -f "$CAGE_ENV_SRC" ]; then
    progress "Copying Cage environment file..."
    cp "$CAGE_ENV_SRC" "$ROOTFS_DIR/strux/.cage-env"
fi


# Copy the Systemd Services
progress "Copying Systemd Services..."

# Copy the Strux Service
cp "$PROJECT_DIR/dist/artifacts/systemd/strux.service" "$ROOTFS_DIR/etc/systemd/system/strux.service"

# Copy the Network Service Unit
cp "$PROJECT_DIR/dist/artifacts/systemd/strux-network.service" "$ROOTFS_DIR/etc/systemd/system/strux-network.service"

# Copy the 20-Ethernet.network Service
cp "$PROJECT_DIR/dist/artifacts/systemd/20-ethernet.network" "$ROOTFS_DIR/etc/systemd/network/20-ethernet.network"




# ============================================================================
# SECTION 6: INSTALL KERNEL
# ============================================================================
# This section installs the kernel into the rootfs. It handles both:
# - Default Debian kernel: installed via apt-get
# - Custom kernel: copied from pre-built artifacts in cache
# This was moved from strux-build-base.sh so that kernel changes
# don't require a full base rootfs rebuild (debootstrap + packages).
# ============================================================================

progress "Installing kernel..."

# Get architecture from BSP config
ARCH=$(yq '.bsp.arch' "$BSP_CONFIG" 2>/dev/null | xargs || echo "")

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
    progress "Resolved host architecture to $ARCH"
fi

# Map Strux arch to Debian arch
case "$ARCH" in
    arm64|aarch64)
        DEBIAN_ARCH="arm64"
        ;;
    amd64|x86_64)
        DEBIAN_ARCH="amd64"
        ;;
    armhf|armv7|arm)
        DEBIAN_ARCH="armhf"
        ;;
    *)
        echo "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

# Check if custom kernel is enabled in BSP config
CUSTOM_KERNEL=$(yq '.bsp.boot.kernel.custom_kernel' "$BSP_CONFIG" 2>/dev/null || echo "false")

if [ "$CUSTOM_KERNEL" = "true" ]; then
    STRUX_CUSTOM_KERNEL="true"
else
    STRUX_CUSTOM_KERNEL="false"
fi

export STRUX_CUSTOM_KERNEL

if [ "${STRUX_CUSTOM_KERNEL:-false}" != "true" ]; then
    # ---- Default Debian Kernel ----
    progress "Installing Debian kernel..."
    run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get update"
    run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends linux-image-$DEBIAN_ARCH"

    # Find and copy the kernel to cache
    progress "Extracting kernel image..."
    VMLINUZ=$(ls "$ROOTFS_DIR/boot/vmlinuz-"* 2>/dev/null | head -n 1)
    if [ -n "$VMLINUZ" ]; then
        mkdir -p "$BSP_CACHE"
        cp "$VMLINUZ" "$BSP_CACHE/vmlinuz"
        echo "Kernel copied to $BSP_CACHE/vmlinuz"
    fi

    # Get kernel version for depmod
    KERNEL_VERSION=$(ls "$ROOTFS_DIR/lib/modules" 2>/dev/null | head -n 1)
    if [ -n "$KERNEL_VERSION" ]; then
        progress "Generating module dependencies..."
        run_in_chroot "depmod $KERNEL_VERSION"
        echo "Module dependencies generated for kernel $KERNEL_VERSION"
    fi
else
    # ---- Custom Kernel ----
    progress "Custom kernel enabled - installing custom kernel..."

    # Read kernel version from BSP config (if provided)
    KERNEL_VERSION=$(yq '.bsp.boot.kernel.version' "$BSP_CONFIG" 2>/dev/null | xargs || echo "")
    if [ "$KERNEL_VERSION" = "null" ]; then
        KERNEL_VERSION=""
    fi

    # Determine kernel image name and architecture-specific path
    if [ "$DEBIAN_ARCH" = "arm64" ]; then
        KERNEL_IMAGE="$BSP_CACHE/kernel/Image"
        KERNEL_NAME="Image"
    elif [ "$DEBIAN_ARCH" = "armhf" ]; then
        KERNEL_IMAGE="$BSP_CACHE/kernel/zImage"
        KERNEL_NAME="zImage"
    else
        KERNEL_IMAGE="$BSP_CACHE/kernel/bzImage"
        KERNEL_NAME="bzImage"
    fi

    # Fallback to vmlinuz if architecture-specific image not found
    if [ ! -f "$KERNEL_IMAGE" ]; then
        KERNEL_IMAGE="$BSP_CACHE/kernel/vmlinuz"
        KERNEL_NAME="vmlinuz"
    fi

    if [ ! -f "$KERNEL_IMAGE" ]; then
        echo "Error: Custom kernel image not found: $KERNEL_IMAGE"
        exit 1
    fi

    # Copy kernel image to cache directory
    progress "Copying custom kernel image..."
    mkdir -p "$BSP_CACHE"
    cp "$KERNEL_IMAGE" "$BSP_CACHE/vmlinuz"
    echo "Custom kernel copied to $BSP_CACHE/vmlinuz"

    # Install to rootfs /boot/ for consistency with standard kernel
    progress "Installing custom kernel to rootfs /boot/..."
    mkdir -p "$ROOTFS_DIR/boot"
    if [ -n "$KERNEL_VERSION" ]; then
        cp "$KERNEL_IMAGE" "$ROOTFS_DIR/boot/vmlinuz-$KERNEL_VERSION"
        ln -sf "vmlinuz-$KERNEL_VERSION" "$ROOTFS_DIR/boot/vmlinuz"
        echo "Custom kernel installed to $ROOTFS_DIR/boot/vmlinuz-$KERNEL_VERSION"
    else
        cp "$KERNEL_IMAGE" "$ROOTFS_DIR/boot/vmlinuz"
        echo "Custom kernel installed to $ROOTFS_DIR/boot/vmlinuz"
    fi

    # Install kernel modules into rootfs (if they exist)
    KERNEL_MODULES_PATH="$BSP_CACHE/kernel/modules/lib/modules"

    if [ -d "$KERNEL_MODULES_PATH" ]; then
        progress "Installing custom kernel modules..."
        KERNEL_VERSION=$(ls "$KERNEL_MODULES_PATH" 2>/dev/null | head -n 1)

        if [ -n "$KERNEL_VERSION" ]; then
            # Copy modules to rootfs
            mkdir -p "$ROOTFS_DIR/lib/modules"
            cp -r "$KERNEL_MODULES_PATH/$KERNEL_VERSION" "$ROOTFS_DIR/lib/modules/"

            # Generate module dependencies
            progress "Generating module dependencies..."
            run_in_chroot "depmod $KERNEL_VERSION"
            echo "Module dependencies generated for kernel $KERNEL_VERSION"
        else
            echo "Warning: No kernel version found in modules directory"
        fi
    else
        echo "Warning: Kernel modules directory not found at $KERNEL_MODULES_PATH"
        echo "  (Expected path: $BSP_CACHE/kernel/modules/lib/modules/<version>)"
    fi

    # Install initramfs-tools if not already installed
    progress "Installing initramfs-tools..."
    run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get update"
    run_in_chroot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends initramfs-tools" || true

    # Copy DTBs to rootfs /boot/dtbs/ if they exist
    DTB_SOURCE_DIR="$BSP_CACHE/kernel/dtbs"
    if [ -d "$DTB_SOURCE_DIR" ] && [ -n "$(ls -A "$DTB_SOURCE_DIR" 2>/dev/null)" ]; then
        progress "Copying device tree blobs to rootfs /boot/dtbs/..."
        mkdir -p "$ROOTFS_DIR/boot/dtbs"
        cp -r "$DTB_SOURCE_DIR"/* "$ROOTFS_DIR/boot/dtbs/" 2>/dev/null || true
        echo "Device tree blobs copied to $ROOTFS_DIR/boot/dtbs/"
    fi
fi


# ============================================================================
# SECTION 7: ENABLE SYSTEMD SERVICES
# ============================================================================
# Enable systemd services
# ============================================================================

# Enable systemd services
progress "Enabling systemd services..."
run_in_chroot "systemctl enable seatd.service || true"
run_in_chroot "systemctl enable dbus.service || true"
run_in_chroot "systemctl enable strux.service || true"
run_in_chroot "systemctl enable strux-network.service || true"


# Enable Plymouth services for boot splash
run_in_chroot "systemctl enable plymouth-start.service || true"
run_in_chroot "systemctl enable plymouth-read-write.service || true"

# Mask the default Plymouth quit services - we control quit from strux.sh
# This prevents Plymouth from quitting before Cage is ready
run_in_chroot "systemctl mask plymouth-quit.service || true"
run_in_chroot "systemctl mask plymouth-quit-wait.service || true"

# Disable unnecessary services to speed up boot
run_in_chroot "systemctl mask systemd-timesyncd.service || true"
run_in_chroot "systemctl mask apt-daily.timer || true"
run_in_chroot "systemctl mask apt-daily-upgrade.timer || true"

# Enable systemd-networkd for automatic network configuration
run_in_chroot "systemctl enable systemd-networkd.service || true"

# Enable systemd-networkd-wait-online to make network-online.target work
# This ensures services depending on network-online.target wait for DHCP
run_in_chroot "systemctl enable systemd-networkd-wait-online.service || true"

# Enable systemd-resolved for DNS resolution
run_in_chroot "systemctl enable systemd-resolved.service || true"

# Configure resolv.conf to use systemd-resolved stub resolver
run_in_chroot "ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf"

# Ensure nsswitch.conf uses resolve for DNS (required for systemd-resolved)
if grep -q "^hosts:" /tmp/rootfs/etc/nsswitch.conf; then
    sed -i 's/^hosts:.*/hosts:          files resolve dns/' /tmp/rootfs/etc/nsswitch.conf
fi

# Disable getty services to prevent login prompt flash during boot
run_in_chroot "systemctl mask getty@tty1.service || true"
run_in_chroot "systemctl mask getty@tty2.service || true"
run_in_chroot "systemctl mask getty@tty3.service || true"
run_in_chroot "systemctl mask getty@tty4.service || true"
run_in_chroot "systemctl mask getty@tty5.service || true"
run_in_chroot "systemctl mask getty@tty6.service || true"
run_in_chroot "systemctl mask serial-getty@ttyS0.service || true"
run_in_chroot "systemctl mask serial-getty@ttyAMA0.service || true"
run_in_chroot "systemctl mask console-getty.service || true"
run_in_chroot "systemctl mask getty.target || true"


# ============================================================================
# SECTION 8: SET HOSTNAME
# ============================================================================
# Set the hostname from YAML configuration
# Priority: strux.yaml hostname > bsp.yaml hostname
# ============================================================================

progress "Configuring hostname..."

# Read hostname from strux.yaml first, then fall back to bsp.yaml
HOSTNAME=$(yq '.hostname' "$PROJECT_DIR/strux.yaml" 2>/dev/null || echo "")

# If not found in strux.yaml, try bsp.yaml
if [ -z "$HOSTNAME" ] || [ "$HOSTNAME" = "null" ]; then
    HOSTNAME=$(yq '.bsp.hostname' "$BSP_CONFIG" 2>/dev/null || echo "")
fi

# If still not found, use a default
if [ -z "$HOSTNAME" ] || [ "$HOSTNAME" = "null" ]; then
    HOSTNAME="strux"
    echo "Warning: No hostname found in YAML files, using default: $HOSTNAME"
fi

# Configure hostname
echo "$HOSTNAME" > "$ROOTFS_DIR/etc/hostname"

# Configure hosts file
cat > "$ROOTFS_DIR/etc/hosts" << EOF
127.0.0.1   localhost $HOSTNAME
::1         localhost $HOSTNAME
EOF

echo "Hostname configured as: $HOSTNAME"

# ============================================================================

# ============================================================================
# SECTION 9: CREATE PLYMOUTH THEME AND BOOT SPLASH, REGENERATE INITRAMFS
# ============================================================================
# Create the Plymouth theme and boot splash
# ============================================================================

progress "Creating plymouth theme and boot splash..."

mkdir -p "$ROOTFS_DIR/usr/share/plymouth/themes/strux"

cp "$PROJECT_DIST_DIR/artifacts/plymouth/strux.plymouth" "$ROOTFS_DIR/usr/share/plymouth/themes/strux/strux.plymouth"
cp "$PROJECT_DIST_DIR/artifacts/plymouth/strux.script" "$ROOTFS_DIR/usr/share/plymouth/themes/strux/strux.script"

# Set Strux as the default Plymouth theme
run_in_chroot "plymouth-set-default-theme strux || true"

mkdir -p "$ROOTFS_DIR/etc/plymouth"

cp "$PROJECT_DIST_DIR/artifacts/plymouth/plymouthd.conf" "$ROOTFS_DIR/etc/plymouth/plymouthd.conf"

# Ensure initramfs includes Plymouth
mkdir -p "$ROOTFS_DIR/etc/initramfs-tools/conf.d"
echo "FRAMEBUFFER=y" > "$ROOTFS_DIR/etc/initramfs-tools/conf.d/plymouth"

cp "$PROJECT_DIST_DIR/artifacts/logo.png" "$ROOTFS_DIR/strux/logo.png"
cp "$PROJECT_DIST_DIR/artifacts/logo.png" "$ROOTFS_DIR/usr/share/plymouth/themes/strux/logo.png"

progress "Generating initramfs with Plymouth..."

# Find the kernel version
KERNEL_VERSION=$(ls /tmp/rootfs/lib/modules 2>/dev/null | head -n 1)

if [ -n "$KERNEL_VERSION" ]; then
    if [ "${STRUX_CUSTOM_KERNEL:-false}" = "true" ]; then
        # Custom kernel: create initramfs from scratch (no initrd exists yet)
        run_in_chroot "update-initramfs -c -k $KERNEL_VERSION" || {
            echo "Warning: Failed to generate initramfs, trying alternative method..."
            run_in_chroot "mkinitramfs -o /boot/initrd.img-$KERNEL_VERSION $KERNEL_VERSION" || true
        }
    else
        # Default Debian kernel: update existing initramfs (apt already created one)
        run_in_chroot "update-initramfs -u -k $KERNEL_VERSION" || echo "Warning: initramfs update failed"
    fi

    # Copy initramfs to BSP-specific cache and create symlink in rootfs
    INITRD=$(ls /tmp/rootfs/boot/initrd.img-* 2>/dev/null | head -n 1)
    if [ -n "$INITRD" ]; then
        cp "$INITRD" "$BSP_CACHE/initrd.img"
        echo "Initramfs copied to $BSP_CACHE/initrd.img"

        # Create symlink so /boot/initrd.img exists (needed by bootloaders like U-Boot/extlinux)
        INITRD_BASENAME=$(basename "$INITRD")
        ln -sf "$INITRD_BASENAME" "$ROOTFS_DIR/boot/initrd.img"
        echo "Initramfs symlink created: /boot/initrd.img -> $INITRD_BASENAME"
    fi
else
    echo "Warning: No kernel modules found, skipping initramfs generation"
fi

# ============================================================================
# SECTION 10: CLEANUP AND MOUNT POINT UNMOUNTING
# ============================================================================
# Cleanup and unmount point unmounting
# ============================================================================

# Unmount filesystems (mounted earlier for systemd operations)
umount /tmp/rootfs/sys 2>/dev/null || true
umount /tmp/rootfs/proc 2>/dev/null || true
umount /tmp/rootfs/dev/pts 2>/dev/null || true
umount /tmp/rootfs/dev 2>/dev/null || true

# Remove QEMU static binaries (not needed in final image)
rm -f /tmp/rootfs/usr/bin/qemu-aarch64-static
rm -f /tmp/rootfs/usr/bin/qemu-arm-static

# Calculate required size for ext4 image (add 20% headroom)
echo "Calculating rootfs size..."
ROOTFS_SIZE=$(du -sm /tmp/rootfs | cut -f1)
IMAGE_SIZE=$((ROOTFS_SIZE + ROOTFS_SIZE / 5 + 50))  # Add 20% + 50MB buffer
echo "Rootfs is ${ROOTFS_SIZE}MB, creating ${IMAGE_SIZE}MB ext4 image..."

# Create a tarball of the rootfs like we did for the base rootfs
progress "Creating post-processed rootfs tarball..."
mkdir -p "$BSP_CACHE"
cd /tmp/rootfs
tar -czf "$BSP_CACHE/rootfs-post.tar.gz" .
echo "Rootfs tarball created successfully."
echo "  Size: $(du -h "$BSP_CACHE/rootfs-post.tar.gz" | cut -f1)"
