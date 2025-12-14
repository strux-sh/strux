/***
 *
 *
 *  SystemD Service File for Strux
 *
 */

export const STRUX_SERVICE = `
[Unit]
Description=Strux Kiosk Service
After=network.target seatd.service dbus.service systemd-logind.service plymouth-start.service strux-dev-watcher.path strux-mount-setup.service
Wants=seatd.service dbus.service plymouth-start.service strux-dev-watcher.path strux-mount-setup.service
Requires=seatd.service

[Service]
Type=simple
ExecStart=/usr/bin/strux-start.sh
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# Environment
Environment=XDG_RUNTIME_DIR=/tmp/run
Environment=WPE_WEB_EXTENSION_PATH=/usr/lib/wpe-web-extensions
Environment=SEATD_SOCK=/run/seatd.sock
Environment=WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
Environment=WEBKIT_FORCE_SANDBOX=0
Environment=WLR_DRM_NO_MODIFIERS=1

[Install]
WantedBy=multi-user.target
`