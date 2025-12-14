/***
 *
 *
 *  Strux Dev Watcher Timer Unit
 *
 */

export const STRUX_DEV_WATCHER_TIMER = `
[Unit]
Description=Strux Dev Mode Watcher Timer
After=strux-mount-setup.service

[Timer]
# Check every 2 seconds for binary changes
OnActiveSec=2
OnUnitActiveSec=2
AccuracySec=1s
# Trigger the service when timer fires
Unit=strux-dev-watcher.service

[Install]
WantedBy=multi-user.target
`

