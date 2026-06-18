/***
 *
 *
 * Log View — Scrollable log buffer
 *
 * Renders directly to stdout via ANSI cursor positioning,
 * bypassing Ink's renderer to avoid layout corruption.
 * All state is managed via refs to avoid triggering Ink re-renders.
 *
 */
import React, { useEffect, useRef } from "react"
import { Box, useInput, useStdout } from "ink"
export interface LogEntry {
    level: string
    message: string
    formatted?: string
    timestamp: number
    continuation?: boolean
}


const moveCursor = (row: number, col: number) => `\x1b[${row};${col}H`
const resetStyle = "\x1b[0m"


interface LogViewProps {
    logs: LogEntry[]
    focused: boolean
    filter?: string
    maxLines?: number
    height?: number
    width?: number
    rowOffset?: number
    colOffset?: number
}


export function LogView({ logs, focused, filter, maxLines = 1000, height, width, rowOffset, colOffset }: LogViewProps) {

    const viewHeight = height ?? 20
    const viewWidth = width ?? 80
    const row = rowOffset ?? 6
    const col = colOffset ?? 30

    const scrollOffsetRef = useRef(0)
    const autoScrollRef = useRef(true)
    const mountedRef = useRef(true)
    const prevLogCountRef = useRef(0)
    const { stdout } = useStdout()

    // Keep props in refs so the interval closure always has current values
    const logsRef = useRef(logs)
    const filterRef = useRef(filter)
    const focusedRef = useRef(focused)
    logsRef.current = logs
    filterRef.current = filter
    focusedRef.current = focused


    const writeToStdout = (data: string) => {
        if (stdout) stdout.write(data)
        else process.stdout.write(data)
    }


    // Keyboard navigation — updates refs, no React state
    useInput((input, key) => {

        if (!focusedRef.current) return

        const filteredLogs = filterRef.current
            ? logsRef.current.filter((l) => l.message.toLowerCase().includes(filterRef.current!.toLowerCase()))
            : logsRef.current
        const total = Math.min(filteredLogs.length, maxLines)
        const maxOffset = Math.max(0, total - viewHeight)

        if (key.upArrow || input === "k") {
            autoScrollRef.current = false
            scrollOffsetRef.current = Math.max(0, scrollOffsetRef.current - 1)
        }

        if (key.downArrow || input === "j") {
            const next = Math.min(maxOffset, scrollOffsetRef.current + 1)
            if (next >= maxOffset) autoScrollRef.current = true
            scrollOffsetRef.current = next
        }

        if (key.pageUp) {
            autoScrollRef.current = false
            scrollOffsetRef.current = Math.max(0, scrollOffsetRef.current - viewHeight)
        }

        if (key.pageDown) {
            const next = Math.min(maxOffset, scrollOffsetRef.current + viewHeight)
            if (next >= maxOffset) autoScrollRef.current = true
            scrollOffsetRef.current = next
        }

        if (input === "G") {
            scrollOffsetRef.current = maxOffset
            autoScrollRef.current = true
        }

        if (input === "g") {
            autoScrollRef.current = false
            scrollOffsetRef.current = 0
        }

    })


    // Render frame directly to stdout
    const renderFrame = () => {

        if (!mountedRef.current) return

        const currentLogs = logsRef.current
        const currentFilter = filterRef.current

        const filteredLogs = currentFilter
            ? currentLogs.filter((l) => l.message.toLowerCase().includes(currentFilter.toLowerCase()))
            : currentLogs

        const visibleLogs = filteredLogs.slice(-maxLines)

        // Auto-scroll when new logs arrive
        if (autoScrollRef.current) {
            const maxOffset = Math.max(0, visibleLogs.length - viewHeight)
            scrollOffsetRef.current = maxOffset
        }
        prevLogCountRef.current = visibleLogs.length

        const offset = scrollOffsetRef.current
        const windowLogs = visibleLogs.slice(offset, offset + viewHeight)
        const totalLines = visibleLogs.length
        const scrollPercent = totalLines <= viewHeight
            ? 100
            : Math.round((offset / Math.max(1, totalLines - viewHeight)) * 100)

        let output = "\x1b[?25l"

        for (let y = 0; y < viewHeight; y++) {

            output += moveCursor(row + y, col)

            if (y < windowLogs.length) {

                const entry = windowLogs[y]
                const msg = (entry!.message ?? "").replace(/\r/g, "")

                // Dimmed levels: raw build output, spinner
                const isDimmed = entry!.continuation === true || entry!.level === "raw" || entry!.level === "spinner" || entry!.level === "blank"

                if (isDimmed) {
                    // Build output / continuations — indented, dimmed
                    const indent = "       "
                    const available = viewWidth - indent.length
                    const truncated = msg.length <= available ? msg : msg.slice(0, available)
                    const pad = Math.max(0, available - truncated.length)

                    output += indent + "\x1b[90m" + truncated + resetStyle + " ".repeat(pad)
                } else {
                    // Logger message — show with strux prefix and level color
                    let icon = "•"
                    let iconColor = "\x1b[34m"
                    let msgColor = ""
                    switch (entry!.level) {
                        case "error":   icon = "✗"; iconColor = "\x1b[31m"; msgColor = "\x1b[31m"; break
                        case "warning": icon = "⚠"; iconColor = "\x1b[33m"; msgColor = "\x1b[33m"; break
                        case "success": icon = "✓"; iconColor = "\x1b[32m"; msgColor = "\x1b[32m"; break
                        case "debug":   icon = "○"; iconColor = "\x1b[33m"; msgColor = "\x1b[90m"; break
                        case "info":    icon = "•"; iconColor = "\x1b[34m"; break
                        case "log":     icon = "›"; iconColor = "\x1b[38;2;165;165;255m"; break
                        case "title":   icon = ""; iconColor = ""; msgColor = "\x1b[1;38;2;165;165;255m"; break
                        case "cached":  icon = "◆"; iconColor = "\x1b[35m"; break
                    }

                    const prefix = entry!.level === "title"
                        ? ""
                        : `\x1b[1;38;2;165;165;255mstrux${resetStyle} ${iconColor}${icon}${resetStyle} `
                    const prefixVisLen = entry!.level === "title" ? 0 : 8

                    const available = viewWidth - prefixVisLen
                    const truncated = msg.length <= available ? msg : msg.slice(0, available)
                    const pad = Math.max(0, available - truncated.length)

                    output += prefix + msgColor + truncated + resetStyle + " ".repeat(pad)
                }

            } else {
                output += " ".repeat(viewWidth)
            }

        }

        // Status line
        const statusLeft = autoScrollRef.current ? "FOLLOW" : `${scrollPercent}%`
        const statusRight = `${totalLines} lines`
        const statusPad = Math.max(0, viewWidth - statusLeft.length - statusRight.length)
        output += moveCursor(row + viewHeight, col)
        output += `\x1b[90m${statusRight}${" ".repeat(statusPad)}${statusLeft}${resetStyle}`

        writeToStdout(output)

    }


    // Repaint interval — sole renderer, no React involvement
    useEffect(() => {

        mountedRef.current = true

        const repaintInterval = setInterval(() => renderFrame(), 100)
        const initTimer = setTimeout(() => renderFrame(), 200)

        return () => {
            mountedRef.current = false
            clearInterval(repaintInterval)
            clearTimeout(initTimer)

            // Clear our area on unmount
            let clear = ""
            for (let y = 0; y <= viewHeight; y++) {
                clear += moveCursor(row + y, col) + "\x1b[K"
            }
            clear += "\x1b[?25l"
            writeToStdout(clear)
        }

    }, [viewHeight, viewWidth, row, col])


    // Ink placeholder — reserves the space, renders nothing
    return (
        <Box
            flexDirection="column"
            height={viewHeight + 1}
            width={viewWidth}
        />
    )

}
