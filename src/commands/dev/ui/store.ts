/***
 *
 *
 * TUI Store — Shared state between DevServer and the TUI
 *
 *
 */
import type { ResourceName } from "./App"
import type { LogEntry } from "./LogView"
import type { ResourceStatus } from "./theme"


export class TUIStore {

    private listeners = new Set<() => void>()
    private notifyTimer: ReturnType<typeof setTimeout> | null = null
    private lastNotify = 0

    // Incremented on every mutation so useSyncExternalStore detects changes
    version = 0

    logs: Record<ResourceName, LogEntry[]> = {
        "device": [],
        "device:app": [],
        "device:cage": [],
        "device:system": [],
        "device:early": [],
        "device:screen": [],
        "device:client": [],
        "vite": [],
        "qemu": [],
        "watcher": [],
        "screen": [],
    }

    statuses: Record<ResourceName, ResourceStatus> = {
        "device": "disconnected",
        "device:app": "idle",
        "device:cage": "idle",
        "device:system": "idle",
        "device:early": "idle",
        "device:screen": "idle",
        "device:client": "idle",
        "vite": "stopped",
        "qemu": "stopped",
        "watcher": "idle",
        "screen": "stopped",
    }

    deviceIP: string | undefined = undefined
    deviceVersion: string | undefined = undefined
    inspectorPorts: { path: string, port: number }[] = []
    deviceOutputs: { name: string, label?: string }[] = []
    buildStatus = "idle"
    bspName = "qemu"
    projectRoot = ""
    changedFiles = new Map<string, number>()

    // SSH terminal — attached session shown in TerminalView; sshSessionIds includes detached PTYs too
    sshSessionID: string | null = null
    sshSessionIds: string[] = []
    private terminalWriteCallback: ((data: string) => void) | null = null

    // Config panel
    configBusy = false
    configSuccessMessage = ""


    subscribe(listener: () => void): () => void {

        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }

    }


    private notify(): void {

        this.version++

        // Throttle re-renders to max ~10fps (100ms) to handle log floods
        const now = Date.now()
        const elapsed = now - this.lastNotify

        if (elapsed >= 100) {
            // Enough time has passed, notify immediately
            this.lastNotify = now
            if (this.notifyTimer) {
                clearTimeout(this.notifyTimer)
                this.notifyTimer = null
            }
            this.listeners.forEach((l) => l())
        } else if (!this.notifyTimer) {
            // Schedule a notification for the remaining time
            this.notifyTimer = setTimeout(() => {
                this.notifyTimer = null
                this.lastNotify = Date.now()
                this.listeners.forEach((l) => l())
            }, 100 - elapsed)
        }

    }


    appendLog(resource: ResourceName, entry: LogEntry): void {

        // Split multiline messages into separate entries, skip empty lines
        const lines = entry.message.split("\n")

        if (lines.length <= 1) {
            this.logs[resource].push(entry)
        } else {
            let first = true
            for (const line of lines) {
                if (line.trim()) {
                    this.logs[resource].push({
                        ...entry,
                        message: line,
                        formatted: undefined,
                        continuation: !first,
                    })
                    first = false
                }
            }
        }

        // Don't call notify() — log appends are rendered directly to stdout
        // by LogView's repaint interval, not through Ink's React renderer.
        this.version++

    }


    updateStatus(resource: ResourceName, status: ResourceStatus): void {

        this.statuses = { ...this.statuses, [resource]: status }
        this.notify()

    }


    setDeviceIP(ip: string | undefined): void {

        this.deviceIP = ip
        this.notify()

    }


    setDeviceInfo(info: { ip: string, inspectorPorts: { path: string, port: number }[], outputs?: { name: string, label?: string }[], version?: string }): void {

        this.deviceIP = info.ip
        this.deviceVersion = info.version
        this.inspectorPorts = info.inspectorPorts
        this.deviceOutputs = info.outputs ?? []
        this.notify()

    }


    setBuildStatus(status: string): void {

        this.buildStatus = status
        this.notify()

    }


    setBspName(name: string): void {

        this.bspName = name
        this.notify()

    }


    markFileChanged(filePath: string): void {

        this.changedFiles.set(filePath, Date.now())
        this.version++

    }


    // SSH terminal methods

    setSSHSession(sessionID: string | null): void {

        this.sshSessionID = sessionID
        this.notify()

    }


    setSSHSessionIds(ids: string[]): void {

        this.sshSessionIds = ids
        this.notify()

    }


    setTerminalWriteCallback(cb: ((data: string) => void) | null): void {

        this.terminalWriteCallback = cb

    }


    writeToTerminal(data: string): void {

        this.terminalWriteCallback?.(data)

    }


    // Config panel methods

    setConfigBusy(busy: boolean): void {

        this.configBusy = busy
        this.notify()

    }


    flashConfigSuccess(message: string, durationMs = 3000): void {

        this.configSuccessMessage = message
        this.notify()

        setTimeout(() => {
            this.configSuccessMessage = ""
            this.notify()
        }, durationMs)

    }

}
