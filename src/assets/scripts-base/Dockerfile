# Debian Forky (testing) - has wlroots 0.19
FROM debian:testing-slim

ENV DEBIAN_FRONTEND=noninteractive

# Enable multiarch support for cross-compilation
# Add architectures if they're not already enabled (ignore errors if already added)
RUN (dpkg --add-architecture arm64 || true) && \
    (dpkg --add-architecture amd64 || true) && \
    (dpkg --add-architecture armhf || true)

# Install Go for cross-compiling user applications with CGO support
RUN apt-get update && apt-get install -y golang

RUN apt-get update && apt-get install -y --no-install-recommends \
    # Debootstrap and cross-arch support
    debootstrap \
    qemu-user-static \
    binfmt-support \
    # Cross-compilation toolchains (for building on different host architectures)
    gcc-aarch64-linux-gnu \
    g++-aarch64-linux-gnu \
    binutils-aarch64-linux-gnu \
    gcc-x86-64-linux-gnu \
    g++-x86-64-linux-gnu \
    binutils-x86-64-linux-gnu \
    gcc-arm-linux-gnueabihf \
    g++-arm-linux-gnueabihf \
    binutils-arm-linux-gnueabihf \
    # Build essentials
    build-essential \
    cmake \
    meson \
    ninja-build \
    pkg-config \
    # Kernel build dependencies
    flex \
    bison \
    libssl-dev \
    bc \
    kmod \
    cpio \
    libelf-dev \
    dwarves \
    # U-Boot build dependencies
    device-tree-compiler \
    python3 \
    python3-dev \
    python3-setuptools \
    swig \
    libgnutls28-dev \
    uuid-dev \
    # WPE WebKit development
    libwpe-1.0-dev \
    libwpebackend-fdo-1.0-dev \
    libwpewebkit-2.0-dev \
    # wlroots and Wayland development
    libwlroots-0.19-dev \
    libwayland-dev \
    wayland-protocols \
    # Additional dependencies for extension compilation
    libglib2.0-dev \
    libjson-glib-dev \
    libsoup-3.0-dev \
    # Graphics and input libraries
    libpixman-1-dev \
    libpng-dev \
    libinput-dev \
    libxkbcommon-dev \
    libdrm-dev \
    libudev-dev \
    libseat-dev \
    # Image and filesystem tools
    qemu-utils \
    e2fsprogs \
    util-linux \
    parted \
    dosfstools \
    mtools \
    xorriso \
    squashfs-tools \
    tar \
    gzip \
    rsync \
    # Documentation tools
    scdoc \
    # Networking tools (for fetching sources)
    wget \
    curl \
    ca-certificates \
    git \
    # YAML processor for reading configuration files
    yq \
    unzip \
    # Custom host packages 
    ${additionalPackages} \
    && rm -rf /var/lib/apt/lists/*

# Install cross-architecture development libraries for cross-compilation
# These are needed when building Cage and WPE extension for different target architectures
RUN apt-get update && apt-get install -y --no-install-recommends \
    # ARM64 cross-architecture development libraries
    libwlroots-0.19-dev:arm64 \
    libwayland-dev:arm64 \
    libglib2.0-dev:arm64 \
    libpixman-1-dev:arm64 \
    libpng-dev:arm64 \
    libinput-dev:arm64 \
    libxkbcommon-dev:arm64 \
    libdrm-dev:arm64 \
    libudev-dev:arm64 \
    libseat-dev:arm64 \
    libwpe-1.0-dev:arm64 \
    libwpebackend-fdo-1.0-dev:arm64 \
    libwpewebkit-2.0-dev:arm64 \
    libjson-glib-dev:arm64 \
    libsoup-3.0-dev:arm64 \
    # x86_64 cross-architecture development libraries (if building on ARM64)
    libwlroots-0.19-dev:amd64 \
    libwayland-dev:amd64 \
    libglib2.0-dev:amd64 \
    libpixman-1-dev:amd64 \
    libpng-dev:amd64 \
    libinput-dev:amd64 \
    libxkbcommon-dev:amd64 \
    libdrm-dev:amd64 \
    libudev-dev:amd64 \
    libseat-dev:amd64 \
    libwpe-1.0-dev:amd64 \
    libwpebackend-fdo-1.0-dev:amd64 \
    libwpewebkit-2.0-dev:amd64 \
    libjson-glib-dev:amd64 \
    libsoup-3.0-dev:amd64 \
    # ARMHF (ARMv7) cross-architecture development libraries
    libwlroots-0.19-dev:armhf \
    libwayland-dev:armhf \
    libglib2.0-dev:armhf \
    libpixman-1-dev:armhf \
    libpng-dev:armhf \
    libinput-dev:armhf \
    libxkbcommon-dev:armhf \
    libdrm-dev:armhf \
    libudev-dev:armhf \
    libseat-dev:armhf \
    libwpe-1.0-dev:armhf \
    libwpebackend-fdo-1.0-dev:armhf \
    libwpewebkit-2.0-dev:armhf \
    libjson-glib-dev:armhf \
    libsoup-3.0-dev:armhf \
    && rm -rf /var/lib/apt/lists/*

# Use login shell for RUN commands so .bashrc is sourced automatically
SHELL ["/bin/bash", "--login", "-c"]


RUN curl -fsSL https://bun.com/install | bash

# Install nvm and Node.js
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

RUN nvm install 24

# Set NVM_DIR environment variable
ENV NVM_DIR="/root/.nvm"

# Find the installed Node.js version directory and create a symlink for easy PATH access
# Then add it to PATH and verify installation
RUN NODE_VERSION_DIR=$(find "$NVM_DIR/versions/node" -maxdepth 1 -type d -name "v24*" | head -1) \
    && mkdir -p /opt/nodejs \
    && ln -sf "$NODE_VERSION_DIR" /opt/nodejs/current \
    && echo "export PATH=\"/opt/nodejs/current/bin:\$PATH\"" >> ~/.bashrc \
    && node -v && npm -v

# Add Bun to PATH for all shells (including /bin/bash -c used by runScriptInDocker)
# Bun installer typically installs to ~/.bun/bin
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:${PATH}"

# Add Node.js to PATH for all shells (including /bin/sh used by runScriptInDocker)
# This ensures scripts run via /bin/sh -c can access node/npm
ENV PATH="/opt/nodejs/current/bin:${PATH}"

# Create workspace directory
WORKDIR /build

CMD ["/bin/bash"]