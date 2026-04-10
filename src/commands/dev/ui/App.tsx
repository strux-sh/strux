/***
 *
 *
 * App — Root TUI component
 *
 *
 */
import React, { useState, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react"
import { Box, useInput, useApp, useStdout } from "ink"
import { StatusBar } from "./StatusBar"
import { ResourceList, type Resource } from "./ResourceList"
import { DetailPanel } from "./DetailPanel"
import { ConfigPanel, type ConfigAction } from "./ConfigPanel"
import { CommandBar, type Keybind } from "./CommandBar"
import type { TUIStore } from "./store"


// All possible resource names
export type ResourceName =
    | "device"
    | "device:app"
    | "device:cage"
    | "device:system"
    | "device:early"
    | "device:screen"
    | "device:client"
    | "vite"
    | "qemu"
    | "watcher"
    | "screen"

// Focus can be on the resource list, detail panel, SSH terminal, or config
type FocusPane = "resources" | "detail" | "ssh" | "config"


interface AppProps {
    store: TUIStore
    onExit: () => void
    onSSHStart: (rows: number, cols: number) => string
    onSSHDetach: (sessionID: string) => void
    onSSHAttach: (sessionID: string, rows: number, cols: number) => string
    onSSHGetScrollback: (sessionID: string) => string
    onSSHInput: (sessionID: string, data: string) => void
    onSSHResize: (sessionID: string, rows: number, cols: number) => void
    onConfigAction: (action: ConfigAction) => void
    onWatcherTogglePause: () => boolean
    /** Reset Ink + wipe screen after SSH detach or leaving config (direct stdout bypasses Ink's line tracker). */
    afterInkReset?: () => void
}


export function App({ store, onExit, onSSHStart, onSSHDetach, onSSHAttach, onSSHGetScrollback, onSSHInput, onSSHResize, onConfigAction, onWatcherTogglePause, afterInkReset }: AppProps) {

    const { exit } = useApp()
    const { stdout } = useStdout()

    // Track terminal dimensions
    const [termHeight, setTermHeight] = useState(stdout?.rows ?? 24)
    const [termWidth, setTermWidth] = useState(stdout?.columns ?? 80)

    useEffect(() => {

        const onResize = () => {
            const newHeight = stdout?.rows ?? 24
            const newWidth = stdout?.columns ?? 80
            setTermHeight(newHeight)
            setTermWidth(newWidth)

            // Resize active SSH session
            if (store.sshSessionID) {
                onSSHResize(store.sshSessionID, newHeight - 10, newWidth - 30)
            }
        }
        stdout?.on("resize", onResize)
        return () => { stdout?.off("resize", onResize) }

    }, [stdout, store.sshSessionID, onSSHResize])

    // Subscribe to store for reactive updates
    useSyncExternalStore(
        (cb) => store.subscribe(cb),
        () => store.version
    )

    // Navigation state (local to TUI)
    const [selectedIndex, setSelectedIndex] = useState(0)
    const [focusPane, setFocusPane] = useState<FocusPane>("resources")
    const [filter, setFilter] = useState<string | undefined>()
    const [filterMode, setFilterMode] = useState(false)
    const [filterInput, setFilterInput] = useState("")

    const prevSshSessionRef = useRef<string | null>(null)
    const prevFocusPaneRef = useRef<FocusPane>(focusPane)
    const [sshRemountKey, setSshRemountKey] = useState(0)

    useLayoutEffect(() => {

        const was = prevSshSessionRef.current
        const now = store.sshSessionID
        if (was !== null && now === null) {
            afterInkReset?.()
            setFocusPane((fp) => (fp === "ssh" ? "detail" : fp))
            setSshRemountKey((k) => k + 1)
        }
        prevSshSessionRef.current = now

    }, [store.sshSessionID, store.version, afterInkReset])


    useLayoutEffect(() => {

        const prev = prevFocusPaneRef.current
        if (prev === "config" && focusPane !== "config") {
            afterInkReset?.()
            setSshRemountKey((k) => k + 1)
        }
        prevFocusPaneRef.current = focusPane

    }, [focusPane, afterInkReset])


    // Build the resource list from store
    const resources: Resource[] = [
        { name: "device",         label: "Device",      status: store.statuses.device, detail: store.deviceIP },
        { name: "device:app",     label: "App",         status: store.statuses["device:app"],    indent: 1 },
        { name: "device:cage",    label: "Cage",        status: store.statuses["device:cage"],   indent: 1 },
        { name: "device:system",  label: "System Logs", status: store.statuses["device:system"], indent: 1 },
        { name: "device:early",   label: "Early Logs",  status: store.statuses["device:early"],  indent: 1 },
        { name: "device:screen",  label: "Screen Logs", status: store.statuses["device:screen"], indent: 1 },
        { name: "device:client",  label: "Client",      status: store.statuses["device:client"], indent: 1 },
        { name: "vite",           label: "Vite",        status: store.statuses.vite },
        { name: "qemu",           label: "QEMU",        status: store.statuses.qemu },
        { name: "watcher",        label: "Watcher",     status: store.statuses.watcher },
        { name: "screen",         label: "Screen",      status: store.statuses.screen },
    ]

    const selectedResource = resources[selectedIndex]
    const sshActive = !!store.sshSessionID


    // Handle SSH input — forward keystrokes to the session
    const handleSSHInput = (data: string) => {

        if (store.sshSessionID) {
            onSSHInput(store.sshSessionID, data)
        }

    }


    // Keyboard handling
    useInput((input, key) => {

        // SSH mode: all keystrokes are owned by TerminalView's raw stdin handler (including the
        // Ctrl-\ detach byte). Ink's cooked useInput is bypassed entirely while SSH is focused —
        // we don't even intercept Ctrl-C, so the user can still send SIGINT to a remote process.
        if (focusPane === "ssh") {
            return
        }

        // Ctrl-C quits from any non-SSH pane (config, filter, detail, resources).
        if (key.ctrl && input === "c") {
            onExit()
            exit()
            return
        }

        // Config mode: Esc goes back
        if (focusPane === "config") {

            if (key.escape) {
                setFocusPane("resources")
                return
            }

            // Let ConfigPanel handle j/k/Enter
            return

        }

        // Filter mode
        if (filterMode) {

            if (key.return) {
                setFilter(filterInput || undefined)
                setFilterMode(false)
                return
            }

            if (key.escape) {
                setFilterMode(false)
                setFilterInput("")
                setFilter(undefined)
                return
            }

            if (key.backspace || key.delete) {
                setFilterInput((prev) => prev.slice(0, -1))
                return
            }

            if (input && !key.ctrl && !key.meta) {
                setFilterInput((prev) => prev + input)
            }

            return
        }

        // Quit
        if (input === "q") {
            onExit()
            exit()
            return
        }

        // Open config panel
        if (input === "c") {
            setFocusPane("config")
            return
        }

        // Toggle watcher pause
        if (input === "p") {
            onWatcherTogglePause()
            return
        }

        // SSH: s = reattach to detached session if any, else start (only one PTY at a time)
        if (input === "s" && selectedResource!.name === "device" && store.statuses.device === "connected") {
            if (store.sshSessionID) {
                return
            }
            const sshRows = termHeight - 10
            const sshCols = termWidth - 30
            const ids = store.sshSessionIds
            if (ids.length > 0) {
                const sid = ids[0]!
                onSSHAttach(sid, sshRows, sshCols)
                store.setSSHSession(sid)
                setFocusPane("ssh")
                return
            }
            const sessionID = onSSHStart(sshRows, sshCols)
            if (sessionID) {
                store.setSSHSession(sessionID)
                setFocusPane("ssh")
            }
            return
        }

        // Enter filter mode
        if (input === "/") {
            setFilterMode(true)
            setFilterInput("")
            return
        }

        // Clear filter
        if (key.escape && filter) {
            setFilter(undefined)
            return
        }

        // Switch focus between panes
        if (key.return && focusPane === "resources") {
            setFocusPane("detail")
            return
        }

        if (key.escape && focusPane === "detail") {
            setFocusPane("resources")
            return
        }

        // Tab to switch panes
        if (key.tab) {
            setFocusPane((prev) => prev === "resources" ? "detail" : "resources")
            return
        }

    })


    // Context-sensitive keybinds
    let keybinds: Keybind[]

    if (focusPane === "ssh") {
        keybinds = [
            { key: "Ctrl-\\", label: "detach SSH" },
        ]
    } else if (focusPane === "config") {
        keybinds = [
            { key: "j/k", label: "navigate" },
            { key: "Enter", label: "execute" },
            { key: "Esc", label: "back" },
        ]
    } else if (focusPane === "resources") {
        keybinds = [
            { key: "j/k", label: "navigate" },
            { key: "Enter", label: "focus logs" },
            ...(selectedResource!.name === "device" && store.statuses.device === "connected"
                ? [{ key: "s", label: store.sshSessionIds.length > 0 && !store.sshSessionID ? "reattach SSH" : "SSH" }]
                : []),
            { key: "p", label: store.statuses.watcher === "paused" ? "resume watcher" : "pause watcher" },
            { key: "c", label: "config" },
            { key: "/", label: "filter" },
            { key: "q", label: "quit" },
        ]
    } else {
        keybinds = [
            { key: "j/k", label: "scroll" },
            { key: "g/G", label: "top/bottom" },
            { key: "Esc", label: "back" },
            { key: "p", label: store.statuses.watcher === "paused" ? "resume watcher" : "pause watcher" },
            { key: "c", label: "config" },
            { key: "/", label: "filter" },
            { key: "q", label: "quit" },
        ]
    }


    const mode = filterMode
        ? `FILTER: ${filterInput}`
        : focusPane === "ssh" ? "SSH"
            : focusPane === "config" ? "CONFIG"
                : focusPane === "detail" ? "LOGS" : undefined


    return (
        <Box flexDirection="column" width="100%" height={termHeight} key={sshRemountKey}>

            <StatusBar
                deviceStatus={store.statuses.device}
                deviceIP={store.deviceIP}
                buildStatus={store.buildStatus}
                bspName={store.bspName}
                watcherStatus={store.statuses.watcher}
            />

            <Box flexGrow={1}>

                <ResourceList
                    resources={resources}
                    selectedIndex={selectedIndex}
                    focused={focusPane === "resources"}
                    onSelect={setSelectedIndex}
                />

                {focusPane === "config" ? (
                    <ConfigPanel
                        focused={true}
                        busy={store.configBusy}
                        successMessage={store.configSuccessMessage || undefined}
                        onAction={onConfigAction}
                        onClose={() => setFocusPane("resources")}
                        height={termHeight - 8}
                        width={termWidth - 36}
                        rowOffset={5}
                        colOffset={33}
                    />
                ) : (
                    <DetailPanel
                        store={store}
                        resource={selectedResource!}
                        logs={store.logs[selectedResource!.name as ResourceName]}
                        focused={focusPane === "detail" || focusPane === "ssh"}
                        filter={filter}
                        sshActive={sshActive && selectedResource!.name === "device"}
                        onSSHInput={handleSSHInput}
                        onSSHGetScrollback={onSSHGetScrollback}
                        onSSHDetach={() => {
                            if (store.sshSessionID) {
                                onSSHDetach(store.sshSessionID)
                                store.setSSHSession(null)
                            }
                            setFocusPane("detail")
                        }}
                        availableRows={termHeight - 6}
                        availableCols={termWidth - 30}
                    />
                )}

            </Box>

            <CommandBar keybinds={keybinds} mode={mode} />

        </Box>
    )

}
