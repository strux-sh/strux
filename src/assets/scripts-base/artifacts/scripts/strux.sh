#!/bin/sh

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

# Read display resolution from /strux/.display-resolution file
DISPLAY_RESOLUTION=""
if [ -f /strux/.display-resolution ]; then
    DISPLAY_RESOLUTION=$(cat /strux/.display-resolution | tr -d '\n\r ' || echo "")
fi

# Fallback to default if file doesn't exist or is empty
if [ -z "$DISPLAY_RESOLUTION" ]; then
    DISPLAY_RESOLUTION="1920x1080"
    log "WARNING: Display resolution file not found or empty, using default: $DISPLAY_RESOLUTION"
else
    log "Display resolution read from file: $DISPLAY_RESOLUTION"
fi

# Force output resolution
# WLR_OUTPUT_MODE tells wlroots which mode to pick
export WLR_OUTPUT_MODE="$DISPLAY_RESOLUTION"
log "Display resolution: $WLR_OUTPUT_MODE"

# Also try drm modeset hint
export WLR_DRM_NO_MODIFIERS=1

# Disable GLib/GTK assertion handlers that can cause SIGTRAP
export G_DEBUG=
export G_SLICE=always-malloc

# Create symlink for frontend directory
# The backend (runtime) looks for ./frontend from / which means /frontend
# But the frontend files are at /strux/frontend, so we symlink
if [ -d /strux/frontend ] && [ ! -e /frontend ]; then
    log "Creating /frontend symlink for backend..."
    ln -sf /strux/frontend /frontend
fi

# Use /strux/main for the backend binary
APP_BINARY="/strux/main"

# Check if binary exists
if [ ! -x "$APP_BINARY" ]; then
    log "ERROR: Binary not found at $APP_BINARY!"
    log "Checking /strux directory..."
    ls -la /strux > /dev/console 2>&1 || true
    exit 1
fi

# Start the backend app in the background
# Backend still runs on localhost:8080 for IPC/API calls
# Backend serves from ./frontend relative to its working directory
# Change to / so ./frontend resolves to /frontend
log "Starting backend app..."
cd / && $APP_BINARY > /tmp/strux-backend.log 2>&1 &
BACKEND_PID=$!
log "Backend started with PID: $BACKEND_PID"

# Tail the backend log to serial console in background for debugging
# This lets us see backend output in QEMU's terminal
(
    sleep 2  # Give backend a moment to start logging
    SERIAL_DEV=""
    if [ -e /dev/ttyS0 ]; then
        SERIAL_DEV="/dev/ttyS0"
    elif [ -e /dev/ttyAMA0 ]; then
        SERIAL_DEV="/dev/ttyAMA0"
    fi
    if [ -n "$SERIAL_DEV" ] && [ -f /tmp/strux-backend.log ]; then
        tail -f /tmp/strux-backend.log | sed 's/^/[BACKEND] /' > "$SERIAL_DEV" 2>/dev/null &
    fi
) &

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

# Quit Plymouth to hand off to Cage's splash
# This ensures a seamless transition - same logo, same position
if command -v plymouth >/dev/null 2>&1; then
    log "Handing off from Plymouth..."
    plymouth quit --retain-splash 2>/dev/null || true
fi

# Launch the client which will handle Cage and Cog launching
# The client will check for /strux/.dev-env.json to determine mode
CLIENT_BINARY="/strux/client"

if [ ! -x "$CLIENT_BINARY" ]; then
    log "ERROR: Client binary not found at $CLIENT_BINARY!"
    exit 1
fi

log "Starting client (will launch Cage and Cog)..."
log "Client will determine mode based on /strux/.dev-env.json"

# Launch client - it will handle everything from here
exec "$CLIENT_BINARY"