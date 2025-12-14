/***
 *
 *  File Watchers for Dev Mode
 *
 */

import { watch, type FSWatcher } from "fs"
import { join, relative } from "path"
import { stat } from "fs/promises"
import { compileApp } from "../build"
import { buildDevImage } from "./build-dev"
import { copyFile, mkdir } from "fs/promises"
import { info, warning, error as logError } from "../../utils/colors"
import { loadConfig } from "../build"
import { generateTypes } from "../types"

interface WatcherCallbacks {
    onConfigChange?: () => Promise<void>
    onGoChange?: () => Promise<void>
}

/**
 * Check if a file should be watched (exclude vendor, node_modules, dist)
 */
function shouldWatchFile(filePath: string): boolean {
    const relPath = relative(process.cwd(), filePath)
    const parts = relPath.split("/")

    // Exclude common directories
    if (parts.includes("vendor") || parts.includes("node_modules") || parts.includes("dist")) {
        return false
    }

    return true
}

/**
 * Watch for Go file changes
 */
export async function watchGoFiles(
    cwd: string,
    arch: string,
    onRebuild: () => Promise<void>
): Promise<() => void> {
    const watchers: FSWatcher[] = []
    let rebuildTimeout: ReturnType<typeof setTimeout> | null = null
    let isRebuilding = false

    const debouncedRebuild = async () => {
        if (isRebuilding) {
            return
        }

        if (rebuildTimeout) {
            clearTimeout(rebuildTimeout)
        }

        rebuildTimeout = setTimeout(async () => {
            if (isRebuilding) {
                return
            }

            isRebuilding = true
            try {
                info("Go files changed, regenerating types and rebuilding binary...")
                
                // Regenerate TypeScript types first
                const mainGoPath = join(cwd, "main.go")
                try {
                    const mainGoFile = Bun.file(mainGoPath)
                    if (await mainGoFile.exists()) {
                        const typesResult = await generateTypes({
                            mainGoPath,
                            outputDir: join(cwd, "frontend"),
                        })
                        if (typesResult.success) {
                            info(`Types regenerated: ${typesResult.methodCount} methods, ${typesResult.fieldCount} fields`)
                        } else {
                            warning(`Failed to regenerate types: ${typesResult.error}`)
                        }
                    }
                } catch (typesErr) {
                    warning(`Type generation failed: ${typesErr instanceof Error ? typesErr.message : String(typesErr)}`)
                    // Continue with binary rebuild even if types fail
                }
                
                // Rebuild binary
                await compileApp(arch)

                // Copy binary to dev mount directory
                const struxDir = join(cwd, "dist", "strux")
                await mkdir(struxDir, { recursive: true })
                
                const sourceBinary = join(cwd, "dist", "app")
                const targetBinary = join(struxDir, "app")
                
                // Copy the binary
                await copyFile(sourceBinary, targetBinary)
                
                // Ensure file is executable
                const { chmod } = await import("fs/promises")
                await chmod(targetBinary, 0o755)
                
                // Create restart flag file to trigger systemd watcher
                const restartFlag = join(struxDir, ".strux-restart")
                await Bun.write(restartFlag, new Date().toISOString())
                
                // Also keep .dev file for compatibility
                const devFile = join(struxDir, ".dev")
                await Bun.write(devFile, new Date().toISOString())

                info("Binary rebuilt and copied to dist/strux/app")
                await onRebuild()
            } catch (err) {
                logError(`Failed to rebuild Go binary: ${err instanceof Error ? err.message : String(err)}`)
            } finally {
                isRebuilding = false
            }
        }, 500) // 500ms debounce
    }

    // Watch all .go files in project root
    const watchDirectory = async (dir: string) => {
        try {
            const watcher = watch(
                dir,
                { recursive: true },
                async (eventType, filename) => {
                    if (!filename) return

                    const fullPath = join(dir, filename)
                    if (!fullPath.endsWith(".go")) return

                    if (!shouldWatchFile(fullPath)) return

                    try {
                        const stats = await stat(fullPath)
                        if (stats.isFile()) {
                            await debouncedRebuild()
                        }
                    } catch {
                        // File might have been deleted, ignore
                    }
                }
            )

            watchers.push(watcher)
        } catch (err) {
            // Directory might not exist or not be watchable
            warning(`Could not watch directory ${dir}: ${err}`)
        }
    }

    // Watch project root for .go files
    await watchDirectory(cwd)

    return () => {
        watchers.forEach((watcher) => {
            try {
                watcher.close()
            } catch {
                // Ignore errors on close
            }
        })
        if (rebuildTimeout) {
            clearTimeout(rebuildTimeout)
        }
    }
}

/**
 * Watch for config file changes
 */
export async function watchConfigFile(
    cwd: string,
    bspName: string,
    onRebuild: () => Promise<void>
): Promise<() => void> {
    const configPath = join(cwd, "strux.json")
    let isRebuilding = false
    let rebuildTimeout: ReturnType<typeof setTimeout> | null = null

    const debouncedRebuild = async () => {
        if (isRebuilding) {
            return
        }

        if (rebuildTimeout) {
            clearTimeout(rebuildTimeout)
        }

        rebuildTimeout = setTimeout(async () => {
            if (isRebuilding) {
                return
            }

            isRebuilding = true
            try {
                info("strux.json changed, rebuilding dev image...")
                await buildDevImage(bspName, true) // Clean rebuild
                info("Dev image rebuilt")
                await onRebuild()
            } catch (err) {
                logError(`Failed to rebuild dev image: ${err instanceof Error ? err.message : String(err)}`)
            } finally {
                isRebuilding = false
            }
        }, 1000) // 1s debounce for config changes
    }

    const watcher = watch(
        configPath,
        async (eventType) => {
            if (eventType === "change") {
                await debouncedRebuild()
            }
        }
    )

    return () => {
        watcher.close()
        if (rebuildTimeout) {
            clearTimeout(rebuildTimeout)
        }
    }
}

