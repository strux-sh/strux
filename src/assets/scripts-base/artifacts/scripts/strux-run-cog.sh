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

# Launch Cog browser
exec cog \
  --web-extensions-dir=/usr/lib/wpe-web-extensions \
  --platform=wl \
  --enable-developer-extras=1 \
  "$URL"
