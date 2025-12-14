/***
 *
 *
 *  Strux Dev Watcher Service Unit
 *
 */

export const STRUX_DEV_WATCHER_SERVICE = `
[Unit]
Description=Strux Dev Mode Watcher
After=strux-mount-setup.service

[Service]
Type=oneshot
StandardOutput=journal+console
StandardError=journal+console
# Simple: if flag exists, delete it and reboot immediately
ExecStart=/bin/sh -c 'if [ -f /strux/.strux-restart ]; then rm -f /strux/.strux-restart; /sbin/reboot -f; fi'
# Delete flag at startup to prevent loops
ExecStartPre=/bin/sh -c 'rm -f /strux/.strux-restart || true'
`

