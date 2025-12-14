/***
 *
 *
 *  Strux Dev Watcher Path Unit
 *
 */

export const STRUX_DEV_WATCHER_PATH = `
[Path]
# Watch for restart flag file (primary trigger)
# Also watch binary and .dev file as backup
PathChanged=/strux/.strux-restart
PathModified=/strux/.strux-restart
PathChanged=/strux/app
PathModified=/strux/app
PathChanged=/strux/.dev
PathModified=/strux/.dev
# Trigger the service when path changes
Unit=strux-dev-watcher.service

[Install]
WantedBy=multi-user.target
`

