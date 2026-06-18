/***
 *
 *
 * File Tree View — Live directory tree with change highlighting
 *
 * Renders directly to stdout. Shows the watched project files
 * with collapsible directories, git status, and change highlighting.
 *
 */
import React, { useEffect, useRef } from "react"
import { Box, useInput, useStdout } from "ink"
import dirTree from "directory-tree"
import { relative } from "path"
import { execSync } from "child_process"


const moveCursor = (row: number, col: number) => `\x1b[${row};${col}H`
const resetStyle = "\x1b[0m"

const TREE_ICONS = {
    branch: "\u251C\u2500\u2500 ",
    lastBranch: "\u2514\u2500\u2500 ",
    indent: "\u2502   ",
    lastIndent: "    ",
    folderOpen: "\uF07C ",    // nf-fa-folder_open
    folderClosed: "\uF07B ",  // nf-fa-folder
}

// Nerd Font file icons by extension
const FILE_ICONS: Record<string, string> = {
    ".go":   "\uE626 ",  // nf-seti-go
    ".mod":  "\uE626 ",
    ".sum":  "\uE626 ",
    ".ts":   "\uE628 ",  // nf-seti-typescript
    ".tsx":  "\uE7BA ",  // nf-dev-react
    ".js":   "\uE74E ",  // nf-dev-javascript
    ".jsx":  "\uE7BA ",
    ".json": "\uE60B ",  // nf-seti-json
    ".yaml": "\uE60B ",
    ".yml":  "\uE60B ",
    ".sh":   "\uF489 ",  // nf-oct-terminal
    ".html": "\uE736 ",  // nf-dev-html5
    ".css":  "\uE749 ",  // nf-dev-css3
    ".md":   "\uE73E ",  // nf-dev-markdown
    ".toml": "\uE615 ",  // nf-seti-config
    ".lock": "\uF023 ",  // nf-fa-lock
    ".env":  "\uF462 ",  // nf-oct-key
    ".c":    "\uE61E ",  // nf-custom-c
    ".h":    "\uE61E ",
    ".png":  "\uF1C5 ",  // nf-fa-file_image_o
    ".svg":  "\uF1C5 ",
    ".Dockerfile": "\uF308 ",  // nf-linux-docker
}

function getFileIcon(name: string): string {
    // Check full filename first (e.g. Dockerfile)
    if (FILE_ICONS["." + name]) return FILE_ICONS["." + name]!
    const ext = name.includes(".") ? "." + name.split(".").pop() : ""
    return FILE_ICONS[ext] ?? "\uF15B "  // nf-fa-file (default)
}


// Git status markers
type GitStatus = "M" | "A" | "D" | "R" | "?" | ""

interface TreeNode {
    name: string
    path: string
    isDir: boolean
    children?: TreeNode[]
    gitStatus: GitStatus
}

interface FlatEntry {
    name: string
    path: string
    isDir: boolean
    depth: number
    prefix: string
    gitStatus: GitStatus
    hasChildren: boolean
    isExpanded: boolean
}


interface FileTreeViewProps {
    projectRoot: string
    changedFiles: Map<string, number>
    focused: boolean
    height?: number
    width?: number
    rowOffset?: number
    colOffset?: number
}


export function FileTreeView({ projectRoot, changedFiles, focused, height, width, rowOffset, colOffset }: FileTreeViewProps) {

    const viewHeight = height ?? 20
    const viewWidth = width ?? 80
    const row = rowOffset ?? 9
    const col = colOffset ?? 33

    const scrollOffsetRef = useRef(0)
    const selectedIndexRef = useRef(0)
    const mountedRef = useRef(true)
    const treeRef = useRef<TreeNode | null>(null)
    const flatEntriesRef = useRef<FlatEntry[]>([])
    const expandedDirsRef = useRef(new Set<string>())
    const lastTreeBuildRef = useRef(0)
    const gitStatusRef = useRef<Map<string, GitStatus>>(new Map())
    const { stdout } = useStdout()

    const changedFilesRef = useRef(changedFiles)
    const focusedRef = useRef(focused)
    changedFilesRef.current = changedFiles
    focusedRef.current = focused


    const writeToStdout = (data: string) => {
        if (stdout) stdout.write(data)
        else process.stdout.write(data)
    }


    // Fetch git status
    const fetchGitStatus = () => {
        try {
            const output = execSync("git status --porcelain", {
                cwd: projectRoot,
                encoding: "utf-8",
                timeout: 3000,
            })

            const statusMap = new Map<string, GitStatus>()

            for (const line of output.split("\n")) {
                if (!line.trim()) continue
                const status = line.slice(0, 2).trim()
                const filePath = line.slice(3).trim()
                const actualPath = filePath.includes(" -> ") ? filePath.split(" -> ")[1]! : filePath

                let marker: GitStatus = ""
                if (status.includes("M")) marker = "M"
                else if (status.includes("A")) marker = "A"
                else if (status.includes("D")) marker = "D"
                else if (status.includes("R")) marker = "R"
                else if (status.includes("?")) marker = "?"

                if (marker) statusMap.set(actualPath, marker)
            }

            gitStatusRef.current = statusMap
        } catch {
            // Not a git repo or git not available
        }
    }


    // Build tree structure from directory
    const buildTree = () => {
        const now = Date.now()
        if (now - lastTreeBuildRef.current < 2000 && treeRef.current) return
        lastTreeBuildRef.current = now

        fetchGitStatus()

        const rawTree = dirTree(projectRoot, {
            exclude: [/node_modules/, /\.git/, /dist/, /\.DS_Store/],
            extensions: /\.(go|mod|sum|yaml|yml|ts|tsx|js|jsx|json|sh|html|css|md|toml|lock|env)$/,
            attributes: ["type"],
        })

        if (!rawTree) return

        const gitMap = gitStatusRef.current

        const convert = (node: dirTree.DirectoryTree): TreeNode => {
            const relPath = relative(projectRoot, node.path)
            const isDir = node.type === "directory" || !!node.children
            const children = node.children
                ? [...node.children]
                    .sort((a, b) => {
                        const aDir = a.type === "directory" || !!a.children
                        const bDir = b.type === "directory" || !!b.children
                        if (aDir && !bDir) return -1
                        if (!aDir && bDir) return 1
                        return a.name.localeCompare(b.name)
                    })
                    .map(convert)
                : undefined

            return {
                name: node.name,
                path: node.path,
                isDir,
                children,
                gitStatus: gitMap.get(relPath) ?? "",
            }
        }

        treeRef.current = convert(rawTree)
        flattenTree()
    }


    // Flatten tree into visible entries based on expanded state
    const flattenTree = () => {
        if (!treeRef.current) return

        const entries: FlatEntry[] = []
        const expanded = expandedDirsRef.current

        const walk = (node: TreeNode, depth: number, parentPrefix: string, isLast: boolean) => {
            const connector = depth === 0 ? "" : (isLast ? TREE_ICONS.lastBranch : TREE_ICONS.branch)
            const prefix = depth === 0 ? "" : parentPrefix + connector
            const isExpanded = expanded.has(node.path)

            entries.push({
                name: node.name,
                path: node.path,
                isDir: node.isDir,
                depth,
                prefix,
                gitStatus: node.gitStatus,
                hasChildren: !!(node.children && node.children.length > 0),
                isExpanded,
            })

            if (node.isDir && isExpanded && node.children) {
                node.children.forEach((child, i) => {
                    const childIsLast = i === node.children!.length - 1
                    const childPrefix = depth === 0
                        ? ""
                        : parentPrefix + (isLast ? TREE_ICONS.lastIndent : TREE_ICONS.indent)
                    walk(child, depth + 1, childPrefix, childIsLast)
                })
            }
        }

        // Root is always expanded, show its children directly
        if (treeRef.current.children) {
            treeRef.current.children.forEach((child, i) => {
                const isLast = i === treeRef.current!.children!.length - 1
                walk(child, 0, "", isLast)
            })
        }

        flatEntriesRef.current = entries
    }


    // Toggle directory expand/collapse
    const toggleDir = (path: string) => {
        const expanded = expandedDirsRef.current
        if (expanded.has(path)) {
            expanded.delete(path)
        } else {
            expanded.add(path)
        }
        flattenTree()
    }


    // Keyboard navigation
    useInput((input, key) => {
        if (!focusedRef.current) return

        const entries = flatEntriesRef.current
        const maxIndex = entries.length - 1

        if (key.upArrow || input === "k") {
            selectedIndexRef.current = Math.max(0, selectedIndexRef.current - 1)
            // Keep selection in view
            if (selectedIndexRef.current < scrollOffsetRef.current) {
                scrollOffsetRef.current = selectedIndexRef.current
            }
        }

        if (key.downArrow || input === "j") {
            selectedIndexRef.current = Math.min(maxIndex, selectedIndexRef.current + 1)
            if (selectedIndexRef.current >= scrollOffsetRef.current + viewHeight) {
                scrollOffsetRef.current = selectedIndexRef.current - viewHeight + 1
            }
        }

        // Toggle/expand directory
        const currentEntry = entries[selectedIndexRef.current]
        if (currentEntry?.isDir && (key.return || key.rightArrow || input === " " || input === "l" || input === "o")) {
            toggleDir(currentEntry.path)
            return
        }

        // Left arrow or 'h': collapse directory, or go to parent
        if ((key.leftArrow || input === "h") && entries[selectedIndexRef.current]) {
            const entry = entries[selectedIndexRef.current]!
            if (entry.isDir && entry.isExpanded) {
                expandedDirsRef.current.delete(entry.path)
                flattenTree()
            } else if (entry.depth > 0) {
                for (let i = selectedIndexRef.current - 1; i >= 0; i--) {
                    if (entries[i]!.isDir && entries[i]!.depth < entry.depth) {
                        selectedIndexRef.current = i
                        if (selectedIndexRef.current < scrollOffsetRef.current) {
                            scrollOffsetRef.current = selectedIndexRef.current
                        }
                        break
                    }
                }
            }
            return
        }

        if (key.pageUp) {
            selectedIndexRef.current = Math.max(0, selectedIndexRef.current - viewHeight)
            scrollOffsetRef.current = Math.max(0, scrollOffsetRef.current - viewHeight)
        }

        if (key.pageDown) {
            selectedIndexRef.current = Math.min(maxIndex, selectedIndexRef.current + viewHeight)
            const maxScroll = Math.max(0, entries.length - viewHeight)
            scrollOffsetRef.current = Math.min(maxScroll, scrollOffsetRef.current + viewHeight)
        }

        if (input === "g") {
            selectedIndexRef.current = 0
            scrollOffsetRef.current = 0
        }
        if (input === "G") {
            selectedIndexRef.current = maxIndex
            scrollOffsetRef.current = Math.max(0, entries.length - viewHeight)
        }
    })


    // Render frame
    const renderFrame = () => {
        if (!mountedRef.current) return

        buildTree()

        const entries = flatEntriesRef.current
        const offset = scrollOffsetRef.current
        const selected = selectedIndexRef.current
        const windowEntries = entries.slice(offset, offset + viewHeight)
        const now = Date.now()
        const changed = changedFilesRef.current

        let output = "\x1b[?25l"

        for (let y = 0; y < viewHeight; y++) {

            output += moveCursor(row + y, col)

            if (y < windowEntries.length && windowEntries[y]) {

                const entry = windowEntries[y]!
                const globalIndex = offset + y
                const isSelected = globalIndex === selected
                const relPath = relative(projectRoot, entry.path)
                const changeTime = changed.get(entry.path) ?? changed.get(relPath) ?? 0
                const timeSinceChange = now - changeTime
                const isRecentlyChanged = changeTime > 0 && timeSinceChange < 5000

                // Git marker
                let gitMarker = ""
                let gitColor = ""
                if (entry.gitStatus === "M") { gitMarker = " M"; gitColor = "\x1b[33m" }
                else if (entry.gitStatus === "A") { gitMarker = " A"; gitColor = "\x1b[32m" }
                else if (entry.gitStatus === "D") { gitMarker = " D"; gitColor = "\x1b[31m" }
                else if (entry.gitStatus === "R") { gitMarker = " R"; gitColor = "\x1b[35m" }
                else if (entry.gitStatus === "?") { gitMarker = " ?"; gitColor = "\x1b[90m" }

                // Name color
                let nameColor = ""
                if (isRecentlyChanged) {
                    nameColor = timeSinceChange < 1000 ? "\x1b[1;33m" :
                        timeSinceChange < 3000 ? "\x1b[33m" :
                            "\x1b[90m"
                } else if (gitColor) {
                    nameColor = gitColor
                } else if (entry.isDir) {
                    nameColor = "\x1b[1;38;2;124;124;255m" // bold periwinkle
                } else {
                    nameColor = "\x1b[37m"
                }

                // Selection highlight — directories get a more prominent highlight
                let selBg = ""
                let selIndicator = "  "
                if (isSelected) {
                    if (entry.isDir) {
                        selBg = "\x1b[48;5;24m"  // blue-ish background for directories
                        selIndicator = "\x1b[1;38;2;124;124;255m▸ "
                    } else {
                        selBg = "\x1b[48;5;236m"  // subtle gray for files
                        selIndicator = "\x1b[38;2;124;124;255m▸ "
                    }
                    // Override name color when selected for better contrast
                    nameColor = entry.isDir ? "\x1b[1;97m" : "\x1b[97m"  // bright white, bold for dirs
                }

                // Icon
                let icon: string
                if (entry.isDir) {
                    icon = entry.isExpanded ? TREE_ICONS.folderOpen : TREE_ICONS.folderClosed
                } else {
                    icon = getFileIcon(entry.name)
                }

                // Expand hint for selected directories
                const dirHint = isSelected && entry.isDir
                    ? (entry.isExpanded ? " \x1b[90m[collapse]\x1b[0m" : " \x1b[90m[expand]\x1b[0m")
                    : ""
                const dirHintVisLen = isSelected && entry.isDir ? (entry.isExpanded ? 11 : 10) : 0

                // Build line
                const treeColor = "\x1b[90m"
                const treePart = entry.prefix ? treeColor + entry.prefix + resetStyle : ""
                const iconPart = (entry.isDir ? "\x1b[33m" : "\x1b[90m") + icon + resetStyle
                const namePart = nameColor + (entry.isDir ? entry.name + "/" : entry.name) + resetStyle
                const gitPart = gitMarker ? " " + gitColor + gitMarker + resetStyle : ""

                const nameLen = entry.name.length + (entry.isDir ? 1 : 0) // +1 for trailing /
                const visLen = 2 + entry.prefix.length + 2 + nameLen + (gitMarker ? 1 + gitMarker.length : 0) + dirHintVisLen
                const pad = Math.max(0, viewWidth - visLen)

                output += selBg + selIndicator + treePart + iconPart + namePart + gitPart + dirHint + " ".repeat(pad) + resetStyle

            } else {
                output += " ".repeat(viewWidth)
            }

        }

        // Status line
        const totalFiles = entries.length
        const statusLeft = `${totalFiles} items`
        const recentCount = [...changed.values()].filter((t) => now - t < 5000).length
        const statusRight = recentCount > 0 ? `${recentCount} changed` : ""
        const statusPad = Math.max(0, viewWidth - statusLeft.length - statusRight.length)
        output += moveCursor(row + viewHeight, col)
        output += `\x1b[90m${statusLeft}${" ".repeat(statusPad)}${statusRight}${resetStyle}`

        writeToStdout(output)
    }


    // Repaint interval
    useEffect(() => {
        mountedRef.current = true

        const repaintInterval = setInterval(() => renderFrame(), 200)
        const initTimer = setTimeout(() => renderFrame(), 300)

        return () => {
            mountedRef.current = false
            clearInterval(repaintInterval)
            clearTimeout(initTimer)

            let clear = ""
            for (let y = 0; y <= viewHeight; y++) {
                clear += moveCursor(row + y, col) + "\x1b[K"
            }
            clear += "\x1b[?25l"
            writeToStdout(clear)
        }
    }, [viewHeight, viewWidth, row, col])


    return (
        <Box
            flexDirection="column"
            height={viewHeight + 1}
            width={viewWidth}
        />
    )

}
