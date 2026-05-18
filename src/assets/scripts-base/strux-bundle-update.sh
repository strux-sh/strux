#!/bin/bash

set -eo pipefail

trap 'echo "Error: Command failed at line $LINENO with exit code $?: $BASH_COMMAND" >&2' ERR

progress() {
    echo "STRUX_PROGRESS: $1"
}

require_env() {
    local name="$1"
    if [ -z "${!name:-}" ]; then
        echo "Error: $name is required"
        exit 1
    fi
}

require_env UPDATE_BSP
require_env UPDATE_VERSION
require_env UPDATE_STRUX_VERSION
require_env UPDATE_ROOTFS_IMAGE
require_env UPDATE_PRIVATE_KEY
require_env UPDATE_OUTPUT

if [ ! -f "$UPDATE_ROOTFS_IMAGE" ]; then
    echo "Error: rootfs image not found: $UPDATE_ROOTFS_IMAGE"
    exit 1
fi

if [ ! -f "$UPDATE_PRIVATE_KEY" ]; then
    echo "Error: RSA update private key not found: $UPDATE_PRIVATE_KEY"
    exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
    echo "Error: openssl is not available in the builder image"
    exit 1
fi

if ! command -v sha256sum >/dev/null 2>&1; then
    echo "Error: sha256sum is not available in the builder image"
    exit 1
fi

progress "Preparing update bundle workspace..."
TMP_DIR=$(mktemp -d)
cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$(dirname "$UPDATE_OUTPUT")"
cp "$UPDATE_ROOTFS_IMAGE" "$TMP_DIR/rootfs.img"

progress "Hashing and signing full rootfs image..."
json_escape() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

ROOTFS_SIZE=$(stat -c%s "$TMP_DIR/rootfs.img")
ROOTFS_SHA256=$(sha256sum "$TMP_DIR/rootfs.img" | awk '{print $1}')
CREATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
JSON_BSP=$(json_escape "$UPDATE_BSP")
JSON_VERSION=$(json_escape "$UPDATE_VERSION")
JSON_STRUX_VERSION=$(json_escape "$UPDATE_STRUX_VERSION")

cat > "$TMP_DIR/manifest.json" <<EOF
{
  "schema": "dev.strux.update.bundle.v1",
  "bsp": "$JSON_BSP",
  "version": "$JSON_VERSION",
  "projectVersion": "$JSON_VERSION",
  "struxVersion": "$JSON_STRUX_VERSION",
  "createdAt": "$CREATED_AT",
  "payload": {
    "type": "full-rootfs",
    "file": "rootfs.img",
    "size": $ROOTFS_SIZE,
    "sha256": "$ROOTFS_SHA256"
  },
  "signing": {
    "algorithm": "rsa-pss-sha512",
    "keyBits": 4096,
    "saltLength": "hash",
    "signedBytes": "manifest.json"
  }
}
EOF

openssl dgst \
    -sha512 \
    -sign "$UPDATE_PRIVATE_KEY" \
    -sigopt rsa_padding_mode:pss \
    -sigopt rsa_pss_saltlen:-1 \
    -out "$TMP_DIR/manifest.sig.raw" \
    "$TMP_DIR/manifest.json"

base64 -w 0 "$TMP_DIR/manifest.sig.raw" > "$TMP_DIR/manifest.sig"
printf '\n' >> "$TMP_DIR/manifest.sig"

progress "Writing .struxb archive..."
tar -C "$TMP_DIR" -czf "$UPDATE_OUTPUT" manifest.json manifest.sig rootfs.img

progress "Update bundle created: $UPDATE_OUTPUT"
