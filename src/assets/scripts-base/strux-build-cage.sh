#!/bin/bash

set -eo pipefail

# Trap errors and print the failing command/line
trap 'echo "Error: Command failed at line $LINENO with exit code $?: $BASH_COMMAND" >&2' ERR
# Define A Function to Print Progress Messages that will be used by the Strux CLI
progress() {
    echo "STRUX_PROGRESS: $1"
}

PROJECT_DIR="${PROJECT_DIR:-/project}"
# Cage source is bundled with the CLI and copied to dist/artifacts/cage
CAGE_SOURCE_DIR="$PROJECT_DIR/dist/artifacts/cage"
# Use BSP_CACHE_DIR if provided, otherwise fallback to default
CACHE_DIR="${BSP_CACHE_DIR:-$PROJECT_DIR/dist/cache}"
CAGE_BINARY="$CACHE_DIR/cage"

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

if [ "$ARCH" = "host" ]; then
    ARCH="${TARGET_ARCH:-$(dpkg --print-architecture 2>/dev/null || echo "")}"
    if [ -z "$ARCH" ] || [ "$ARCH" = "host" ]; then
        echo "Error: Could not resolve host architecture"
        exit 1
    fi
    progress "Resolved host architecture to $ARCH"
fi

# ============================================================================
# ARCHITECTURE MAPPING FOR MESON CROSS-COMPILATION
# ============================================================================
# Map Strux architecture to cross-compiler toolchain
# ============================================================================

# Map architecture to cross-compiler
if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "x86_64" ]; then
    TARGET_ARCH="x86_64"
    MESON_CPU_FAMILY="x86_64"
    ARCH_LABEL="x86_64"
    CROSS_CC="x86_64-linux-gnu-gcc"
    CROSS_CXX="x86_64-linux-gnu-g++"
    CROSS_STRIP="x86_64-linux-gnu-strip"
    CROSS_PKG_CONFIG="x86_64-linux-gnu-pkg-config"
elif [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
    TARGET_ARCH="aarch64"
    MESON_CPU_FAMILY="aarch64"
    ARCH_LABEL="ARM64"
    CROSS_CC="aarch64-linux-gnu-gcc"
    CROSS_CXX="aarch64-linux-gnu-g++"
    CROSS_STRIP="aarch64-linux-gnu-strip"
    CROSS_PKG_CONFIG="aarch64-linux-gnu-pkg-config"
elif [ "$ARCH" = "armhf" ] || [ "$ARCH" = "armv7" ] || [ "$ARCH" = "arm" ]; then
    TARGET_ARCH="arm"
    MESON_CPU_FAMILY="arm"
    ARCH_LABEL="ARMv7/ARMHF"
    CROSS_CC="arm-linux-gnueabihf-gcc"
    CROSS_CXX="arm-linux-gnueabihf-g++"
    CROSS_STRIP="arm-linux-gnueabihf-strip"
    CROSS_PKG_CONFIG="arm-linux-gnueabihf-pkg-config"
else
    echo "Error: Unsupported architecture: $ARCH"
    exit 1
fi

# Check if we're building for native or cross architecture
HOST_ARCH=$(dpkg --print-architecture 2>/dev/null || echo "unknown")

# Map host architecture for comparison
case "$HOST_ARCH" in
    amd64)
        HOST_ARCH_NORMALIZED="x86_64"
        ;;
    arm64)
        HOST_ARCH_NORMALIZED="arm64"
        ;;
    armhf)
        HOST_ARCH_NORMALIZED="armhf"
        ;;
    *)
        HOST_ARCH_NORMALIZED="$HOST_ARCH"
        ;;
esac

# Normalize target arch for comparison
if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "x86_64" ]; then
    TARGET_ARCH_NORMALIZED="x86_64"
elif [ "$ARCH" = "armhf" ] || [ "$ARCH" = "armv7" ] || [ "$ARCH" = "arm" ]; then
    TARGET_ARCH_NORMALIZED="armhf"
else
    TARGET_ARCH_NORMALIZED="arm64"
fi

# Determine if cross-compilation is needed
NEED_CROSS_COMPILE=false
if [ "$HOST_ARCH_NORMALIZED" != "$TARGET_ARCH_NORMALIZED" ]; then
    NEED_CROSS_COMPILE=true
fi

# ============================================================================
# VERIFY CAGE SOURCE EXISTS
# ============================================================================
# Cage source is bundled with the CLI and should have been copied to
# dist/artifacts/cage before this script runs
# ============================================================================

if [ ! -d "$CAGE_SOURCE_DIR" ]; then
    echo "Error: Cage source not found at $CAGE_SOURCE_DIR"
    echo "The Cage source should be bundled with the Strux CLI and copied before building."
    exit 1
fi

progress "Cage source found at $CAGE_SOURCE_DIR"

# ============================================================================
# BUILD CAGE COMPOSITOR
# ============================================================================
# Configure and compile Cage using meson with cross-compilation if needed
# ============================================================================

cd "$CAGE_SOURCE_DIR"

# Create meson cross-file if cross-compilation is needed
MESON_CROSS_FILE=""
if [ "$NEED_CROSS_COMPILE" = true ]; then
    progress "Preparing meson cross-compilation for $ARCH_LABEL..."
    
    # Create a temporary cross-file
    MESON_CROSS_FILE="/tmp/meson-cross-${TARGET_ARCH}.ini"
    
    # Determine PKG_CONFIG_PATH and PKG_CONFIG_LIBDIR for cross-architecture libraries
    # Multiarch libraries are typically in /usr/lib/<triplet>
    # We also need /usr/share/pkgconfig for arch-independent packages (xproto, etc.)
    if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "x86_64" ]; then
        ARCH_PKG_CONFIG_DIR="/usr/lib/x86_64-linux-gnu/pkgconfig"
    elif [ "$ARCH" = "armhf" ] || [ "$ARCH" = "armv7" ] || [ "$ARCH" = "arm" ]; then
        ARCH_PKG_CONFIG_DIR="/usr/lib/arm-linux-gnueabihf/pkgconfig"
    else
        ARCH_PKG_CONFIG_DIR="/usr/lib/aarch64-linux-gnu/pkgconfig"
    fi
    
    # PKG_CONFIG_PATH includes both arch-specific and arch-independent directories
    # /usr/share/pkgconfig contains arch-independent .pc files (xproto, xau, xdmcp, etc.)
    PKG_CONFIG_PATH="${ARCH_PKG_CONFIG_DIR}:/usr/share/pkgconfig"
    # PKG_CONFIG_LIBDIR should only contain the target architecture libraries
    PKG_CONFIG_LIBDIR="${ARCH_PKG_CONFIG_DIR}:/usr/share/pkgconfig"
    
    # Verify the pkg-config directories exist
    if [ ! -d "$ARCH_PKG_CONFIG_DIR" ]; then
        echo "Error: Architecture-specific pkgconfig dir does not exist: $ARCH_PKG_CONFIG_DIR"
        echo "Cross-architecture libraries may not be installed correctly."
        exit 1
    fi
    
    if [ ! -d "/usr/share/pkgconfig" ]; then
        echo "Warning: /usr/share/pkgconfig does not exist"
        echo "Architecture-independent packages (xproto, etc.) may not be found."
    fi
    
    # Check if wlroots .pc file exists
    if [ ! -f "$ARCH_PKG_CONFIG_DIR/wlroots-0.18.pc" ]; then
        echo "Warning: wlroots-0.18.pc not found in $ARCH_PKG_CONFIG_DIR"
        echo "Available .pc files:"
        ls -la "$ARCH_PKG_CONFIG_DIR"/*.pc 2>/dev/null | head -10 || echo "No .pc files found"
        echo ""
        echo "This may indicate that libwlroots-0.18-dev:${ARCH} is not installed."
        echo "Please verify the Dockerfile includes this package for ${ARCH_LABEL}."
    fi
    
    # Check if xproto.pc exists (common dependency issue)
    if [ ! -f "/usr/share/pkgconfig/xproto.pc" ]; then
        echo "Warning: xproto.pc not found in /usr/share/pkgconfig"
        echo "This package is required by X11 libraries. Install x11proto-dev."
    fi
    
    # Create a pkg-config wrapper script that hardcodes the correct paths
    # This is necessary because meson doesn't properly pass PKG_CONFIG_LIBDIR 
    # to pkg-config during cross-compilation
    PKG_CONFIG_WRAPPER="/tmp/pkg-config-cross-${TARGET_ARCH}.sh"
    cat > "$PKG_CONFIG_WRAPPER" <<'WRAPPER_START'
#!/bin/bash
# Wrapper script for cross-compilation pkg-config
# Forces pkg-config to look in the correct cross-architecture directories
WRAPPER_START
    cat >> "$PKG_CONFIG_WRAPPER" <<WRAPPER_VARS
export PKG_CONFIG_PATH="${PKG_CONFIG_PATH}"
export PKG_CONFIG_LIBDIR="${PKG_CONFIG_LIBDIR}"
# Critical: Clear sysroot so pkg-config doesn't prefix paths
export PKG_CONFIG_SYSROOT_DIR=""
# Allow system flags for cross-compilation
export PKG_CONFIG_ALLOW_SYSTEM_CFLAGS=1
export PKG_CONFIG_ALLOW_SYSTEM_LIBS=1
WRAPPER_VARS
    cat >> "$PKG_CONFIG_WRAPPER" <<'WRAPPER_END'

# Debug: Log invocations to help troubleshoot
echo "[pkg-config-wrapper] args: $@" >> /tmp/pkg-config-debug.log
echo "[pkg-config-wrapper] PKG_CONFIG_LIBDIR=$PKG_CONFIG_LIBDIR" >> /tmp/pkg-config-debug.log

# Execute pkg-config
result=$(/usr/bin/pkg-config "$@" 2>&1)
exitcode=$?

echo "[pkg-config-wrapper] exit=$exitcode result=$result" >> /tmp/pkg-config-debug.log
echo "" >> /tmp/pkg-config-debug.log

if [ $exitcode -eq 0 ]; then
    echo "$result"
fi
exit $exitcode
WRAPPER_END
    chmod +x "$PKG_CONFIG_WRAPPER"
    
    progress "Created pkg-config wrapper: $PKG_CONFIG_WRAPPER"
    
    # Debug: Show wrapper contents and test it
    progress "Wrapper script contents:"
    cat "$PKG_CONFIG_WRAPPER"
    echo ""
    
    # Test the wrapper directly
    progress "Testing wrapper with 'pkg-config --exists wlroots-0.18'..."
    if "$PKG_CONFIG_WRAPPER" --exists wlroots-0.18; then
        progress "Wrapper test PASSED: wlroots-0.18 found"
        progress "wlroots-0.18 version: $("$PKG_CONFIG_WRAPPER" --modversion wlroots-0.18)"
        # Also test --cflags to catch dependency issues early
        progress "Testing wrapper with 'pkg-config --cflags wlroots-0.18'..."
        if "$PKG_CONFIG_WRAPPER" --cflags wlroots-0.18 >/dev/null 2>&1; then
            progress "Wrapper cflags test PASSED"
        else
            echo "WARNING: pkg-config --cflags failed. Checking dependencies..."
            "$PKG_CONFIG_WRAPPER" --cflags wlroots-0.18 2>&1 || true
        fi
    else
        echo "ERROR: Wrapper test FAILED: wlroots-0.18 not found"
        echo "Debug log:"
        cat /tmp/pkg-config-debug.log 2>/dev/null || echo "No debug log"
        echo ""
        echo "Checking .pc file directly:"
        cat "${ARCH_PKG_CONFIG_DIR}/wlroots-0.18.pc" 2>/dev/null || echo "Cannot read .pc file"
    fi
    
    cat > "$MESON_CROSS_FILE" <<EOF
[binaries]
c = '${CROSS_CC}'
cpp = '${CROSS_CXX}'
strip = '${CROSS_STRIP}'
pkg-config = '${PKG_CONFIG_WRAPPER}'

[host_machine]
system = 'linux'
cpu_family = '${MESON_CPU_FAMILY}'
cpu = '${TARGET_ARCH}'
endian = 'little'

[properties]
needs_exe_wrapper = true
EOF
    
    progress "Cross-compilation file created: $MESON_CROSS_FILE"
else
    progress "Building for native architecture ($ARCH_LABEL)..."
fi

progress "Configuring Cage with meson for $ARCH_LABEL..."

# Fix clock skew issues that can happen when Docker container clock drifts from host
# Touch source files to ensure consistent timestamps before meson runs
progress "Syncing file timestamps to prevent clock skew..."
find . -type f -exec touch {} + 2>/dev/null || true

# If build directory exists from a previous run, clean it to avoid stale timestamp issues
if [ -d "build" ]; then
    progress "Cleaning existing build directory..."
    rm -rf build
fi

# Configure with meson (with cross-file if needed)
if [ "$NEED_CROSS_COMPILE" = true ]; then
    meson setup build --buildtype=release --cross-file="$MESON_CROSS_FILE" || {
        echo "Error: Failed to configure Cage with meson cross-compilation"
        echo ""
        echo "=== Debug Info ==="
        echo "PKG_CONFIG_WRAPPER: $PKG_CONFIG_WRAPPER"
        echo ""
        echo "Cross-file contents:"
        cat "$MESON_CROSS_FILE"
        echo ""
        echo "pkg-config debug log:"
        cat /tmp/pkg-config-debug.log 2>/dev/null || echo "No debug log"
        echo ""
        echo "Meson log (last 50 lines):"
        tail -50 "$PROJECT_DIR/dist/artifacts/cage/build/meson-logs/meson-log.txt" 2>/dev/null || echo "No meson log"
        exit 1
    }
else
    meson setup build --buildtype=release || {
        echo "Error: Failed to configure Cage with meson"
        exit 1
    }
fi

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
mkdir -p "$CACHE_DIR"

# Copy the binary
cp build/cage "$CAGE_BINARY" || {
    echo "Error: Failed to copy Cage binary"
    exit 1
}

# Make the binary executable
chmod +x "$CAGE_BINARY"

# ============================================================================
# GENERATE CAGE ENVIRONMENT FILE
# ============================================================================
# Build the .cage-env file from bsp.yaml cage configuration
# ============================================================================

CAGE_ENV_FILE="$CACHE_DIR/.cage-env"

progress "Generating Cage environment file..."

# Start with custom env vars from bsp.yaml
CAGE_ENV_COUNT=$(yq -r '.bsp.cage.env // [] | length' "$BSP_CONFIG" 2>/dev/null || echo "0")
if [ "$CAGE_ENV_COUNT" -gt 0 ]; then
    yq -r '.bsp.cage.env[]' "$BSP_CONFIG" > "$CAGE_ENV_FILE"
else
    > "$CAGE_ENV_FILE"
fi

# Append STRUX_HIDE_CURSOR if hide_cursor is set
HIDE_CURSOR=$(yq -r '.bsp.cage.hide_cursor // false' "$BSP_CONFIG" 2>/dev/null || echo "false")
if [ "$HIDE_CURSOR" = "true" ]; then
    progress "Enabling cursor hiding..."
    echo "STRUX_HIDE_CURSOR=1" >> "$CAGE_ENV_FILE"
fi

progress "Cage environment file written to $CAGE_ENV_FILE"

progress "Cage compiled successfully"
