#!/bin/bash

set -e

# Define A Function to Print Progress Messages that will be used by the Strux CLI
progress() {
    echo "STRUX_PROGRESS: $1"
}

# Navigate to the frontend directory of the project
cd /project/frontend 

progress "Installing Frontend Dependencies..."

# Install the dependencies
npm install

progress "Building Frontend..."

# Build the frontend
npm run build

progress "Copying Built Frontend to Dist Directory..."

# Remove the dist/cache/frontend directory if it exists
rm -rf /project/dist/cache/frontend

# Create the dist/cache/frontend directory if it doesn't exist
mkdir -p /project/dist/cache/frontend

# Copy the built frontend to the dist/cache/frontend directory
cp -r dist/* /project/dist/cache/frontend