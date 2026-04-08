/***
 *
 *
 * Status Bar — Top bar with connection state, build status, uptime
 *
 *
 */
import React from "react"
import { Box, Text } from "ink"
import { theme, getStatusIcon, getStatusColor, type ResourceStatus } from "./theme"


interface StatusBarProps {
    deviceStatus: ResourceStatus
    deviceIP?: string
    buildStatus: string
    bspName: string
    watcherStatus: ResourceStatus
}


export const StatusBar = React.memo(function StatusBar({ deviceStatus, deviceIP, buildStatus, bspName, watcherStatus }: StatusBarProps) {

    const statusIcon = getStatusIcon(deviceStatus)
    const statusColor = getStatusColor(deviceStatus)

    const buildColor = buildStatus === "building" ? "yellow" :
        buildStatus === "error" ? "red" : "green"

    const buildIcon = buildStatus === "building" ? "⟳" :
        buildStatus === "error" ? "✗" : "✓"

    return (
        <Box
            borderStyle="round"
            borderColor={buildStatus === "building" ? "yellow" : buildStatus === "error" ? "red" : theme.colors.primary}
            paddingX={1}
            justifyContent="space-between"
            overflow="hidden"
            height={3}
        >

            <Box gap={1}>
                <Text bold color={theme.colors.primary}>::</Text>
                <Text bold color="white">Strux</Text>
                <Text color="gray">Developer Mode</Text>
                <Text color={theme.colors.muted}> │ </Text>
                <Text color={statusColor}>{statusIcon}</Text>
                <Text color={theme.colors.muted}> Device </Text>
                <Text color={statusColor} bold>
                    {deviceStatus === "connected" ? deviceIP ?? "connected" : deviceStatus}
                </Text>
                {watcherStatus === "paused" && (
                    <>
                        <Text color={theme.colors.muted}> │ </Text>
                        <Text color="yellow" bold>⏸ PAUSED</Text>
                    </>
                )}
            </Box>

            <Box gap={1}>
                <Text color={theme.colors.muted}>BSP </Text>
                <Text color="white" bold>{bspName}</Text>
                <Text color={theme.colors.muted}> │ </Text>
                <Text color={buildColor}>{buildIcon}</Text>
                <Text color={buildColor} bold> {buildStatus}</Text>
            </Box>

        </Box>
    )

})
