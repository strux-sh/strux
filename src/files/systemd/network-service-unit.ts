/**
 *
 *
 *  SystemD Service File for Network Setup
 *  Configures loopback interface before network.target
 *
 */

export const NETWORK_SERVICE_UNIT = `
[Unit]
Description=Strux Network Setup
Before=network.target
Wants=network.target

[Service]
Type=oneshot
ExecStart=/usr/bin/strux-network.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
`
