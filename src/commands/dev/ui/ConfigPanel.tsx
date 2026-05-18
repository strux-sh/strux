/***
 *
 *
 * Config Panel — Navigable configuration menu
 *
 * Renders directly to stdout like LogView and TerminalView.
 *
 */
import React, { useEffect, useRef } from "react"
import { Box, useInput, useStdout } from "ink"
import { theme } from "./theme"


export type ConfigAction = "restore" | "rebuild-transfer" | "rebuild-builder" | "install-update" | "restart-service" | "reboot" | "flash"


interface ConfigSection {
    title: string
    items: { label: string, action: ConfigAction }[]
}


const CONFIG_SECTIONS: ConfigSection[] = [
    {
        title: "Strux Component Management",
        items: [
            { label: "Restore Strux Artifacts to Built-in Version", action: "restore" },
            { label: "Rebuild Strux Components and Transfer To Device", action: "rebuild-transfer" },
            { label: "Rebuild Strux-Builder Docker Image", action: "rebuild-builder" },
            { label: "Install Latest System Update Bundle", action: "install-update" },
        ],
    },
    {
        title: "System Tools",
        items: [
            { label: "Flash Device", action: "flash" },
            { label: "Restart Strux Service", action: "restart-service" },
            { label: "Reboot System", action: "reboot" },
        ],
    },
]

function getConfigSections(canFlash: boolean): ConfigSection[] {
    return CONFIG_SECTIONS.map((section) => ({
        ...section,
        items: section.items.filter((item) => canFlash || item.action !== "flash"),
    })).filter((section) => section.items.length > 0)
}


const moveCursor = (row: number, col: number) => `\x1b[${row};${col}H`
const resetStyle = "\x1b[0m"


interface ConfigPanelProps {
    focused: boolean
    busy: boolean
    successMessage?: string
    canFlash: boolean
    onAction: (action: ConfigAction) => void
    onClose: () => void
    height?: number
    width?: number
    rowOffset?: number
    colOffset?: number
}


export function ConfigPanel({ focused, busy, successMessage, canFlash, onAction, onClose, height, width, rowOffset, colOffset }: ConfigPanelProps) {

    const viewHeight = height ?? 20
    const viewWidth = width ?? 80
    const row = rowOffset ?? 5
    const col = colOffset ?? 33

    const selectedIndexRef = useRef(0)
    const mountedRef = useRef(true)
    const busyRef = useRef(busy)
    const successRef = useRef(successMessage)
    const canFlashRef = useRef(canFlash)
    const { stdout } = useStdout()

    busyRef.current = busy
    successRef.current = successMessage
    canFlashRef.current = canFlash


    const writeToStdout = (data: string) => {
        if (stdout) stdout.write(data)
        else process.stdout.write(data)
    }


    useInput((input, key) => {

        if (!focused || busyRef.current) return

        if (key.upArrow || input === "k") {
            selectedIndexRef.current = Math.max(0, selectedIndexRef.current - 1)
            return
        }

        const menuItems = getConfigSections(canFlashRef.current).flatMap((s) => s.items)

        if (key.downArrow || input === "j") {
            selectedIndexRef.current = Math.min(menuItems.length - 1, selectedIndexRef.current + 1)
            return
        }

        if (key.return) {
            const item = menuItems[selectedIndexRef.current]
            if (item) onAction(item.action)
            return
        }

    })


    const renderFrame = () => {

        if (!mountedRef.current) return

        const sections = getConfigSections(canFlashRef.current)
        const menuItems = sections.flatMap((s) => s.items)
        selectedIndexRef.current = Math.min(selectedIndexRef.current, Math.max(0, menuItems.length - 1))
        const selected = selectedIndexRef.current
        let output = "\x1b[?25l"
        let y = 0

        const writeLine = (text: string, color?: string) => {
            if (y >= viewHeight) return
            const padded = text.length < viewWidth
                ? text + " ".repeat(viewWidth - text.length)
                : text.slice(0, viewWidth)
            output += moveCursor(row + y, col)
            if (color) output += color
            output += padded + resetStyle
            y++
        }

        // Title
        writeLine("Configuration", "\x1b[1;38;2;124;124;255m") // bold periwinkle
        writeLine("")

        let globalIndex = 0

        for (const section of sections) {

            // Section title
            writeLine(section.title, "\x1b[1;90m") // bold gray

            for (const item of section.items) {

                const idx = globalIndex++
                const isSelected = idx === selected
                const marker = isSelected ? "▸" : " "
                const color = isSelected ? "\x1b[1;37m" : "\x1b[90m" // bold white or gray
                const markerColor = isSelected ? "\x1b[38;2;124;124;255m" : "\x1b[90m" // periwinkle or gray

                const line = `${marker} ${item.label}`
                if (y < viewHeight) {
                    output += moveCursor(row + y, col)
                    output += markerColor + marker + " " + color + item.label
                    const visLen = 2 + item.label.length
                    if (visLen < viewWidth) output += " ".repeat(viewWidth - visLen)
                    output += resetStyle
                    y++
                }

            }

            writeLine("") // gap between sections

        }

        // Status messages
        if (busyRef.current) {
            writeLine("Running...", "\x1b[33m") // yellow
        }

        if (successRef.current) {
            writeLine(successRef.current, "\x1b[32m") // green
        }

        // Clear remaining lines
        while (y < viewHeight) {
            output += moveCursor(row + y, col) + " ".repeat(viewWidth)
            y++
        }

        writeToStdout(output)

    }


    useEffect(() => {

        mountedRef.current = true

        const repaintInterval = setInterval(() => renderFrame(), 100)
        const initTimer = setTimeout(() => renderFrame(), 100)

        return () => {
            mountedRef.current = false
            clearInterval(repaintInterval)
            clearTimeout(initTimer)

            // Clear area
            let clear = ""
            for (let y = 0; y < viewHeight; y++) {
                clear += moveCursor(row + y, col) + "\x1b[K"
            }
            clear += "\x1b[?25l"
            writeToStdout(clear)
        }

    }, [viewHeight, viewWidth, row, col])


    // Ink placeholder
    return (
        <Box
            flexDirection="column"
            flexGrow={1}
            height={viewHeight}
            width={viewWidth}
        />
    )

}
