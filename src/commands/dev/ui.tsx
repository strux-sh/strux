/***
 *
 *
 *  Dev TUI
 *
 *  Rich terminal interface for dev mode logs and console.
 *
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Box, Text, render, useInput, useStdin, useStdout } from "ink"
import { Terminal } from "@xterm/headless"
import { STRUX_VERSION } from "../../version"

type TabId = "build" | "vite" | "app" | "cage" | "system" | "qemu" | "console"

interface DevUIOptions {
    onExit: () => void
    onConsoleInput: (data: string) => void
    initialStatus?: string
}

interface TabConfig {
    id: TabId
    label: string
}

interface DevUIState {
    status: string
    consoleSessionActive: boolean
    consoleInputMode: boolean
    activeTab: TabId
    tabs: TabConfig[]
    logs: Record<TabId, string[]>
    spinnerLine: string
    scrollOffsets: Record<TabId, number>
    consoleRevision: number
}

type DevUISubscriber = (state: DevUIState) => void

class DevUIStore {
    private state: DevUIState
    private subscribers = new Set<DevUISubscriber>()
    private consoleTerminal: Terminal

    constructor(initialStatus: string) {
        this.consoleTerminal = new Terminal({
            cols: 80,
            rows: 24,
            scrollback: 2000,
            convertEol: true,
            allowProposedApi: true
        })
        this.state = {
            status: initialStatus,
            consoleSessionActive: false,
            consoleInputMode: false,
            activeTab: "build",
            tabs: [
                { id: "build", label: "Build" },
                { id: "vite", label: "Vite" },
                { id: "app", label: "App Logs" },
                { id: "cage", label: "Cage Logs" },
                { id: "system", label: "System Logs" },
                { id: "qemu", label: "QEMU Serial" },
                { id: "console", label: "Remote Console" }
            ],
            logs: {
                build: [],
                vite: [],
                app: [],
                cage: [],
                system: [],
                qemu: [],
                console: []
            },
            spinnerLine: "",
            scrollOffsets: {
                build: 0,
                vite: 0,
                app: 0,
                cage: 0,
                system: 0,
                qemu: 0,
                console: 0
            },
            consoleRevision: 0
        }
    }

    public getState(): DevUIState {
        return this.state
    }

    public subscribe(callback: DevUISubscriber): () => void {
        this.subscribers.add(callback)
        callback(this.state)
        return () => this.subscribers.delete(callback)
    }

    public setStatus(status: string): void {
        this.state = { ...this.state, status }
        this.emit()
    }

    public setConsoleSessionActive(active: boolean): void {
        this.state = { ...this.state, consoleSessionActive: active }
        this.emit()
    }

    public setConsoleInputMode(active: boolean): void {
        if (this.state.consoleInputMode === active) return
        this.state = { ...this.state, consoleInputMode: active }
        this.emit()
    }

    public setQemuTabLabel(label: string): void {
        const tabs = this.state.tabs.map((tab) =>
            tab.id === "qemu" ? { ...tab, label } : tab
        )
        this.state = { ...this.state, tabs }
        this.emit()
    }

    public setActiveTab(tabId: TabId): void {
        this.state = {
            ...this.state,
            activeTab: tabId,
            consoleInputMode: tabId === "console" ? this.state.consoleInputMode : false
        }
        this.emit()
    }

    public appendLog(tabId: TabId, line: string): void {
        const logs = { ...this.state.logs }
        const next = [...logs[tabId], line]
        logs[tabId] = next.slice(-400)
        this.state = { ...this.state, logs }
        this.emit()
    }

    public appendConsoleChunk(chunk: string): void {
        this.consoleTerminal.write(chunk, () => {
            this.state = { ...this.state, consoleRevision: this.state.consoleRevision + 1 }
            this.emit()
        })
    }

    public clearActive(): void {
        const tab = this.state.activeTab
        const logs = { ...this.state.logs, [tab]: [] }
        const scrollOffsets = { ...this.state.scrollOffsets, [tab]: 0 }
        this.state = {
            ...this.state,
            logs,
            scrollOffsets
        }
        if (tab === "console") {
            this.consoleTerminal.write("\x1bc")
        }
        this.emit()
    }

    public setScrollOffset(tabId: TabId, offset: number): void {
        const scrollOffsets = { ...this.state.scrollOffsets, [tabId]: offset }
        this.state = { ...this.state, scrollOffsets }
        this.emit()
    }

    public setSpinnerLine(line: string): void {
        this.state = { ...this.state, spinnerLine: line }
        this.emit()
    }

    public getConsoleTerminal(): Terminal {
        return this.consoleTerminal
    }

    public resizeConsole(cols: number, rows: number): void {
        if (cols <= 0 || rows <= 0) return
        if (this.consoleTerminal.cols === cols && this.consoleTerminal.rows === rows) return
        this.consoleTerminal.resize(cols, rows)
        this.state = { ...this.state, consoleRevision: this.state.consoleRevision + 1 }
        this.emit()
    }

    private emit(): void {
        for (const subscriber of this.subscribers) {
            subscriber(this.state)
        }
    }
}

function DevApp(props: { store: DevUIStore; onExit: () => void; onConsoleInput: (data: string) => void }) {
    const { store, onExit, onConsoleInput } = props
    const [state, setState] = useState(store.getState())
    useStdin() // Keep Ink's stdin handling active
    const { stdout } = useStdout()
    const consoleTerminal = store.getConsoleTerminal()

    // Refs for stable access in callbacks
    const storeRef = useRef(store)
    const onExitRef = useRef(onExit)
    const stdoutRef = useRef(stdout)
    storeRef.current = store
    onExitRef.current = onExit
    stdoutRef.current = stdout

    useEffect(() => store.subscribe(setState), [store])

    // Ref to track console input mode for the input handler
    const consoleInputModeRef = useRef(state.consoleInputMode)
    const onConsoleInputRef = useRef(onConsoleInput)
    consoleInputModeRef.current = state.consoleInputMode
    onConsoleInputRef.current = onConsoleInput

    const spinnerVisible = state.activeTab === "build" && state.spinnerLine
    const chromeHeight = 6  // 1 title + 1 tabs + 1 top spacer + 1 bottom spacer + 2 footer
    const rows = stdout?.rows ?? 24
    const viewHeight = Math.max(5, rows - chromeHeight - (spinnerVisible ? 1 : 0))
    const cols = stdout?.columns ?? 80
    const isConsole = state.activeTab === "console"

    useEffect(() => {
        if (isConsole) {
            store.resizeConsole(cols, viewHeight)
        }
    }, [cols, viewHeight, isConsole, store])

    const allLogs = state.logs[state.activeTab]
    const consoleBufferLength = consoleTerminal.buffer.active.length
    const maxOffset = Math.max(0, (isConsole ? consoleBufferLength : allLogs.length) - viewHeight)
    const offset = Math.min(state.scrollOffsets[state.activeTab], maxOffset)
    const start = Math.max(0, (isConsole ? consoleBufferLength : allLogs.length) - viewHeight - offset)
    const activeLogs = useMemo(() => {
        if (!isConsole) {
            return allLogs.slice(start, start + viewHeight)
        }

        const lines: string[] = []
        for (let i = start; i < start + viewHeight; i += 1) {
            const line = consoleTerminal.buffer.active.getLine(i)?.translateToString(true) ?? ""
            lines.push(line)
        }
        return lines
    }, [allLogs, start, viewHeight, isConsole, consoleTerminal, state.consoleRevision])

    // Keep input always active - we handle console input mode in the handler
    const inputActive = useMemo(() => ({ isActive: true }), [])

    // Stable navigation input handler - uses refs for all dynamic values
    const handleInput = useCallback((input: string, key: Record<string, boolean>) => {
        const s = storeRef.current.getState()
        const tabs = s.tabs
        const activeTab = s.activeTab

        // Handle console input mode - forward all input except CTRL+J to remote
        if (consoleInputModeRef.current && activeTab === "console") {
            // CTRL+J exits input mode (J = 0x6A, CTRL+J = 0x0A = LF = newline)
            // In Ink, when you press CTRL+letter, input will be the letter and key.ctrl will be true
            // However, CTRL+J produces a newline character, so we check for that too
            if ((key.ctrl && input === "j") || input === "\n") {
                storeRef.current.setConsoleInputMode(false)
                return
            }

            // Reconstruct the actual key sequence to send
            let sequence = input

            // Handle special keys that need escape sequences
            if (key.return) {
                sequence = "\r"  // Carriage return
            } else if (key.escape) {
                sequence = "\x1b"
            } else if (key.backspace || key.delete) {
                sequence = "\x7f"
            } else if (key.upArrow) {
                sequence = "\x1b[A"
            } else if (key.downArrow) {
                sequence = "\x1b[B"
            } else if (key.rightArrow) {
                sequence = "\x1b[C"
            } else if (key.leftArrow) {
                sequence = "\x1b[D"
            } else if (key.tab) {
                sequence = "\t"
            } else if (key.ctrl && input) {
                // Convert CTRL+letter to control character
                const charCode = input.toUpperCase().charCodeAt(0)
                if (charCode >= 65 && charCode <= 90) {
                    sequence = String.fromCharCode(charCode - 64)
                }
            }

            if (sequence) {
                onConsoleInputRef.current(sequence)
            }
            return
        }

        if (key.leftArrow) {
            const idx = tabs.findIndex((t) => t.id === activeTab)
            const next = (idx - 1 + tabs.length) % tabs.length
            storeRef.current.setActiveTab(tabs[next]!.id)
            return
        }

        if (key.rightArrow) {
            const idx = tabs.findIndex((t) => t.id === activeTab)
            const next = (idx + 1) % tabs.length
            storeRef.current.setActiveTab(tabs[next]!.id)
            return
        }

        if (key.ctrl && input === "c") {
            onExitRef.current()
            return
        }

        if (input === "q" || (key.ctrl && input === "q")) {
            onExitRef.current()
            return
        }

        if (activeTab === "console" && key.return) {
            if (s.consoleSessionActive) {
                storeRef.current.setConsoleInputMode(true)
            }
            return
        }

        if (input === "c") {
            storeRef.current.clearActive()
            return
        }

        // Scroll handling
        const spinnerActive = activeTab === "build" && s.spinnerLine
        const currentRows = stdoutRef.current?.rows ?? 24
        const currentViewHeight = Math.max(5, currentRows - chromeHeight - (spinnerActive ? 1 : 0))
        const term = storeRef.current.getConsoleTerminal()
        const consoleLines = term.buffer.active.length
        const logLines = s.logs[activeTab].length
        const currentMaxOffset = Math.max(0, (activeTab === "console" ? consoleLines : logLines) - currentViewHeight)
        const currentOffset = Math.min(s.scrollOffsets[activeTab], currentMaxOffset)

        if (key.upArrow) {
            storeRef.current.setScrollOffset(activeTab, Math.min(currentMaxOffset, currentOffset + 1))
            return
        }

        if (key.downArrow) {
            storeRef.current.setScrollOffset(activeTab, Math.max(0, currentOffset - 1))
            return
        }

        if (key.pageUp) {
            storeRef.current.setScrollOffset(activeTab, Math.min(currentMaxOffset, currentOffset + currentViewHeight))
            return
        }

        if (key.pageDown) {
            storeRef.current.setScrollOffset(activeTab, Math.max(0, currentOffset - currentViewHeight))
        }
    }, []) // Empty deps - all values accessed via refs

    useInput(handleInput, inputActive)

    const statusLine = state.activeTab === "console"
        ? `${state.status} | Console ${state.consoleSessionActive ? "connected" : "disconnected"} | Input ${state.consoleInputMode ? "on" : "off"}`
        : state.status
    const controlsLine = state.activeTab === "console"
        ? "Tabs: Left/Right | Scroll: Up/Down, PgUp/PgDn | Input: Enter | Exit Input: Ctrl+J | Clear: C | Quit: Q"
        : "Tabs: Left/Right | Scroll: Up/Down, PgUp/PgDn | Clear: C | Quit: Q"

    return (
        <Box flexDirection="column" height={rows}>
            <Box backgroundColor="black" paddingX={1} height={1} flexShrink={0} justifyContent="center">
                <Text color="white" bold>Strux CLI v{STRUX_VERSION}</Text>
            </Box>
            <Box backgroundColor="blue" paddingX={1} height={1} flexShrink={0}>
                {state.tabs.map((tab) => (
                    <Box key={tab.id} marginRight={1}>
                        <Text
                            backgroundColor={state.activeTab === tab.id ? "white" : "blue"}
                            color={state.activeTab === tab.id ? "black" : "white"}
                        >
                            {` ${tab.label} `}
                        </Text>
                    </Box>
                ))}
            </Box>
            <Box height={1} flexShrink={0} />
            <Box flexDirection="column" height={viewHeight + (spinnerVisible ? 1 : 0)} flexGrow={1}>
                {activeLogs.map((line, index) => (
                    <Text key={`${index}-${line}`}>{line}</Text>
                ))}
                {state.activeTab === "build" && state.spinnerLine ? (
                    <Text color="cyanBright">{state.spinnerLine}</Text>
                ) : null}
            </Box>
            <Box height={1} flexShrink={0} />
            <Box backgroundColor="gray" paddingX={1} height={2} flexShrink={0} flexDirection="column">
                <Text color="black">{statusLine}</Text>
                <Text color="black">{controlsLine}</Text>
            </Box>
        </Box>
    )
}

export class DevUI {
    private store: DevUIStore
    private unmount: (() => void) | null = null
    private mounted = false
    private options: DevUIOptions

    constructor(options: DevUIOptions) {
        const initialStatus = options.initialStatus ?? "Starting dev session..."
        this.store = new DevUIStore(initialStatus)
        this.options = options

        this.mount()
    }

    private mount(): void {
        if (this.mounted) return
        const instance = render(
            <DevApp store={this.store} onExit={this.options.onExit} onConsoleInput={this.options.onConsoleInput} />
        )
        this.unmount = instance.unmount
        this.mounted = true
    }

    public setStatus(text: string): void {
        this.store.setStatus(text)
    }

    public setConsoleSessionActive(active: boolean): void {
        this.store.setConsoleSessionActive(active)
    }

    public setConsoleInputMode(active: boolean): void {
        this.store.setConsoleInputMode(active)
    }

    public setQemuTabLabel(label: string): void {
        this.store.setQemuTabLabel(label)
    }

    public appendLog(tabId: TabId, line: string): void {
        this.store.appendLog(tabId, line)
    }

    public appendConsoleChunk(chunk: string): void {
        this.store.appendConsoleChunk(chunk)
    }

    public setSpinnerLine(line: string): void {
        this.store.setSpinnerLine(line)
    }

    public suspend(): void {
        if (!this.mounted) return
        this.unmount?.()
        this.unmount = null
        this.mounted = false
    }

    public resume(): void {
        this.mount()
    }

    public destroy(): void {
        this.suspend()
    }
}
