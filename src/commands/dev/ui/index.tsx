/***
 *
 *
 * TUI Entry Point — Renders the app and exposes controls
 *
 *
 */
import { render } from "ink"
import { App } from "./App"
import { TUIStore } from "./store"


import type { ConfigAction } from "./ConfigPanel"

/** Restore host TTY after Ink + direct stdout (LogView/SSH). Avoids stray SGR/charset modes (Tabby, etc.). */
function writeHostTerminalRestore(): void {

    process.stdout.write("\x1b[0m")    // SGR reset
    process.stdout.write("\x1b[?25h") // show cursor
    process.stdout.write("\x1b[?1049l") // leave alternate screen
    // DECSTR — soft reset: character sets, many private modes; does not clear scrollback like RIS (ESC c)
    process.stdout.write("\x1b[!p")

}

interface DevUIOptions {
    onExit: () => void
    onSSHStart: (rows: number, cols: number) => string
    /** Detach TUI from PTY; session stays on device. */
    onSSHDetach: (sessionID: string) => void
    /** Reattach to an existing session; returns bytes to replay into xterm. */
    onSSHAttach: (sessionID: string, rows: number, cols: number) => string
    /** Current raw scrollback for an active session (e.g. after resize, always fetch fresh). */
    onSSHGetScrollback: (sessionID: string) => string
    onSSHInput: (sessionID: string, data: string) => void
    onSSHResize: (sessionID: string, rows: number, cols: number) => void
    onConfigAction: (action: ConfigAction) => void
    onWatcherTogglePause: () => boolean  // returns new paused state
}


export class DevUI {

    private inkInstance: ReturnType<typeof render> | null = null
    readonly store = new TUIStore()


    start(opts: DevUIOptions): void {

        // Enter alternate screen buffer for fullscreen TUI
        process.stdout.write("\x1b[?1049h")
        process.stdout.write("\x1b[?25l") // Hide cursor (Ink manages its own)

        let inkRef: ReturnType<typeof render> | null = null
        inkRef = render(
            <App
                store={this.store}
                onExit={opts.onExit}
                onSSHStart={opts.onSSHStart}
                onSSHDetach={opts.onSSHDetach}
                onSSHAttach={opts.onSSHAttach}
                onSSHGetScrollback={opts.onSSHGetScrollback}
                onSSHInput={opts.onSSHInput}
                onSSHResize={opts.onSSHResize}
                onConfigAction={opts.onConfigAction}
                onWatcherTogglePause={opts.onWatcherTogglePause}
                afterInkReset={() => {
                    // Ink's line buffer only knows about its own output; TerminalView / ConfigPanel
                    // may paint with absolute cursor moves. clear() resets Ink's log state, then we
                    // wipe the alternate screen so the next Ink frame repaints borders + layout correctly.
                    inkRef?.clear()
                    process.stdout.write("\x1b[2J\x1b[H\x1b[0m")
                }}
            />,
            { exitOnCtrlC: false }
        )
        this.inkInstance = inkRef

    }


    stop(): void {

        this.inkInstance?.unmount()
        this.inkInstance = null

        writeHostTerminalRestore()

    }

}


// Re-export types
export { type ResourceName } from "./App"
export { type LogEntry } from "./LogView"
export { type ResourceStatus } from "./theme"
export { TUIStore } from "./store"
