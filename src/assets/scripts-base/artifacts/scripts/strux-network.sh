#!/bin/sh
# Strux Network Setup Script
# Called by systemd strux-network.service
# Note: Ethernet interfaces are configured automatically by systemd-networkd

echo "Configuring Loopback..."

# Bring up loopback interface
ip link set lo up 2>/dev/null || true

# Add IPv4 address if not already configured
if ! ip addr show lo | grep -q "inet 127.0.0.1"; then
    ip addr add 127.0.0.1/8 dev lo
fi

# Add IPv6 address if not already configured
if ! ip addr show lo | grep -q "inet6 ::1"; then
    ip -6 addr add ::1/128 dev lo 2>/dev/null || true
fi

echo "Loopback Up."
echo "Ethernet interfaces are managed by systemd-networkd (DHCP)."