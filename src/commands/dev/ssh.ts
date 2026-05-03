/***
 *
 *
 * SSH Session Manager
 *
 *
 */
import { Logger } from "../../utils/log"
import type { DevServer } from "./index"


interface SSHSession {
    id: string
    onOutput?: (data: string) => void
    onExit?: (code: number) => void
}


/** Capped scrollback of raw PTY bytes for reattach (same stream whether TUI is attached or not). */
const MAX_SESSION_SCROLLBACK = 512 * 1024


export class SSHManager {

    private dev: () => DevServer
    private sessions = new Map<string, SSHSession>()
    private sessionScrollback = new Map<string, string>()
    private sessionCounter = 0
    private onSessionsChanged?: () => void


    constructor(getDevServer: () => DevServer, onSessionsChanged?: () => void) {

        this.dev = getDevServer
        this.onSessionsChanged = onSessionsChanged

    }


    // Start a new SSH session on the device (only when no session is already tracked)
    start(shell = "/bin/bash", rows?: number, cols?: number): string {

        const client = this.dev().sockets.get("client")

        if (!client.hasClients()) {

            Logger.warning("No device connected, cannot start SSH session")
            return ""

        }

        if (this.sessions.size > 0) {

            Logger.warning("An SSH session is already active — press s in the TUI to attach")
            return ""

        }

        const sessionID = `ssh-${++this.sessionCounter}-${Date.now()}`
        this.sessions.set(sessionID, { id: sessionID })

        client.broadcast({ type: "ssh-start", payload: { sessionID, shell, rows, cols } })
        Logger.info(`SSH session started: ${sessionID}`)

        return sessionID

    }


    /** Stop forwarding to TUI; keep device PTY alive. Buffered output is replayed on attach. */
    detach(sessionID: string): void {

        const session = this.sessions.get(sessionID)
        if (!session) return

        session.onOutput = undefined
        session.onExit = undefined
        this.onSessionsChanged?.()

    }


    /** Wire TUI callbacks to an existing session (new start or reattach after detach). */
    attach(sessionID: string, callbacks: { onOutput: (data: string) => void, onExit: (code: number) => void }): boolean {

        const session = this.sessions.get(sessionID)
        if (!session) return false

        session.onOutput = callbacks.onOutput
        session.onExit = callbacks.onExit
        this.onSessionsChanged?.()
        return true

    }


    /** Full scrollback for this session (for xterm replay on attach / reattach). Not cleared on read. */
    getScrollback(sessionID: string): string {

        return this.sessionScrollback.get(sessionID) ?? ""

    }


    // Resize an SSH session's PTY
    resize(sessionID: string, rows: number, cols: number): void {

        const session = this.sessions.get(sessionID)
        if (!session) return

        const client = this.dev().sockets.get("client")
        client.broadcast({ type: "ssh-resize", payload: { sessionID, rows, cols } })

    }


    // Send input to an SSH session
    sendInput(sessionID: string, data: string): void {

        const session = this.sessions.get(sessionID)
        if (!session) return

        const client = this.dev().sockets.get("client")
        client.broadcast({ type: "ssh-input", payload: { sessionID, data } })

    }


    // End an SSH session
    end(sessionID: string): void {

        const session = this.sessions.get(sessionID)
        if (!session) return

        const client = this.dev().sockets.get("client")
        client.broadcast({ type: "ssh-exit", payload: { sessionID } })

        this.sessions.delete(sessionID)
        this.sessionScrollback.delete(sessionID)
        this.onSessionsChanged?.()

    }


    /** Close every tracked session (e.g. dev server shutdown). */
    endAll(): void {

        const ids = [...this.sessions.keys()]
        for (const id of ids) {
            this.end(id)
        }

    }


    /** Drop all sessions without messaging the device (e.g. device disconnected / rebooted). */
    clearAll(): void {

        for (const session of this.sessions.values()) {
            session.onExit?.(-1)
        }
        this.sessions.clear()
        this.sessionScrollback.clear()
        this.onSessionsChanged?.()

    }


    private appendScrollback(sessionID: string, data: string): void {

        let buf = (this.sessionScrollback.get(sessionID) ?? "") + data
        if (buf.length > MAX_SESSION_SCROLLBACK) {
            buf = buf.slice(buf.length - MAX_SESSION_SCROLLBACK)
        }
        this.sessionScrollback.set(sessionID, buf)

    }


    // Called by client handler when device sends output
    handleOutput(sessionID: string, data: string): void {

        const session = this.sessions.get(sessionID)
        if (!session) return

        this.appendScrollback(sessionID, data)

        if (session.onOutput) {
            session.onOutput(data)
        }

    }


    // Called by client handler when device reports exit
    handleExit(sessionID: string, code: number): void {

        const session = this.sessions.get(sessionID)
        session?.onExit?.(code)
        this.sessions.delete(sessionID)
        this.sessionScrollback.delete(sessionID)
        this.onSessionsChanged?.()

    }


    // Get active session IDs
    getActiveSessions(): string[] {

        return [...this.sessions.keys()]

    }

}
