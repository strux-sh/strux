#!/bin/bash


#
#
# By convention, bundled images are created in the dist/bsp/output directory, so you should try and replicate that pattern.
#
# The project folder is mounted at /project in the container that this script is running in,
# but you should use the PROJECT_FOLDER variable to access it.
#


set -eo pipefail

# Trap errors and print the failing command/line
trap 'echo "Error: Command failed at line $LINENO with exit code $?: $BASH_COMMAND" >&2' ERR

# Define a Function to Print Progress Messages that will be used by the Strux CLI
# By convention, the progress messages should be prefixed with "STRUX_PROGRESS: "
progress() {
    echo "STRUX_PROGRESS: $1"
}

progress "Creating Strux OS Image for QEMU..."


#
# THe following variables are set by the Strux CLI
# - PROJECT_FOLDER
# - PROJECT_DIST_FOLDER
# - PROJECT_DIST_CACHE_FOLDER
# - PROJECT_DIST_OUTPUT_FOLDER
# - PROJECT_DIST_ARTIFACTS_FOLDER
# - HOST_ARCH (arm64, x86_64, armhf)
# - TARGET_ARCH (arm64, x86_64, armhf)
# - STEP
# - STRUX_VERSION
# - BSP_NAME



ROOTFS_DIR="/tmp/rootfs"

mkdir -p "$PROJECT_DIST_CACHE_FOLDER"
mkdir -p "$ROOTFS_DIR"

if [ ! -f "$PROJECT_DIST_CACHE_FOLDER/rootfs-post.tar.gz" ]; then
    echo "Please run 'strux build' first to generate the root filesystem." >&2
    exit 1
fi

progress "Extracting root filesystem tarball..."

# Extract the root filesystem tarball into the temporary directory
tar -xzf "$PROJECT_DIST_CACHE_FOLDER/rootfs-post.tar.gz" -C "$ROOTFS_DIR"

echo "Calculating rootfs size..."
ROOTFS_SIZE=$(du -sm /tmp/rootfs | cut -f1)
IMAGE_SIZE=$((ROOTFS_SIZE + ROOTFS_SIZE / 5 + 50))  # Add 20% + 50MB buffer
echo "Rootfs is ${ROOTFS_SIZE}MB, creating ${IMAGE_SIZE}MB ext4 image..."

# Create ext4 disk image (use dev prefix in dev mode)
ROOTFS_OUTPUT="$PROJECT_DIST_OUTPUT_FOLDER/rootfs.ext4"

# Copy initrd and kernel to output folder 
cp "$PROJECT_DIST_CACHE_FOLDER/initrd.img" "$PROJECT_DIST_OUTPUT_FOLDER/initrd.img"
cp "$PROJECT_DIST_CACHE_FOLDER/vmlinuz" "$PROJECT_DIST_OUTPUT_FOLDER/vmlinuz"


progress "Creating ext4 image..."

dd if=/dev/zero of="$ROOTFS_OUTPUT" bs=1M count=${IMAGE_SIZE}
mkfs.ext4 -F "$ROOTFS_OUTPUT"

# Mount and copy rootfs contents
mkdir -p /tmp/ext4mount
mount -o loop "$ROOTFS_OUTPUT" /tmp/ext4mount
cp -a /tmp/rootfs/* /tmp/ext4mount/
umount /tmp/ext4mount

echo "Rootfs ext4 image ready: $ROOTFS_OUTPUT"

