#!/bin/sh
#
# Strux Cog Launcher
#
# Called by Cage to launch a Cog browser instance for a specific output.
# This script is user-modifiable — customize Cog flags, add pre-launch
# setup, or replace Cog with another browser.
#
# Arguments:
#   $1 - Output name (e.g., "HDMI-A-1", "DSI-1")
#   $2 - URL to load (e.g., "http://localhost:8080/dashboard")
#
# Environment:
#   All Cage environment variables are inherited (WAYLAND_DISPLAY, etc.)
#

OUTPUT_NAME="$1"
URL="$2"

echo "[strux-run-cog] output=$OUTPUT_NAME url=$URL"

# Assign a unique WebKit Inspector port for this Cog instance (dev mode).
# The Strux client writes the base port to /tmp/strux-inspector-base-port
# and a shared counter to /tmp/strux-inspector-counter.
# Each Cog atomically increments the counter to get a unique offset.
if [ -f /tmp/strux-inspector-base-port ]; then
    BASE_PORT=$(cat /tmp/strux-inspector-base-port)
    # Atomically read-and-increment the counter using flock
    COUNTER_FILE="/tmp/strux-inspector-counter"
    OFFSET=$(flock "$COUNTER_FILE" sh -c '
        val=$(cat "'"$COUNTER_FILE"'" 2>/dev/null || echo 0)
        echo "$val"
        echo $((val + 1)) > "'"$COUNTER_FILE"'"
    ')
    INSPECTOR_PORT=$((BASE_PORT + OFFSET))
    export WEBKIT_INSPECTOR_HTTP_SERVER="0.0.0.0:${INSPECTOR_PORT}"
    echo "[strux-run-cog] WebKit Inspector on port $INSPECTOR_PORT for output $OUTPUT_NAME"
fi

# Launch Cog browser
# --autoplay-policy=allow: permit unmuted media autoplay without user gesture
exec cog \
  --web-extensions-dir=/usr/lib/wpe-web-extensions \
  --platform=wl \
  --enable-developer-extras=1 \
  --autoplay-policy=allow \
  "$URL"
