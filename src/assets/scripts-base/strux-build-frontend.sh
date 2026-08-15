#!/bin/bash

set -eo pipefail

# Trap errors and print the failing command/line
trap 'echo "Error: Command failed at line $LINENO with exit code $?: $BASH_COMMAND" >&2' ERR

# Define A Function to Print Progress Messages that will be used by the Strux CLI
progress() {
    echo "STRUX_PROGRESS: $1"
}

PROJECT_DIR="${PROJECT_DIR:-/project}"
FRONTEND_DIR="${FRONTEND_DIR:-$PROJECT_DIR/frontend}"
FRONTEND_OUTPUT_DIR="${FRONTEND_OUTPUT_DIR:-$FRONTEND_DIR/dist}"
FRONTEND_INSTALL_DIR="${FRONTEND_INSTALL_DIR:-$FRONTEND_DIR}"
FRONTEND_BUILD_SCRIPT="${FRONTEND_BUILD_SCRIPT:-build}"
FRONTEND_WORKSPACE_PACKAGE="${FRONTEND_WORKSPACE_PACKAGE:-}"

# npm resolves local workspace packages from the configured workspace root.
cd "$FRONTEND_INSTALL_DIR"

workspace_args=()
if [[ -n "$FRONTEND_WORKSPACE_PACKAGE" ]]; then
    workspace_args+=(--workspace "$FRONTEND_WORKSPACE_PACKAGE")
fi

progress "Installing Frontend Dependencies..."

# Install Linux dependencies into Docker-managed node_modules volumes.
# A frontend compilation always needs its devDependencies (Vite, TypeScript,
# framework plugins, and linters), even when the builder environment happens
# to set production-oriented npm defaults.
npm install --include=dev "${workspace_args[@]}"

progress "Building Frontend..."

# Run the package build without requiring a root-level forwarding script.
npm run "$FRONTEND_BUILD_SCRIPT" "${workspace_args[@]}"

progress "Copying Built Frontend to Dist Directory..."

# Frontend is architecture-agnostic, so it goes in shared cache
# Use SHARED_CACHE_DIR if provided, otherwise fallback to default
CACHE_DIR="${SHARED_CACHE_DIR:-$PROJECT_DIR/dist/cache}"

# Remove the frontend directory if it exists
rm -rf "$CACHE_DIR/frontend"

# Create the frontend directory if it doesn't exist
mkdir -p "$CACHE_DIR/frontend"

# Copy the configured output while preserving dotfiles.
cp -R "$FRONTEND_OUTPUT_DIR"/. "$CACHE_DIR/frontend/"
