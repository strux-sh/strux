/***
 *
 *
 *  Strux Startup Script
 *
 */

export const STRUX_SCRIPT = function() {

    return `#!/bin/sh

# Verbose logging - output to both stdout and console
log() {
    echo "[STRUX] $1"
    echo "[STRUX] $1" > /dev/console 2>/dev/null || true
}

log "========================================="
log "Starting Strux Service..."
log "========================================="

# Setup runtime directory
log "Setting up runtime directory..."
mkdir -p /tmp/run
chmod 0700 /tmp/run
export XDG_RUNTIME_DIR=/tmp/run
log "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"

# Ensure no display variable is set
unset DISPLAY

# Load GPU/framebuffer modules
log "Loading GPU modules..."
udevadm settle
modprobe -a drm virtio-gpu 2>/dev/null || true
sleep 1

# Wait for framebuffer device (needed for splash)
log "Waiting for framebuffer device..."
COUNTER=0
while [ ! -e /dev/fb0 ] && [ $COUNTER -lt 10 ]; do
    log "  Attempt $COUNTER: /dev/fb0 not found yet..."
    sleep 0.5
    COUNTER=$((COUNTER + 1))
done

if [ -e /dev/fb0 ]; then
    log "Framebuffer ready: /dev/fb0"
else
    log "WARNING: Framebuffer not available after timeout"
fi

# Wait for seatd to be fully ready
log "Waiting for seatd socket..."
sleep 1
COUNTER=0
while [ ! -S /run/seatd.sock ] && [ $COUNTER -lt 30 ]; do
    log "  Attempt $COUNTER: /run/seatd.sock not found yet..."
    sleep 1
    COUNTER=$((COUNTER + 1))
done

if [ -S /run/seatd.sock ]; then
    log "Seatd ready: /run/seatd.sock"
else
    log "ERROR: Seatd socket not available after 30 seconds"
    exit 1
fi

# Check and configure loopback
log "Checking loopback interface..."
ip addr show lo > /dev/console 2>&1 || true
if ! ip addr show lo | grep -q "inet 127.0.0.1"; then
    log "Loopback not configured, fixing..."
    ip link set lo up
    ip addr add 127.0.0.1/8 dev lo
    log "Loopback configured"
else
    log "Loopback already configured"
fi

# Environment setup (some set by systemd, but ensure they're set)
log "Setting environment variables..."
export WPE_WEB_EXTENSION_PATH=/usr/lib/wpe-web-extensions
export SEATD_SOCK=/run/seatd.sock
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export WEBKIT_FORCE_SANDBOX=0

# EGL/Mesa environment - let Mesa auto-detect the driver
# GALLIUM_DRIVER will be auto-detected (virgl for virtio-gpu-gl, llvmpipe for software)

# Find GPU device - support Intel, AMD, virtio, and others
# Priority: Intel (i915) > AMD (amdgpu) > virtio > first available
log "Detecting GPU..."
GPU_FOUND=""
for card in /dev/dri/card*; do
    driver=$(basename $(readlink -f /sys/class/drm/$(basename $card)/device/driver) 2>/dev/null)
    log "  Found card: $card (driver: $driver)"
    case "$driver" in
        i915)
            # Intel GPU - highest priority
            export WLR_DRM_DEVICES="$card"
            log "Using Intel GPU: $card ($driver)"
            GPU_FOUND="intel"
            break
            ;;
        amdgpu|radeon)
            # AMD GPU
            export WLR_DRM_DEVICES="$card"
            log "Using AMD GPU: $card ($driver)"
            GPU_FOUND="amd"
            break
            ;;
        virtio-pci|virtio_gpu)
            # Virtio GPU (QEMU)
            export WLR_DRM_DEVICES="$card"
            log "Using Virtio GPU: $card ($driver)"
            GPU_FOUND="virtio"
            break
            ;;
    esac
done

# Fallback to first available card if no known driver found
if [ -z "$GPU_FOUND" ] && [ -e /dev/dri/card0 ]; then
    export WLR_DRM_DEVICES="/dev/dri/card0"
    log "Using fallback GPU: /dev/dri/card0"
fi

# Force output resolution (set from strux.yaml display.resolution)
# WLR_OUTPUT_MODE tells wlroots which mode to pick
export WLR_OUTPUT_MODE="__DISPLAY_RESOLUTION__"
log "Display resolution: $WLR_OUTPUT_MODE"

# Also try drm modeset hint
export WLR_DRM_NO_MODIFIERS=1

# Disable GLib/GTK assertion handlers that can cause SIGTRAP
export G_DEBUG=
export G_SLICE=always-malloc

# Check if backend binary exists
log "Checking backend binary..."
if [ -x /usr/bin/strux-app ]; then
    log "Backend binary found: /usr/bin/strux-app"
    ls -la /usr/bin/strux-app > /dev/console 2>&1 || true
else
    log "ERROR: Backend binary not found or not executable!"
    ls -la /usr/bin/strux-app > /dev/console 2>&1 || true
fi

# Start the backend app in the background BEFORE Cage
log "Starting backend app..."
strux-app > /dev/console 2>&1 &
BACKEND_PID=$!
log "Backend started with PID: $BACKEND_PID"

# Give backend a moment to start, then check if it's running
sleep 1
if kill -0 $BACKEND_PID 2>/dev/null; then
    log "Backend process is still running (PID: $BACKEND_PID)"
else
    log "WARNING: Backend process may have exited! (PID: $BACKEND_PID)"
    # Try to see what happened
    wait $BACKEND_PID 2>/dev/null
    log "Backend exit code: $?"
fi

# Check splash image
if [ -f /usr/share/strux/logo.png ]; then
    log "Splash image found: /usr/share/strux/logo.png"
    SPLASH_ARG="--splash-image=/usr/share/strux/logo.png"
else
    log "WARNING: Splash image not found, starting without splash"
    SPLASH_ARG=""
fi

# Quit Plymouth to hand off to Cage's splash
# This ensures a seamless transition - same logo, same position
if command -v plymouth >/dev/null 2>&1; then
    log "Handing off from Plymouth to Cage..."
    plymouth quit --retain-splash 2>/dev/null || true
fi

# Start Cage immediately with splash - don't wait for backend
# Cage runs a wrapper that waits for backend before launching Cog
log "Starting Cage (backend loading in background)..."
log "Running: cage $SPLASH_ARG -- sh -c '...'"
cage $SPLASH_ARG -- sh -c '
    echo "[CAGE] Starting cage wrapper script..." > /dev/console

    # Set output resolution using wlr-randr
    echo "[CAGE] Setting display resolution..." > /dev/console
    wlr-randr --output Virtual-1 --mode __DISPLAY_RESOLUTION__ 2>/dev/null || true

    # Wait for backend to be ready
    echo "[CAGE] Waiting for backend on port 8080..." > /dev/console
    COUNTER=0
    while ! nc -z 127.0.0.1 8080 && [ $COUNTER -lt 60 ]; do
        if [ $((COUNTER % 10)) -eq 0 ]; then
            echo "[CAGE] Still waiting for backend... ($COUNTER/60)" > /dev/console
        fi
        sleep 0.5
        COUNTER=$((COUNTER + 1))
    done

    if [ $COUNTER -ge 60 ]; then
        echo "[CAGE] ERROR: Backend did not start in time (30 seconds)" > /dev/console
        echo "[CAGE] Checking if backend process exists..." > /dev/console
        ps aux > /dev/console 2>&1 || true
        echo "[CAGE] Checking port 8080..." > /dev/console
        netstat -tlnp 2>/dev/null > /dev/console || ss -tlnp > /dev/console 2>&1 || true
        exit 1
    fi

    echo "[CAGE] Backend is ready! Starting Cog..." > /dev/console

    # Launch Cog with extension support
    # --bg-color prevents white flash before page renders
    cog http://localhost:8080 --web-extensions-dir=/usr/lib/wpe-web-extensions 2>/dev/console
'

CAGE_EXIT=$?
log "Cage exited with status $CAGE_EXIT"
log "Sleeping 10 seconds before exit..."
sleep 10
`


}
