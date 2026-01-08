# Debian Forky (testing) - has wlroots 0.19
FROM debian:testing-slim

ENV DEBIAN_FRONTEND=noninteractive

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

# Add Node.js to PATH for all shells (including /bin/sh used by runScriptInDocker)
# This ensures scripts run via /bin/sh -c can access node/npm
ENV PATH="/opt/nodejs/current/bin:${PATH}"

# Create workspace directory
WORKDIR /build

CMD ["/bin/bash"]