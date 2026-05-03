#!/bin/bash

set -eo pipefail

# Trap errors and print the failing command/line
trap 'echo "Error: Command failed at line $LINENO with exit code $?: $BASH_COMMAND" >&2' ERR

# Define A Function to Print Progress Messages that will be used by the Strux CLI
progress() {
    echo "STRUX_PROGRESS: $1"
}

PROJECT_DIR="${PROJECT_DIR:-/project}"

# Navigate to the frontend directory of the project
cd "$PROJECT_DIR/frontend"

progress "Installing Frontend Dependencies..."

# Install the dependencies
npm install

progress "Building Frontend..."

# Build the frontend
npm run build

progress "Copying Built Frontend to Dist Directory..."

# Frontend is architecture-agnostic, so it goes in shared cache
# Use SHARED_CACHE_DIR if provided, otherwise fallback to default
CACHE_DIR="${SHARED_CACHE_DIR:-$PROJECT_DIR/dist/cache}"

# Remove the frontend directory if it exists
rm -rf "$CACHE_DIR/frontend"

# Create the frontend directory if it doesn't exist
mkdir -p "$CACHE_DIR/frontend"

# Copy the built frontend to the cache/frontend directory.
# Using dist/. preserves the full directory contents, including dotfiles.
cp -R dist/. "$CACHE_DIR/frontend/"
