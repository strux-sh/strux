#!/bin/sh

# Strux OS init script - prepares environment and hands off to systemd

# Mount essential filesystems (systemd expects these)
/bin/mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
/bin/mount -t proc proc /proc 2>/dev/null || true
/bin/mount -t sysfs sysfs /sys 2>/dev/null || true

# Create /run directory (needed by systemd)
/bin/mkdir -p /run

# Create /strux directory for virtfs mount (systemd will mount it later in dev mode)
/bin/mkdir -p /strux

# Hand off to systemd
exec /sbin/init
