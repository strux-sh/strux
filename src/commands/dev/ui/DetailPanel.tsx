/***
 *
 *
 * Detail Panel — Right panel, renders based on selected resource
 *
 *
 */
import React from "react"
import { Box, Text } from "ink"
import { theme } from "./theme"
import { LogView, type LogEntry } from "./LogView"
import { TerminalView } from "./TerminalView"
import { FileTreeView } from "./FileTreeView"
import type { Resource } from "./ResourceList"
import type { TUIStore } from "./store"


interface DetailPanelProps {
    store: TUIStore
    resource: Resource
    logs: LogEntry[]
    focused: boolean
    filter?: string
    sshActive: boolean
    onSSHInput: (data: string) => void
    /** Live PTY scrollback for replay (resize / reattach must read fresh bytes). */
    onSSHGetScrollback: (sessionID: string) => string
    /** Ctrl-\ leaves SSH. Single byte, never forwarded to the remote. */
    onSSHDetach?: () => void
    availableRows?: number
    availableCols?: number
}


export function DetailPanel({ store, resource, logs, focused, filter, sshActive, onSSHInput, onSSHGetScrollback, onSSHDetach, availableRows, availableCols }: DetailPanelProps) {

    // Show terminal when SSH session is active on device resource
    if (sshActive && resource.name === "device") {

        return (
            <Box flexDirection="column" flexGrow={1}>

                <Box paddingX={1} gap={2}>
                    <Text bold color={theme.colors.primary}>
                        {resource.label}
                    </Text>
                    <Text color={theme.colors.accent}>SSH</Text>
                    <Text color={theme.colors.muted} wrap="truncate">
                        Ctrl-\ detach · s reattach · exit in shell ends session
                    </Text>
                </Box>

                <TerminalView
                    key={store.sshSessionID ?? "no-ssh"}
                    store={store}
                    focused={focused}
                    rows={availableRows ? availableRows - 4 : 20}
                    cols={availableCols ?? 76}
                    getScrollback={() => onSSHGetScrollback(store.sshSessionID!)}
                    onInput={onSSHInput}
                    onDetach={onSSHDetach}
                />

            </Box>
        )

    }

    // Watcher — show file tree
    if (resource.name === "watcher" && store.projectRoot) {

        return (
            <Box
                flexDirection="column"
                flexGrow={1}
                borderStyle="round"
                borderColor={focused ? theme.colors.primary : theme.colors.muted}
                paddingX={1}
                overflow="hidden"
            >

                <Box marginBottom={1} gap={2} overflow="hidden" height={1}>
                    <Text bold color={theme.colors.primary} wrap="truncate">
                        {resource.label}
                    </Text>
                    <Text color={theme.colors.muted} wrap="truncate">
                        {resource.status}
                    </Text>
                </Box>

                <FileTreeView
                    projectRoot={store.projectRoot}
                    changedFiles={store.changedFiles}
                    focused={focused}
                    height={availableRows ? availableRows - 7 : undefined}
                    width={availableCols ? availableCols - 4 : undefined}
                    rowOffset={9}
                    colOffset={33}
                />

            </Box>
        )

    }

    return (
        <Box
            flexDirection="column"
            flexGrow={1}
            borderStyle="round"
            borderColor={focused ? theme.colors.primary : theme.colors.muted}
            paddingX={1}
            overflow="hidden"
        >

            <Box marginBottom={1} gap={2} overflow="hidden" height={1}>
                <Text bold color={theme.colors.primary} wrap="truncate">
                    {resource.label}
                </Text>
                <Text color={theme.colors.muted} wrap="truncate">
                    {resource.status}
                </Text>

                {resource.name === "device" && store.deviceIP && (
                    <>
                        <Text color={theme.colors.muted}>│</Text>
                        <Text color={theme.colors.text} wrap="truncate">{store.deviceIP}</Text>
                        {store.deviceVersion && (
                            <Text color={theme.colors.text} wrap="truncate">v{store.deviceVersion}</Text>
                        )}
                        {store.inspectorPorts.length > 0 && (
                            <>
                                <Text color={theme.colors.muted}>│</Text>
                                <Text color={theme.colors.text} wrap="truncate">
                                    Inspector: {store.inspectorPorts.map((p) => `${p.path}:${p.port}`).join(", ")}
                                </Text>
                            </>
                        )}
                        {store.deviceOutputs.length > 0 && (
                            <>
                                <Text color={theme.colors.muted}>│</Text>
                                <Text color={theme.colors.text} wrap="truncate">
                                    Outputs: {store.deviceOutputs.map((o) => o.label ?? o.name).join(", ")}
                                </Text>
                            </>
                        )}
                    </>
                )}
            </Box>

            {resource.name === "device" && store.sshSessionIds.length > 0 && !store.sshSessionID && (
                <Box marginBottom={1}>
                    <Text color={theme.colors.muted} wrap="truncate">
                        SSH still running on device — s reattach · exit in shell closes it
                    </Text>
                </Box>
            )}

            <LogView
                logs={logs}
                focused={focused}
                filter={filter}
                height={availableRows ? availableRows - (store.sshSessionIds.length > 0 && !store.sshSessionID && resource.name === "device" ? 8 : 7) : undefined}
                width={availableCols ? availableCols - 4 : undefined}
                rowOffset={9}
                colOffset={33}
            />

        </Box>
    )

}
