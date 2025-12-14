/***
 *
 *  Dev Command - Hot-reload development mode
 *
 */

import { join } from "path"
import { stat, mkdir, copyFile } from "fs/promises"
import { spawn } from "child_process"
import { title, info, error as logError, warning } from "../../utils/colors"
import { loadBSP } from "../../types/bsp"
import { buildDevImage } from "./build-dev"
import { watchGoFiles, watchConfigFile } from "./watcher"
import { compileApp } from "../build"
import { run } from "../run"
import { generateTypes } from "../types"

interface DevOptions {
    clean?: boolean // Force clean rebuild even if artifacts exist
    debug?: boolean // Enable system debug output (console and systemd messages)
}


/**
 * Start Vite dev server
 */
async function startViteDevServer(cwd: string): Promise<() => void> {
    const frontendDir = join(cwd, "frontend")
    const packageJsonPath = join(frontendDir, "package.json")

    try {
        await stat(packageJsonPath)
    } catch {
        warning("No frontend directory found, skipping Vite dev server")
        return () => {
            // No-op cleanup function
        }
    }

    info("Starting Vite dev server...")
    const viteProcess = spawn("bun", ["run", "dev", "--host", "0.0.0.0"], {
        cwd: frontendDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            ...process.env,
            // Allow external connections for VM access
        },
    })

    // Capture output but don't display it (runs in background)
    if (viteProcess.stdout) {
        viteProcess.stdout.on("data", () => {
            // Silently consume output
        })
    }
    if (viteProcess.stderr) {
        viteProcess.stderr.on("data", () => {
            // Silently consume output
        })
    }

    return () => {
        viteProcess.kill()
    }
}

/**
 * Main dev command
 */
export async function dev(bspName = "qemu", options: DevOptions = {}): Promise<void> {
    title("Starting Strux Dev Mode")
    info("Hot-reload development mode")

    const cwd = process.cwd()

    // Load config
    const configFile = Bun.file(join(cwd, "strux.json"))
    if (!(await configFile.exists())) {
        throw new Error("strux.json not found. Run this command in a Strux project directory")
    }

    const data = await configFile.json()
    const { validateConfigWithUrlCheck } = await import("../../types/config")
    const result = await validateConfigWithUrlCheck(data)

    if (!result.success) {
        throw result.error
    }

    const config = result.data

    // Load BSP
    const bspPath = join(cwd, "bsp", bspName)
    const bsp = await loadBSP(bspPath)
    const arch = bsp.arch ?? config.arch

    // Build dev image
    info("Building dev image...")
    await buildDevImage(bspName, options.clean ?? false)

    // Create dev mount directory
    const struxDir = join(cwd, "dist", "strux")
    await mkdir(struxDir, { recursive: true })

    // Generate TypeScript types from main.go
    const mainGoPath = join(cwd, "main.go")
    try {
        const mainGoFile = Bun.file(mainGoPath)
        if (await mainGoFile.exists()) {
            info("Generating TypeScript types...")
            const typesResult = await generateTypes({
                mainGoPath,
                outputDir: join(cwd, "frontend"),
            })
            if (typesResult.success) {
                info(`Types generated: ${typesResult.methodCount} methods, ${typesResult.fieldCount} fields`)
            } else {
                warning(`Failed to generate types: ${typesResult.error}`)
            }
        }
    } catch (typesErr) {
        warning(`Type generation failed: ${typesErr instanceof Error ? typesErr.message : String(typesErr)}`)
        // Continue even if types fail
    }

    // Build initial Go binary and copy to dev mount
    info("Building initial Go binary...")
    await compileApp(arch)
    await copyFile(join(cwd, "dist", "app"), join(struxDir, "app"))

    // Create .dev file
    await Bun.write(join(struxDir, ".dev"), new Date().toISOString())

    // Start Vite dev server (if frontend exists)
    const stopVite = await startViteDevServer(cwd)

    // Start file watchers
    let stopGoWatcher: (() => void) | null = null
    let stopConfigWatcher: (() => void) | null = null

    const setupWatchers = async () => {
        stopGoWatcher = await watchGoFiles(cwd, arch, async () => {
            info("Binary updated, VM will restart service automatically")
        })

        stopConfigWatcher = await watchConfigFile(cwd, bspName, async () => {
            info("Config changed, dev image rebuilt. Restart QEMU to apply changes.")
        })
    }

    await setupWatchers()

    // Cleanup function
    const cleanup = () => {
        info("Cleaning up...")
        if (stopGoWatcher) stopGoWatcher()
        if (stopConfigWatcher) stopConfigWatcher()
        stopVite()
    }

    // Handle signals
    process.on("SIGINT", cleanup)
    process.on("SIGTERM", cleanup)

    // Use the run function with isDev and systemDebug flags
    try {
        await run({ isDev: true, systemDebug: options.debug ?? false })
    } catch (err) {
        logError(`Dev mode failed: ${err instanceof Error ? err.message : String(err)}`)
        throw err
    } finally {
        cleanup()
        process.removeAllListeners("SIGINT")
        process.removeAllListeners("SIGTERM")
    }
}

