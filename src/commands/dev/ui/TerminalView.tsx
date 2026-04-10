/***
 *
 *
 * Terminal View — Full terminal emulator using xterm-headless
 *
 * Bypasses Ink's renderer for performance. Writes directly to stdout
 * using ANSI cursor positioning. The round frame is drawn here (not by Ink)
 * so it stays consistent with the buffer paint. Each buffer cell uses
 * xterm getWidth() so wide glyphs do not spill past the inner rectangle.
 *
 */
import React, { useEffect, useRef } from "react"
import cliBoxes from "cli-boxes"
import { Box, useStdout, useStdin, type DOMElement } from "ink"
import { Terminal } from "@xterm/headless"
import { theme } from "./theme"
import type { TUIStore } from "./store"


// ANSI helpers
const moveCursor = (row: number, col: number) => `\x1b[${row};${col}H`
const resetStyle = "\x1b[0m"

function cellToAnsi(fg: number, fgRGB: boolean, fgDefault: boolean, bg: number, bgRGB: boolean, bgDefault: boolean, bold: boolean, dim: boolean, italic: boolean, underline: boolean, inverse: boolean): string {
    let s = resetStyle
    if (!fgDefault) {
        if (fgRGB) {
            const r = (fg >> 16) & 0xff, g = (fg >> 8) & 0xff, b = fg & 0xff
            s += `\x1b[38;2;${r};${g};${b}m`
        } else if (fg <= 7) s += `\x1b[${30 + fg}m`
        else if (fg <= 15) s += `\x1b[${90 + fg - 8}m`
        else if (fg <= 255) s += `\x1b[38;5;${fg}m`
    }
    if (!bgDefault) {
        if (bgRGB) {
            const r = (bg >> 16) & 0xff, g = (bg >> 8) & 0xff, b = bg & 0xff
            s += `\x1b[48;2;${r};${g};${b}m`
        } else if (bg <= 7) s += `\x1b[${40 + bg}m`
        else if (bg <= 15) s += `\x1b[${100 + bg - 8}m`
        else if (bg <= 255) s += `\x1b[48;5;${bg}m`
    }
    if (bold) s += "\x1b[1m"
    if (dim) s += "\x1b[2m"
    if (italic) s += "\x1b[3m"
    if (underline) s += "\x1b[4m"
    if (inverse) s += "\x1b[7m"
    return s
}


/** Cumulative (x, y) of this ink-box in root coordinates — same basis as `renderBorder(x, y, …)`. */
function inkAbsoluteOrigin(node: DOMElement): { x: number, y: number } {

    let x = 0
    let y = 0
    let current: DOMElement | undefined = node

    while (current) {
        const yn = current.yogaNode
        if (yn) {
            x += Math.round(yn.getComputedLeft())
            y += Math.round(yn.getComputedTop())
        }
        current = current.parentNode
    }

    return { x, y }

}


/** Foreground ANSI for border — mirrors Ink borderColor (primary vs muted). */
function borderFgAnsi(focused: boolean): string {

    if (focused) {
        const c = theme.colors.primary
        const m = /^#([0-9a-f]{6})$/i.exec(c)
        if (m?.[1]) {
            const n = parseInt(m[1], 16)
            const r = (n >> 16) & 255
            const g = (n >> 8) & 255
            const b = n & 255
            return `\x1b[38;2;${r};${g};${b}m`
        }
    }

    return "\x1b[90m"

}


/** 0-based top-left (x0,y0) of outer frame; inner size cols×rows (same chars as Ink `round`). */
function ansiRoundBorder(
    x0: number,
    y0: number,
    innerCols: number,
    innerRows: number,
    focused: boolean
): string {

    const fg = borderFgAnsi(focused)
    const box = cliBoxes.round
    let out = ""

    const topLine = box.topLeft + box.top.repeat(innerCols) + box.topRight
    out += moveCursor(y0 + 1, x0 + 1) + fg + topLine + resetStyle

    for (let r = 0; r < innerRows; r++) {
        const ansiRow = y0 + r + 2
        out += moveCursor(ansiRow, x0 + 1) + fg + box.left + resetStyle
        out += moveCursor(ansiRow, x0 + innerCols + 2) + fg + box.right + resetStyle
    }

    const botLine = box.bottomLeft + box.bottom.repeat(innerCols) + box.bottomRight
    out += moveCursor(y0 + innerRows + 2, x0 + 1) + fg + botLine + resetStyle

    return out

}


interface TerminalViewProps {
    store: TUIStore
    focused: boolean
    rows?: number
    cols?: number
    /** Prefer live server scrollback on every replay (reattach + resize). */
    getScrollback?: () => string
    /** Fallback when `getScrollback` is omitted (tests). */
    initialReplay?: string
    /** 1-based stdout row for the first interior terminal line (inside the Ink border). */
    rowOffset?: number
    /** 1-based stdout column for the first interior cell (inside the Ink border). */
    colOffset?: number
    onInput: (data: string) => void
    /** Detach the SSH session and return to the TUI. Triggered by the dedicated detach byte (Ctrl-\). */
    onDetach?: () => void
}


/**
 * Byte we watch for in the stdin stream to leave SSH. Ctrl-\ (0x1c, "FS" — file separator).
 * Explicitly NOT a newline — those are Ctrl-J (0x0a, LF) and Ctrl-M (0x0d, CR). 0x1c is not bound
 * by bash readline, zsh, vim, tmux, screen, less, or man. In cooked tty mode it would raise SIGQUIT
 * via VQUIT, but Ink puts stdin in raw mode (ISIG disabled) so it arrives as a plain byte, which
 * we intercept before it ever reaches the remote PTY. As a single byte there is no chord, no timer,
 * no buffering, no CSI disambiguation, no interaction with readline's `keyseq-timeout`, no vim lag.
 */
const DETACH_BYTE = 0x1c


/**
 * Rewrite host-terminal cursor/navigation keys from CSI form (ESC [ A) to SS3 form (ESC O A)
 * when the remote PTY has DECCKM enabled. Full-screen ncurses apps like htop, less, and vim
 * call `tput smkx`, which under xterm-256color terminfo declares kcuu1=\EOA etc. — so a bare
 * ESC [ A never matches any key binding and arrow navigation silently breaks. Host terminals
 * (Terminal.app, iTerm, Ghostty, etc.) always emit CSI arrows regardless of what mode the
 * remote is in, so we have to translate on the fly based on xterm-headless's tracked mode.
 */
function rewriteCursorKeys(s: string, applicationMode: boolean): string {

    if (!applicationMode || s.length < 3) return s
    if (s.indexOf("\x1b[") === -1) return s

    let out = ""
    let i = 0
    while (i < s.length) {
        if (i + 2 < s.length && s.charCodeAt(i) === 0x1b && s.charCodeAt(i + 1) === 0x5b) {
            const c = s.charCodeAt(i + 2)
            // A B C D = arrows; H F = Home/End
            if (c === 0x41 || c === 0x42 || c === 0x43 || c === 0x44 || c === 0x48 || c === 0x46) {
                out += "\x1bO" + s[i + 2]
                i += 3
                continue
            }
        }
        out += s[i]
        i++
    }
    return out

}


export function TerminalView({ store, focused, rows = 24, cols = 80, getScrollback, initialReplay = "", rowOffset = 6, colOffset = 30, onInput, onDetach }: TerminalViewProps) {

    const termRef = useRef<Terminal | null>(null)
    const boxRef = useRef<DOMElement | null>(null)
    const cursorVisibleRef = useRef(true)
    const offsetRef = useRef<{ row: number, col: number }>({ row: rowOffset, col: colOffset })
    const lastPaintRef = useRef<{
        row: number
        col: number
        paintRows: number
        paintCols: number
        frame: { x0: number, y0: number, outerW: number, outerH: number } | null
    }>({
        row: rowOffset,
        col: colOffset,
        paintRows: rows,
        paintCols: cols,
        frame: null,
    })
    const mountedRef = useRef(true)
    const focusedRef = useRef(focused)
    focusedRef.current = focused
    const getScrollbackRef = useRef(getScrollback)
    getScrollbackRef.current = getScrollback
    const { stdout } = useStdout()
    const { internal_eventEmitter: stdinInputBus } = useStdin()


    // Direct stdout write — bypasses Ink
    const writeToStdout = (data: string) => {

        if (stdout) {
            stdout.write(data)
        } else {
            process.stdout.write(data)
        }

    }


    // Render the terminal buffer to the host TTY — one line at a time, no EL (\x1b[K])
    const renderFrame = () => {

        const term = termRef.current
        if (!term || !mountedRef.current) return

        const buf = term.buffer.active
        const cx = buf.cursorX
        const cy = buf.cursorY
        const showCursor = cursorVisibleRef.current

        const boxEl = boxRef.current
        let rowOff = rowOffset
        let colOff = colOffset
        let paintRows = rows
        let paintCols = cols

        let frame: { x0: number, y0: number, outerW: number, outerH: number } | null = null

        if (boxEl?.yogaNode) {
            const { x, y } = inkAbsoluteOrigin(boxEl)
            // Placeholder Box is (cols+2)×(rows+2) with no Ink border — inner cells start at (x+1,y+1) 0-based.
            rowOff = y + 2
            colOff = x + 2
            paintRows = rows
            paintCols = cols
            frame = { x0: x, y0: y, outerW: cols + 2, outerH: rows + 2 }
        }

        offsetRef.current = { row: rowOff, col: colOff }
        lastPaintRef.current = { row: rowOff, col: colOff, paintRows, paintCols, frame }

        let output = "\x1b[?25l"

        if (frame) {
            output += ansiRoundBorder(frame.x0, frame.y0, cols, rows, focusedRef.current)
        }

        for (let y = 0; y < paintRows; y++) {

            const line = buf.getLine(y)
            if (!line) continue

            // Move to line start; then append cells in order (host cursor advances per char width).
            output += moveCursor(rowOff + y, colOff)

            let x = 0
            while (x < paintCols) {

                const cell = line.getCell(x)
                if (!cell) {
                    output += resetStyle + " "
                    x++
                    continue
                }

                const cw = cell.getWidth()
                if (cw === 0) {
                    x++
                    continue
                }

                if (x + cw > paintCols) {
                    output += resetStyle + " ".repeat(paintCols - x)
                    break
                }


                const char = cell.getChars() || " "
                const isCursor = x === cx && y === cy

                const fg = cell.getFgColor()
                const fgRGB = cell.isFgRGB()
                const fgDefault = cell.isFgDefault()
                const bg = cell.getBgColor()
                const bgRGB = cell.isBgRGB()
                const bgDefault = cell.isBgDefault()
                const bold = !!cell.isBold()
                const dim = !!cell.isDim()
                const italic = !!cell.isItalic()
                const underline = !!cell.isUnderline()
                const inverse = !!cell.isInverse() || (isCursor && showCursor)

                output += cellToAnsi(fg, fgRGB, fgDefault, bg, bgRGB, bgDefault, bold, dim, italic, underline, inverse)
                output += char
                x += cw

            }

            output += resetStyle

        }

        writeToStdout(output)

    }


    // Initialize terminal
    useEffect(() => {

        const term = new Terminal({
            rows,
            cols,
            allowProposedApi: true,
            scrollback: 0,
        })

        termRef.current = term

        // ~30fps coalescing for bursts; first chunk in each window paints immediately so the prompt appears without lagging every line.
        let renderTimer: ReturnType<typeof setTimeout> | null = null
        const scheduleRender = () => {
            // eslint-disable-next-line
            if (!renderTimer) {

                renderTimer = setTimeout(() => {
                    renderTimer = null
                    renderFrame()
                }, 33)
            }
        }

        const afterWrite = () => {
            if (!renderTimer) {
                renderFrame()
            }
            scheduleRender()
        }

        store.setTerminalWriteCallback((data: string) => {
            term.write(data, afterWrite)
        })

        // Bytes may hit scrollback before this callback existed (session attached before Terminal mounted).
        const pending = getScrollbackRef.current?.() ?? initialReplay
        if (pending.length > 0) {
            term.write(pending, () => {
                setTimeout(() => {
                    if (termRef.current === term) {
                        renderFrame()
                    }
                }, 0)
            })
        }

        // First paint only after Ink has laid out the bordered box; the 100ms loop used to fire before that.
        const FIRST_RENDER_DELAY_MS = 500
        let repaintInterval: ReturnType<typeof setInterval> | null = null
        const initTimer = setTimeout(() => {
            renderFrame()
            repaintInterval = setInterval(() => {
                renderFrame()
            }, 100)
        }, FIRST_RENDER_DELAY_MS)

        return () => {
            clearTimeout(initTimer)
            if (repaintInterval) clearInterval(repaintInterval)
            if (renderTimer) clearTimeout(renderTimer)
            store.setTerminalWriteCallback(null)
            term.dispose()
            termRef.current = null
        }

    }, [rows, cols, store, initialReplay])


    // Cursor blink — just toggle the ref, repaint interval handles rendering
    useEffect(() => {

        if (!focused) {
            cursorVisibleRef.current = false
            return
        }

        cursorVisibleRef.current = true

        const interval = setInterval(() => {
            cursorVisibleRef.current = !cursorVisibleRef.current
        }, 530)

        return () => clearInterval(interval)

    }, [focused])


    // Hide system cursor while mounted, clear area on unmount
    useEffect(() => {

        mountedRef.current = true
        writeToStdout("\x1b[?25l") // Hide system cursor

        return () => {
            mountedRef.current = false
            const { row: rowOff, col: colOff, paintRows: pr, paintCols: pc, frame } = lastPaintRef.current
            let clear = ""
            if (frame) {
                const { x0, y0, outerW, outerH } = frame
                for (let ry = 0; ry < outerH; ry++) {
                    clear += moveCursor(y0 + 1 + ry, x0 + 1) + resetStyle + " ".repeat(outerW)
                }
            } else {
                const blank = " ".repeat(pc)
                for (let y = 0; y < pr; y++) {
                    clear += moveCursor(rowOff + y, colOff) + resetStyle + blank
                }
            }
            clear += "\x1b[?25l"
            writeToStdout(clear)
        }

    }, [rows, cols])


    // Raw stdin passthrough — same byte stream Ink uses. Ink reads process.stdin via `readable` +
    // read(), not `data`; a separate stdin `data` listener often misses input and breaks arrows /
    // ncurses. We subscribe to Ink's internal `input` bus (emitted right after each read).
    //
    // The rule is dead simple: scan each chunk for DETACH_BYTE (Ctrl-], 0x1d). If present, forward
    // everything up to it verbatim and trigger detach. The detach byte itself is never sent to the
    // remote. Everything else — CSI/SS3, bare Esc, UTF-8 multibyte, Meta combos, NUL bytes, raw
    // binary — is passed through unmodified. No parsing, no buffering, no timers, no state. This
    // makes the hot path O(n) and impossible to mis-trigger.
    useEffect(() => {

        if (!focused) return

        const chunkToString = (chunk: unknown): string => {
            if (typeof chunk === "string") return chunk
            if (Buffer.isBuffer(chunk)) return chunk.toString("utf8")
            return String(chunk)
        }

        const onInputChunk = (chunk: unknown) => {

            const s = chunkToString(chunk)
            if (s.length === 0) return

            // Fast path: no detach byte in this chunk. Forward everything as-is.
            let idx = -1
            for (let i = 0; i < s.length; i++) {
                if (s.charCodeAt(i) === DETACH_BYTE) { idx = i; break }
            }
            const appMode = termRef.current?.modes.applicationCursorKeysMode ?? false

            if (idx === -1) {
                onInput(rewriteCursorKeys(s, appMode))
                return
            }

            // Forward anything that came before the detach byte, then leave the session.
            // Bytes after the detach byte are discarded — we're tearing down the view anyway.
            if (idx > 0) {
                onInput(rewriteCursorKeys(s.slice(0, idx), appMode))
            }
            onDetach?.()

        }

        stdinInputBus.on("input", onInputChunk)

        return () => {
            stdinInputBus.off("input", onInputChunk)
        }

    }, [focused, onInput, onDetach, stdinInputBus])


    // Ink only reserves (cols+2)×(rows+2); round border is drawn in ansiRoundBorder + renderFrame.
    return (
        <Box
            ref={boxRef}
            flexDirection="column"
            width={cols + 2}
            height={rows + 2}
        >
        </Box>
    )

}
