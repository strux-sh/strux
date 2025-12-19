/***
 *
 *  Strux Dev Mount Setup Service
 *
 */

export const STRUX_MOUNT_SETUP_SERVICE = `[Unit]
Description=Strux Dev Mount Setup
After=local-fs.target systemd-udevd.service
Before=strux.service
DefaultDependencies=no

[Service]
Type=oneshot
RemainAfterExit=yes
StandardOutput=journal+console
StandardError=journal+console
# Try to mount if not already mounted, wait for virtio device to be ready
ExecStart=/bin/bash -c '
    echo "=== Strux Mount Setup Starting ==="
    echo "=== Strux Mount Setup Starting ===" > /dev/console
    
    # Load 9p module if not already loaded
    echo "Loading 9p filesystem module..."
    echo "Loading 9p filesystem module..." > /dev/console
    modprobe 9p 2>&1 | tee -a /dev/console || echo "9p module already loaded or not available" | tee -a /dev/console
    modprobe 9pnet 2>&1 | tee -a /dev/console || echo "9pnet module already loaded or not available" | tee -a /dev/console
    modprobe 9pnet_virtio 2>&1 | tee -a /dev/console || echo "9pnet_virtio module already loaded or not available" | tee -a /dev/console
    
    # Wait a bit for virtio devices to be ready
    echo "Waiting for virtio devices..."
    echo "Waiting for virtio devices..." > /dev/console
    sleep 2
    
    # Check if virtio-9p device exists
    echo "Checking for virtio-9p device..."
    echo "Checking for virtio-9p device..." > /dev/console
    if [ -d /sys/bus/virtio/devices ]; then
        echo "Virtio devices directory exists"
        echo "Virtio devices directory exists" > /dev/console
        ls -la /sys/bus/virtio/devices/ | tee -a /dev/console || true
    else
        echo "WARNING: /sys/bus/virtio/devices does not exist"
        echo "WARNING: /sys/bus/virtio/devices does not exist" > /dev/console
    fi
    
    # Check if already mounted
    if mountpoint -q /strux; then
        echo "strux already mounted"
        echo "strux already mounted" > /dev/console
        mount | grep strux | tee -a /dev/console || true
    else
        echo "Attempting to mount virtfs..."
        echo "Attempting to mount virtfs..." > /dev/console
        mkdir -p /strux
        MOUNT_SUCCESS=0
        for i in 1 2 3 4 5 6 7 8 9 10; do
            echo "Mount attempt $i..."
            echo "Mount attempt $i..." > /dev/console
            if mount -t 9p -o trans=virtio,version=9p2000.L strux /strux 2>&1 | tee -a /dev/console; then
                echo "virtfs mounted successfully on attempt $i"
                echo "virtfs mounted successfully on attempt $i" > /dev/console
                MOUNT_SUCCESS=1
                break
            else
                echo "Mount failed, retrying..."
                echo "Mount failed, retrying..." > /dev/console
                sleep 1
            fi
        done
        
        if [ "$MOUNT_SUCCESS" = "0" ]; then
            echo "ERROR: Failed to mount virtfs after 10 attempts"
            echo "ERROR: Failed to mount virtfs after 10 attempts" > /dev/console
            echo "Checking available mounts..."
            echo "Checking available mounts..." > /dev/console
            mount | grep 9p | tee -a /dev/console || echo "No 9p mounts found" | tee -a /dev/console
            echo "Checking /strux directory..."
            echo "Checking /strux directory..." > /dev/console
            ls -la /strux/ | tee -a /dev/console || true
        fi
    fi
    
    # Verify mount and create symlink if app exists
    if mountpoint -q /strux; then
        echo "Mount verified, checking contents..."
        echo "Mount verified, checking contents..." > /dev/console
        ls -la /strux/ | tee -a /dev/console || true
        
        if [ -x /strux/app ]; then
            ln -sf /strux/app /usr/bin/strux-app || true
            echo "Created symlink to /strux/app"
            echo "Created symlink to /strux/app" > /dev/console
        else
            echo "WARNING: /strux/app not found or not executable"
            echo "WARNING: /strux/app not found or not executable" > /dev/console
            echo "Contents of /strux:"
            echo "Contents of /strux:" > /dev/console
            ls -la /strux/ | tee -a /dev/console || true
        fi
    else
        echo "ERROR: /strux is not mounted!"
        echo "ERROR: /strux is not mounted!" > /dev/console
    fi
    
    echo "=== Strux Mount Setup Complete ==="
    echo "=== Strux Mount Setup Complete ===" > /dev/console
'

[Install]
WantedBy=multi-user.target
`


