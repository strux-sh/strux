/***
 *
 *
 *  Strux Dev Watcher Script
 *
 */

export const STRUX_DEV_WATCHER_SCRIPT = `#!/bin/sh
# Strux Dev Watcher Script
# Polls for .strux-restart flag and reboots when found

while true; do
    if [ -f /strux/.strux-restart ]; then
        echo "[STRUX-WATCHER] Restart flag found, rebooting..." > /dev/console
        rm -f /strux/.strux-restart
        /sbin/reboot -f
    fi
    sleep 2
done
`


