/***
 *
 *
 *  Dev Command
 *
 *  Main entry point for the Strux dev tool
 *
 */

import path from "path"
import { join } from "path"

import chokidar from "chokidar"

import { Settings } from "../../settings"
import { Logger } from "../../utils/log"
import { fileExists } from "../../utils/path"
import { compileApplication, compileCage, compileWPE, buildStruxClient } from "../build/steps"
import { Runner } from "../../utils/run"
import { build as buildCommand } from "../build"
import { loadBuildCacheManifest, shouldRebuildStep, updateStepCache } from "../build/cache"
import { forceRestoreAllArtifacts } from "../build/artifacts"
import { MainYAMLValidator } from "../../types/main-yaml"
import { createDevServer, stopDevServer, type DevServer } from "./server"
import { run as runQEMU } from "../run"
import { DevUI } from "./ui"
import chalk from "chalk"


// Dev server instance
let devServer: DevServer | null = null

// QEMU process reference
let qemuProcess: Awaited<ReturnType<typeof runQEMU>> | null = null

// Vite dev server process reference
let viteProcess: ReturnType<typeof Bun.spawn> | null = null

// Dev UI reference
let devUI: DevUI | null = null

// File watcher reference
let fileWatcher: ReturnType<typeof chokidar.watch> | null = null

// Guard flag to prevent rebuilds during shutdown
let isShuttingDown = false

// Build debounce/queue state
let isBuilding = false
let buildCooldown = false
let pendingBuild: "full" | "app" | null = null
let pendingBuildFiles: Set<string> = new Set()
let debounceTimer: ReturnType<typeof setTimeout> | null = null
const DEBOUNCE_MS = 300

const consoleSessionId = "main"


export async function dev(): Promise<void> {


    // Enable dev mode
    Settings.isDevMode = true

    // Load and validate strux.yaml to get the client key and other settings
    MainYAMLValidator.validateAndLoad()

    // Determine BSP based on --remote flag
    if (Settings.isRemoteOnly) {

        // Remote mode: Use BSP from strux.yaml
        Logger.info("Remote mode: Using BSP from strux.yaml")

        if (!Settings.bspName) {

            Logger.errorWithExit("No BSP specified in strux.yaml. Please add a 'bsp' field.")

        }

    } else {

        // Local mode: Force QEMU BSP
        Logger.info("Local mode: Using QEMU BSP for development")

        Settings.bspName = "qemu"

    }

    // Get the client key from the config
    const clientKey = Settings.main?.dev?.server?.client_key ?? ""

    if (!clientKey) {

        Logger.errorWithExit("No client key found in strux.yaml. Please add a client_key under dev.server.")

    }

    // Get the server port from fallback hosts (default to 8000)
    const serverPort = Settings.main?.dev?.server?.fallback_hosts?.[0]?.port ?? 8000

    const cleanup = async (exitCode = 0) => {
        if (isShuttingDown) return
        isShuttingDown = true

        Logger.setSink(null)
        devUI?.destroy()

        Logger.log("Shutting down...")

        // Close file watcher first to prevent new rebuilds
        if (fileWatcher) {
            await fileWatcher.close()
            fileWatcher = null
        }

        stopDevServer()

        if (viteProcess) {
            viteProcess.kill()
            // Also explicitly stop the Docker container in case bash ignores SIGTERM
            if (!Settings.inContainer) {
                try {
                    Bun.spawn(["docker", "stop", "-t", "3", "strux-vite-dev"], {
                        stdout: "pipe",
                        stderr: "pipe",
                    })
                } catch {
                    // Container may already be stopped
                }
            }
        }

        if (qemuProcess && "kill" in qemuProcess) {
            qemuProcess.kill()
        }

        setTimeout(() => {
            process.exit(exitCode)
        }, 500)
    }

    // Initialize the TUI
    if (process.env.STRUX_DEV_NO_UI === "1") {
        Logger.warning("STRUX_DEV_NO_UI=1 set, using console output")
        devUI = null
    } else {
        try {
            devUI = new DevUI({
                onExit: () => cleanup(),
                onConsoleInput: (data) => {
                    if (!devServer?.isClientConnected()) {
                        Logger.warning("Console not connected yet")
                        return
                    }
                    devServer.sendExecInput(consoleSessionId, data)
                },
                onConfigAction: (action) => {
                    handleConfigAction(action)
                },
                initialStatus: "Starting dev session..."
            })
        } catch (error) {
            Logger.error(`Failed to start TUI, falling back to console logs: ${(error as Error).message}`)
            devUI = null
        }
    }

    // Helper to handle fatal errors - logs to UI and waits before exiting
    const handleFatalError = (error: Error | unknown, type: string) => {
        // Check if this is a controlled exit from Logger.errorWithExit
        // These errors are already logged, just need to wait for user to see them
        if (error instanceof Error && error.name === "StruxExitError") {
            // Already logged by Logger.errorWithExit, UI is showing the error
            // Don't exit automatically - let user press Q to exit
            return
        }

        const errorMessage = error instanceof Error
            ? `${error.message}\n${error.stack ?? ""}`
            : String(error)

        Logger.error(`${type}: ${errorMessage}`)

        // Give the UI time to render the error before exiting
        if (devUI) {
            devUI.appendLog("build", chalk.red(`\n[FATAL] ${type}: ${errorMessage}`))
            devUI.appendLog("build", chalk.yellow("\nPress Q to exit."))
            // Don't auto-exit, let user see the error and press Q
        } else {
            cleanup(1)
        }
    }

    // Set up global error handlers to capture uncaught errors in the UI
    process.on("uncaughtException", (error) => {
        handleFatalError(error, "Uncaught Exception")
    })

    process.on("unhandledRejection", (reason) => {
        handleFatalError(reason, "Unhandled Promise Rejection")
    })

    if (devUI) {
        const ui = devUI // Capture reference for closure
        Logger.setSink(({ level, message, formatted }) => {
            if (level === "spinner") {
                ui.setSpinnerLine(formatted ?? message)
                return
            }
            if (level === "spinner-clear") {
                ui.setSpinnerLine("")
                return
            }

            const output = formatted ?? message
            const lines = output.split("\n")
            for (const line of lines) {
                ui.appendLog("build", line)
            }
        })
    }

    if (Settings.isRemoteOnly && devUI) {
        devUI.setQemuTabLabel("Early Logs")
    }

    const useUi = devUI !== null

    // Run the initial build (skipped in remote mode or --no-rebuild)
    if (Settings.isRemoteOnly) {
        Logger.info("Remote mode: Skipping build step")
    } else if (Settings.noRebuild) {
        // Verify that a bootable image exists from a previous build
        const bspName = Settings.bspName!
        const requiredArtifacts = [
            { path: join("dist", "output", bspName, "vmlinuz"), name: "Kernel" },
            { path: join("dist", "output", bspName, "initrd.img"), name: "Initramfs" },
            { path: join("dist", "output", bspName, "rootfs.ext4"), name: "Root Filesystem" }
        ]

        const missing = requiredArtifacts.filter(a => !fileExists(join(Settings.projectPath, a.path)))

        if (missing.length > 0) {
            const names = missing.map(a => a.name).join(", ")
            Logger.errorWithExit(
                `--no-rebuild: Missing required artifacts: ${names}\n` +
                "       Run 'strux dev' without --no-rebuild first to create the initial image."
            )
        }

        // Check if the Go application binary needs recompiling.
        // The binary is streamed to the device on each boot, so it must be up-to-date
        // even when the rest of the image is reused as-is.
        const appBinaryPath = join(Settings.projectPath, "dist", "cache", bspName, "app", "main")
        const manifest = await loadBuildCacheManifest(bspName)
        const cacheConfig = Settings.main?.build?.cache ?? { enabled: true }

        const appNeedsRebuild = !fileExists(appBinaryPath) || (
            cacheConfig.enabled !== false &&
            (await shouldRebuildStep("application", manifest, { bspName })).rebuild
        )

        if (appNeedsRebuild) {
            Logger.info("Application source changed, recompiling...")
            await compileApplication()
            await updateStepCache("application", manifest, { bspName })
        }

        Logger.info("Skipping image rebuild (--no-rebuild), using existing image")
    } else {
        Logger.title("Building Development Image")

        try {
            await buildCommand()
        } catch (error) {
            // Handle StruxExitError specially - it's already been logged
            if (error instanceof Error && error.name === "StruxExitError") {
                // Error already logged to UI, wait for user to press Q
                if (useUi) {
                    await new Promise((_resolve) => { /* Never resolves - UI handles exit via Q key */ })
                }
                return
            }
            // Re-throw other errors to be caught by global handler
            throw error
        }
    }

    // Start the Vite dev server for the frontend
    if (Settings.inContainer) {
        // Running inside the builder container — run Vite directly
        Logger.title("Starting Vite Dev Server")

        viteProcess = Bun.spawn(["/bin/bash", "-c", "cd /project/frontend && npm install && npm run dev -- --host 0.0.0.0 --port 5173"], {
            stdio: useUi ? ["pipe", "pipe", "pipe"] : ["inherit", "inherit", "inherit"],
            cwd: Settings.projectPath,
        })

        if (useUi && viteProcess.stdout) {
            streamLines(viteProcess.stdout as any, (line) => devUI?.appendLog("vite", line))
        }
        if (useUi && viteProcess.stderr) {
            streamLines(viteProcess.stderr as any, (line) => devUI?.appendLog("vite", line))
        }

        Logger.success("Vite dev server started on http://localhost:5173")
    } else {
        // Running on the host — start Vite inside Docker
        Logger.title("Starting Vite Dev Server (Docker)")

        // Remove any leftover container from a previous session that didn't clean up
        try {
            Bun.spawn(["docker", "rm", "-f", "strux-vite-dev"], {
                stdout: "pipe",
                stderr: "pipe",
            })
        } catch {
            // Ignore - container may not exist
        }

        const viteDockerArgs: string[] = [
            "docker", "run", "--rm",
            "--name", "strux-vite-dev",
            "-v", `${Settings.projectPath}:/project`,
            "-p", "5173:5173",  // Vite dev server port
            "-w", "/project/frontend",
            // Enable polling for file watching (Docker doesn't propagate native fs events well)
            "-e", "CHOKIDAR_USEPOLLING=true",
            "-e", "CHOKIDAR_INTERVAL=100",
            "strux-builder",
            "/bin/bash", "-c",
            "npm install && npm run dev -- --host 0.0.0.0 --port 5173"
        ]

        viteProcess = Bun.spawn(viteDockerArgs, {
            stdio: useUi ? ["pipe", "pipe", "pipe"] : ["inherit", "inherit", "inherit"]
        })

        if (useUi && viteProcess.stdout) {
            streamLines(viteProcess.stdout as any, (line) => devUI?.appendLog("vite", line))
        }
        if (useUi && viteProcess.stderr) {
            streamLines(viteProcess.stderr as any, (line) => devUI?.appendLog("vite", line))
        }

        Logger.success("Vite dev server started on http://localhost:5173 (running in Docker)")
    }

    // Handle Vite process exit
    viteProcess.exited.then((code) => {

        // Exit codes 130 (SIGINT) and 143 (SIGTERM) are expected when we kill the process
        const isSignalExit = code === 130 || code === 143

        if (code !== 0 && code !== null && !isSignalExit) {

            Logger.error(`Vite dev server exited with code ${code}`)

        }

    })

    // Start QEMU if not in remote mode
    if (!Settings.isRemoteOnly) {

        Logger.title("Starting QEMU Emulator")

        const proc = await runQEMU({
            devMode: true,
            returnProcess: true,
            stdio: useUi ? ["pipe", "pipe", "pipe"] : ["inherit", "inherit", "inherit"]
        })

        if (proc) {

            qemuProcess = proc

            if (useUi && proc.stdout) {
                streamLines(proc.stdout, (line) => devUI?.appendLog("qemu", line))
            }
            if (useUi && proc.stderr) {
                streamLines(proc.stderr, (line) => devUI?.appendLog("qemu", line))
            }

            // Handle QEMU exit
            proc.exited.then((code) => {

                if (devUI) {
                    devUI.appendLog("qemu", `QEMU exited with code ${code}`)
                }

                if (code !== 0) {
                    Logger.error(`QEMU exited with code ${code}`)
                } else {
                    Logger.log("QEMU emulator stopped")
                }

                // Let cleanup handle everything (it guards against double-calls)
                cleanup(code ?? 0)

            })

        }

    }

    // Start the dev server
    Logger.title("Starting Development Server")

    const uiHandlers = devUI ? (() => {
        const ui = devUI
        return {
            onLogLine: (payload: { streamId: string; line: string; service?: string; timestamp: string }) => {
                if (payload.streamId === "app") {
                    ui.appendLog("app", formatLogLine("app", payload.line, payload.service, payload.timestamp))
                } else if (payload.streamId === "cage") {
                    ui.appendLog("cage", formatLogLine("cage", payload.line, payload.service, payload.timestamp))
                } else if (payload.streamId === "system" || payload.streamId === "journalctl") {
                    ui.appendLog("system", formatLogLine(payload.streamId, payload.line, payload.service, payload.timestamp))
                } else if (payload.streamId === "early") {
                    ui.appendLog("qemu", formatLogLine(payload.streamId, payload.line, payload.service, payload.timestamp))
                } else {
                    ui.appendLog("system", formatLogLine(payload.streamId, payload.line, payload.service, payload.timestamp))
                }
            },
            onLogError: (payload: { streamId: string; error: string }) => {
                ui.appendLog("system", `Log error (${payload.streamId}): ${payload.error}`)
            },
            onBinaryAck: (payload: { status: string; message: string }) => {
                if (payload.status === "skipped") {
                    ui.appendLog("build", `Binary skipped: ${payload.message}`)
                } else if (payload.status === "updated") {
                    ui.appendLog("build", `Binary updated on device: ${payload.message}`)
                } else {
                    ui.appendLog("build", `Binary update failed: ${payload.message}`)
                }
            },
            onExecOutput: (payload: { data: string }) => {
                ui.appendConsoleChunk(payload.data)
                ui.setConsoleSessionActive(true)
            },
            onExecExit: (payload: { code: number }) => {
                ui.appendConsoleChunk(`\r\n[session exited: ${payload.code}]\r\n`)
                ui.setConsoleSessionActive(false)
                ui.setConsoleInputMode(false)
            },
            onExecError: (payload: { error: string }) => {
                ui.appendConsoleChunk(`\r\n[error] ${payload.error}\r\n`)
                ui.setConsoleSessionActive(false)
                ui.setConsoleInputMode(false)
            },
            onComponentAck: (payload: { componentType: string; status: string; message: string }) => {
                if (payload.status === "updated") {
                    ui.appendLog("build", chalk.green(`Component ${payload.componentType} updated: ${payload.message}`))
                } else {
                    ui.appendLog("build", chalk.red(`Component ${payload.componentType} failed: ${payload.message}`))
                }
            },
            onDeviceInfo: (payload: { ip: string; inspectorPorts: { path: string; port: number }[] }) => {
                // In QEMU mode, inspector ports are forwarded to localhost
                const displayIp = Settings.isRemoteOnly ? payload.ip : "localhost"
                ui.setDeviceInfo({
                    ip: displayIp,
                    inspectorPorts: payload.inspectorPorts,
                })

                if (payload.inspectorPorts.length > 0) {
                    Logger.info(`Device IP: ${displayIp}`)
                    for (const p of payload.inspectorPorts) {
                        Logger.info(`  Inspector: ${p.path} -> http://${displayIp}:${p.port}`)
                    }
                }
            }
        }
    })() : {}

    devServer = createDevServer({
        port: serverPort,
        clientKey,
        onClientConnected: () => {

            Logger.success("Device connected to dev server")
            devUI?.setStatus(`Connected | ${Settings.isRemoteOnly ? "remote" : "qemu"} | port ${serverPort}`)

            devServer?.startExecSession(consoleSessionId, "/bin/sh")
            devUI?.setConsoleSessionActive(true)

            // Start streaming app logs (user's Go app output) unless disabled
            if (Settings.devAppDebug) {
                devServer?.startLogStream("app", "app")
            }

            // Start streaming cage logs (Cage/Cog compositor output)
            devServer?.startLogStream("cage", "cage")

            // Only start streaming system logs in debug mode
            if (Settings.devDebug) {
                devServer?.startLogStream("system", "journalctl")
            }

            if (Settings.isRemoteOnly) {
                devServer?.startLogStream("early", "early")
            }

        },
        onClientDisconnected: () => {

            Logger.warning("Device disconnected from dev server")
            devUI?.setStatus(`Disconnected | ${Settings.isRemoteOnly ? "remote" : "qemu"} | port ${serverPort}`)
            devUI?.setConsoleSessionActive(false)
            devUI?.setConsoleInputMode(false)

        },
        onBinaryRequested: async () => {

            // Client requested binary, send the current one without recompiling
            Logger.log("Binary requested by client, sending current binary...")

            await sendCurrentBinary()

        },
        ...uiHandlers
    })

    Logger.info(`Client key: ${clientKey}`)

    // Register signal handlers before starting file watcher
    process.on("SIGINT", () => cleanup())
    process.on("SIGTERM", () => cleanup())

    // Start the file watcher
    await runFileWatcher()

    // Keep the process running
    await new Promise((_resolve) => { /* Never resolves - keeps process alive */ })

}


async function handleConfigAction(action: "restore" | "rebuild-transfer" | "restart-service" | "reboot"): Promise<void> {
    if (!devUI) return

    devUI.setConfigBusy(true)

    try {
        if (action === "restore") {
            Logger.info("Restoring all artifacts to built-in versions...")

            // Remove the entire dist/artifacts/ directory
            const artifactsDir = join(Settings.projectPath, "dist", "artifacts")
            const { rm } = await import("fs/promises")
            try {
                await rm(artifactsDir, { recursive: true, force: true })
            } catch {
                // Directory may not exist
            }

            // Force-write all embedded files
            await forceRestoreAllArtifacts()

            Logger.success("All artifacts restored to built-in versions")
            devUI.flashConfigSuccess("All artifacts restored to built-in versions")

        } else if (action === "rebuild-transfer") {
            if (!devServer?.isClientConnected()) {
                Logger.error("Cannot transfer components: No device connected")
                devUI.setConfigBusy(false)
                return
            }

            const bspName = Settings.bspName!

            Logger.info("Rebuilding Strux components...")

            // Skip per-step chown during incremental rebuilds — do a single pass at the end
            Runner.skipChown = true
            try {
                await compileCage()
                await compileWPE()
                await buildStruxClient(true)
            } finally {
                Runner.skipChown = false
                if (!Settings.noChown) {
                    await Runner.chownProjectFiles()
                }
            }

            Logger.info("Components built, transferring to device...")

            // Read the built binaries
            const cagePath = join(Settings.projectPath, "dist", "cache", bspName, "cage")
            const wpePath = join(Settings.projectPath, "dist", "cache", bspName, "libstrux-extension.so")
            const clientPath = join(Settings.projectPath, "dist", "cache", bspName, "client")
            const cogPath = join(Settings.projectPath, "dist", "cache", bspName, "cog")

            const cageBinary = Buffer.from(await Bun.file(cagePath).arrayBuffer())
            const wpeBinary = Buffer.from(await Bun.file(wpePath).arrayBuffer())
            const clientBinary = Buffer.from(await Bun.file(clientPath).arrayBuffer())
            const cogBinary = Buffer.from(await Bun.file(cogPath).arrayBuffer())

            // Read the scripts from dist/artifacts
            const scriptsDir = join(Settings.projectPath, "dist", "artifacts", "scripts")
            const initShBuf = Buffer.from(await Bun.file(join(scriptsDir, "init.sh")).arrayBuffer())
            const struxShBuf = Buffer.from(await Bun.file(join(scriptsDir, "strux.sh")).arrayBuffer())
            const networkShBuf = Buffer.from(await Bun.file(join(scriptsDir, "strux-network.sh")).arrayBuffer())
            const runCogShBuf = Buffer.from(await Bun.file(join(scriptsDir, "strux-run-cog.sh")).arrayBuffer())

            // Send each component to the device
            devServer.sendComponent("cage", cageBinary, "/usr/bin/cage")
            devServer.sendComponent("wpe-extension", wpeBinary, "/usr/lib/wpe-web-extensions/libstrux-extension.so")
            devServer.sendComponent("client", clientBinary, "/strux/client")
            devServer.sendComponent("cog", cogBinary, "/usr/bin/cog")

            // Send scripts to the device
            devServer.sendComponent("script", initShBuf, "/init")
            devServer.sendComponent("script", struxShBuf, "/strux/strux.sh")
            devServer.sendComponent("script", networkShBuf, "/usr/bin/strux-network.sh")
            devServer.sendComponent("script", runCogShBuf, "/strux/strux-run-cog.sh")

            // Send cage environment file if it exists
            const cageEnvPath = join(Settings.projectPath, "dist", "cache", bspName, ".cage-env")
            if (await Bun.file(cageEnvPath).exists()) {
                const cageEnvBuf = Buffer.from(await Bun.file(cageEnvPath).arrayBuffer())
                devServer.sendComponent("script", cageEnvBuf, "/strux/.cage-env")
            }

            // Wait a moment for acks, then reboot
            setTimeout(() => {
                Logger.info("Sending reboot command to device...")
                devServer?.sendReboot()
            }, 2000)

            Logger.success("Components transferred to device, rebooting...")

        } else if (action === "restart-service") {
            if (!devServer?.isClientConnected()) {
                Logger.error("Cannot restart service: No device connected")
                devUI.setConfigBusy(false)
                return
            }

            devServer.sendRestartService()
            Logger.success("Restart command sent to device")
            devUI.flashConfigSuccess("Strux service restart command sent")

        } else if (action === "reboot") {
            if (!devServer?.isClientConnected()) {
                Logger.error("Cannot reboot: No device connected")
                devUI.setConfigBusy(false)
                return
            }

            devServer.sendReboot()
            Logger.success("Reboot command sent to device")
            devUI.flashConfigSuccess("Reboot command sent to device")
        }
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        Logger.error(`Config action failed: ${msg}`)
    } finally {
        devUI?.setConfigBusy(false)
    }
}


function streamLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): void {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    const readLoop = async () => {
        while (true) {
            const result = await reader.read()
            if (result.done) break

            buffer += decoder.decode(result.value, { stream: true })
            const parts = buffer.split("\n")
            buffer = parts.pop() ?? ""

            for (const line of parts) {
                if (line.trim().length > 0) {
                    onLine(line)
                }
            }
        }

        if (buffer.trim().length > 0) {
            onLine(buffer)
        }
    }

    void readLoop()
}

function formatLogLine(streamId: string, line: string, service?: string, timestamp?: string): string {
    const ts = timestamp ? `${chalk.dim(timestamp)} ` : ""
    const svc = service ? `${chalk.cyan(`[${service}]`)} ` : ""

    if (streamId === "app") {
        return `${ts}${chalk.green.bold("[APP]")} ${svc}${chalk.green(line)}`
    }

    if (streamId === "cage") {
        return `${ts}${chalk.blue.bold("[CAGE]")} ${svc}${chalk.blue(line)}`
    }

    return `${ts}${chalk.magenta(`[${streamId}]`)} ${svc}${line}`
}


async function runFileWatcher(): Promise<void> {


    fileWatcher = chokidar.watch(Settings.projectPath, {
        ignored: (filePath: string, stats) => {
            // Ignore everything in frontend, dist, assets, bsp, and overlay directories
            const ignoreDirs = ["frontend/", "dist/", "assets/", "bsp/", "overlay/", ".git/"]
            // Normalize path separators for cross-platform consistency
            const normalizedPath = filePath.replace(/\\/g, "/")
            for (const dir of ignoreDirs) {
                if (normalizedPath.includes(`/${dir}`) || normalizedPath.startsWith(`${dir}`)) {
                    return true
                }
            }
            if (!stats?.isFile?.()) return false
            return !(
                filePath.endsWith(".go") ||
                filePath.endsWith(".mod") ||
                filePath.endsWith(".yaml") || // This handles strux.yaml
                filePath.endsWith(".sum")
            )
        },
        persistent: true,
        ignoreInitial: true
    })

    fileWatcher.on("all", (_event, filePath) => {

        // Don't trigger rebuilds during shutdown
        if (isShuttingDown) return

        const buildType = filePath.endsWith(".yaml") ? "full" : "app"

        // If a build is in progress, queue the highest-priority build type
        // and track which files changed so we can filter build-induced changes
        if (isBuilding) {
            pendingBuildFiles.add(filePath)
            // "full" takes priority over "app"
            if (buildType === "full" || pendingBuild === null) {
                pendingBuild = buildType === "full" ? "full" : (pendingBuild ?? "app")
            }
            return
        }

        // During build cooldown, ignore go.mod/go.sum changes from the build
        // script's cleanup (restore trap fires after the Docker process exits)
        if (buildCooldown && Settings.localRuntime) {
            if (filePath.endsWith("go.mod") || filePath.endsWith("go.sum")) {
                return
            }
        }

        // Debounce rapid file changes
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
            debounceTimer = null
            executeBuild(buildType)
        }, DEBOUNCE_MS)

    })

}


async function executeBuild(buildType: "full" | "app"): Promise<void> {
    isBuilding = true
    pendingBuild = null
    pendingBuildFiles.clear()

    Logger.log("Changes detected, rebuilding application...")

    try {
        if (buildType === "full") await triggerFullRebuild()
        else await rebuildApplication()
    } catch (error) {
        if (error instanceof Error && error.name === "StruxExitError") {
            Logger.warning("Build failed. Fix the error and save to retry.")
        } else {
            throw error
        }
    } finally {
        isBuilding = false

        // Brief cooldown after build completes to catch go.mod/go.sum restore
        // events from the build script's EXIT trap (fires after Docker exits)
        if (Settings.localRuntime) {
            buildCooldown = true
            setTimeout(() => { buildCooldown = false }, 1000)
        }
    }

    // If changes came in during the build, check whether they were real user
    // edits or just build-induced artifacts (e.g. go.mod/go.sum modified by
    // the local-runtime replace directive). Only re-trigger if there are
    // meaningful changes.
    if (pendingBuild && !isShuttingDown) {
        if (Settings.localRuntime) {
            const meaningfulChanges = [...pendingBuildFiles].some(
                f => !f.endsWith("go.mod") && !f.endsWith("go.sum")
            )
            if (!meaningfulChanges) {
                pendingBuild = null
                pendingBuildFiles.clear()
                return
            }
        }
        const next = pendingBuild
        pendingBuild = null
        pendingBuildFiles.clear()
        await executeBuild(next)
    }
}


async function sendCurrentBinary(): Promise<void> {


    Logger.log("Sending current binary to client...")

    // Send the current binary without recompiling
    if (devServer?.isClientConnected()) {

        const bspName = Settings.bspName!

        // Read the compiled binary from the BSP cache directory
        const binaryPath = path.join(Settings.projectPath, "dist", "cache", bspName, "app", "main")

        const binaryFile = Bun.file(binaryPath)

        if (await binaryFile.exists()) {

            const binaryData = Buffer.from(await binaryFile.arrayBuffer())

            devServer.sendBinary(binaryData)

            Logger.success("Binary sent to device")

        } else {

            Logger.warning(`Compiled binary not found at ${binaryPath}`)

        }

    }

}


async function rebuildApplication(): Promise<void> {

    // Skip per-step chown for incremental rebuilds — single pass after
    Runner.skipChown = true
    try {
        await compileApplication()
    } finally {
        Runner.skipChown = false
        if (!Settings.noChown) {
            await Runner.chownProjectFiles()
        }
    }

    // Stream the application to the connected client
    await sendCurrentBinary()

}


async function triggerFullRebuild(): Promise<void> {


    Settings.isDevMode = true

    // Reload the config in case it changed
    MainYAMLValidator.validateAndLoad()

    // Build the application
    await buildCommand()

}
