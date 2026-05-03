/***
 *
 *
 * Dev Command
 *
 *
 */
import { join } from "path"
import { rm } from "node:fs/promises"
import { Settings } from "../../settings"
import { Logger } from "../../utils/log"
import { MainYAMLValidator } from "../../types/main-yaml"
import { directoryExists, fileExists } from "../../utils/path"
import { build as buildCommand } from "../build"
import { compileApplication, compileCage, compileFrontend, compileWPE, compileScreen, buildStruxClient } from "../build/steps"
import { forceRestoreAllArtifacts } from "../build/artifacts"
import { Runner } from "../../utils/run"
import { loadBuildCacheManifest, shouldRebuildStep, updateStepCache } from "../build/cache"
import { SocketManager } from "./socket-manager"
import { QEMUManager } from "./qemu"
import { ViteManager } from "./vite"
import { FileWatcher } from "./watcher"
import { MDNSPublisher } from "./mdns"
import { DevUI } from "./ui"
import { SSHManager } from "./ssh"
import { registerClientHandlers } from "./handlers/client"
import { registerScreenHandlers } from "./handlers/screen"
import type { ClientMessageSendable, ClientMessageReceivable, ScreenMessageSendable, ScreenMessageReceivable } from "./types"


export class DevServer {

    private static instance: DevServer

    readonly sockets = SocketManager.getInstance()
    readonly qemu = new QEMUManager()
    readonly vite = new ViteManager()
    readonly watcher = new FileWatcher()
    readonly mdns = new MDNSPublisher()
    readonly ui = new DevUI()
    readonly ssh = new SSHManager(() => this, () => {
        this.ui.store.setSSHSessionIds(this.ssh.getActiveSessions())
    })
    clientKey = ""
    private componentAckWaiters = new Map<string, {
        resolve: () => void
        reject: (error: Error) => void
        timeout: ReturnType<typeof setTimeout>
    }>()


    static getInstance(): DevServer {

        if (!DevServer.instance) {

            DevServer.instance = new DevServer()

        }

        return DevServer.instance

    }


    async start(): Promise<void> {

        Settings.isDevMode = true

        // Validate the YAML
        MainYAMLValidator.validateAndLoad()

        // Determine BSP based on --remote flag
        if (Settings.isRemoteOnly) {

            Logger.info("Remote mode: Using BSP from strux.yaml")

            if (!Settings.bspName) {

                Logger.errorWithExit("No BSP specified in strux.yaml. Please add a 'bsp' field.")

            }

        } else {

            Logger.info("Local mode: Using QEMU BSP for development")

            Settings.bspName = "qemu"

        }


        // Get the client key from the config
        this.clientKey = Settings.main?.dev?.server?.client_key ?? ""

        if (!this.clientKey) {

            Logger.errorWithExit("No client key found in strux.yaml. Please add a client_key under dev.server.")

        }

        // Register error handlers before long-running work (build, TUI)
        this.registerErrorHandlers()

        const useUi = process.env.STRUX_DEV_NO_UI !== "1"

        // Start the TUI first so local initial build output streams into the device log
        if (useUi) {

            this.ui.start({
                onExit: () => this.stop(),
                onSSHStart: (rows, cols) => {
                    const sessionID = this.ssh.start("/bin/bash", rows, cols)
                    if (sessionID) {
                        this.ssh.attach(sessionID, {
                            onOutput: (data) => this.ui.store.writeToTerminal(data),
                            onExit: (_code) => {
                                this.ui.store.setSSHSession(null)
                            },
                        })
                    }
                    return sessionID
                },
                onSSHDetach: (sessionID) => {
                    this.ssh.detach(sessionID)
                },
                onSSHAttach: (sessionID, rows, cols) => {
                    const replay = this.ssh.getScrollback(sessionID)
                    this.ssh.attach(sessionID, {
                        onOutput: (data) => this.ui.store.writeToTerminal(data),
                        onExit: (_code) => {
                            this.ui.store.setSSHSession(null)
                        },
                    })
                    this.ssh.resize(sessionID, rows, cols)
                    return replay
                },
                onSSHGetScrollback: (sessionID) => this.ssh.getScrollback(sessionID),
                onSSHInput: (sessionID, data) => this.ssh.sendInput(sessionID, data),
                onSSHResize: (sessionID, rows, cols) => this.ssh.resize(sessionID, rows, cols),
                onConfigAction: (action) => this.handleConfigAction(action),
                onWatcherTogglePause: () => {
                    if (this.watcher.paused) {
                        this.watcher.resume()
                        this.ui.store.updateStatus("watcher", "running")
                        return false
                    } else {
                        this.watcher.pause()
                        this.ui.store.updateStatus("watcher", "paused")
                        return true
                    }
                },
            })
            this.ui.store.setBspName(Settings.bspName ?? "qemu")

            Logger.setSink((entry) => {
                if (entry.level === "spinner" || entry.level === "spinner-clear") {
                    return
                }

                this.ui.store.appendLog("device", {
                    level: entry.level,
                    message: entry.message,
                    formatted: entry.formatted,
                    timestamp: Date.now(),
                })
            })

        }

        if (!Settings.isRemoteOnly) {

            if (useUi) {
                this.ui.store.setBuildStatus("building")
            }

            try {
                await this.initialBuild()
            } finally {

                if (useUi) {
                    this.ui.store.setBuildStatus("idle")
                }

            }

        }

        // Set up websocket servers
        const client = this.sockets.create<ClientMessageSendable, ClientMessageReceivable>("client", { path: "/client", aliases: ["/ws"] })
        const screen = this.sockets.create<ScreenMessageSendable, ScreenMessageReceivable>("screen", { path: "/screen", auth: false, aliases: ["/ws/screen"] })

        // Register handlers
        registerClientHandlers(client)
        registerScreenHandlers(screen)

        // Start the server
        const serverPort = Settings.main?.dev?.server?.fallback_hosts?.[0]?.port ?? 8000
        this.sockets.listen({ port: serverPort, authKey: this.clientKey })
        Logger.info(`Dev server listening on port ${serverPort}`)

        // Wire subsystem output to TUI tabs
        this.vite.onOutput = (line) => {
            this.ui.store.appendLog("vite", { level: "info", message: line, timestamp: Date.now() })
        }
        this.qemu.onOutput = (line) => {
            this.ui.store.appendLog("qemu", { level: "info", message: line, timestamp: Date.now() })
        }
        this.watcher.onOutput = (line) => {
            this.ui.store.appendLog("watcher", { level: "info", message: line, timestamp: Date.now() })
        }
        this.watcher.onStatusChange = (status) => {
            this.ui.store.updateStatus("watcher", status === "building" ? "running" : "idle")
            this.ui.store.setBuildStatus(status === "building" ? "building" : "idle")
        }
        this.watcher.onFileChanged = (path) => {
            this.ui.store.markFileChanged(path)
        }

        // Start subsystems
        this.ui.store.projectRoot = process.cwd()
        await this.mdns.start(serverPort)
        await this.watcher.start(process.cwd())
        this.ui.store.updateStatus("watcher", "running")

        this.ui.store.updateStatus("vite", "running")
        await this.vite.start()

        if (!Settings.isRemoteOnly) {
            this.ui.store.updateStatus("qemu", "running")
            await this.qemu.start()
        }

    }


    private stopping = false

    stop(code = 0): void {

        if (this.stopping) return
        this.stopping = true

        Logger.info("Shutting down...")

        this.ssh.endAll()
        if (process.env.STRUX_DEV_NO_UI !== "1") {
            this.ui.store.setSSHSession(null)
        }

        this.watcher.stop()
        this.qemu.stop()
        this.vite.stop()
        this.mdns.stop()
        this.sockets.close()
        this.ui.stop()
        process.exit(code)

    }


    private async initialBuild(): Promise<void> {

        const bspName = Settings.bspName!

        if (Settings.noRebuild) {

            // Verify required artifacts exist
            const requiredArtifacts = [
                { path: join("dist", "output", bspName, "vmlinuz"), name: "Kernel" },
                { path: join("dist", "output", bspName, "initrd.img"), name: "Initramfs" },
                { path: join("dist", "output", bspName, "rootfs.ext4"), name: "Root Filesystem" },
            ]

            const missing = requiredArtifacts.filter((a) => !fileExists(join(Settings.projectPath, a.path)))

            if (missing.length > 0) {
                const names = missing.map((a) => a.name).join(", ")
                Logger.errorWithExit(
                    `--no-rebuild: Missing required artifacts: ${names}\n` +
                    "       Run 'strux dev' without --no-rebuild first to create the initial image."
                )
            }

            // Check if the app binary needs recompiling
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
            await buildCommand()

        }

    }


    async handleConfigAction(action: string): Promise<void> {

        this.ui.store.setConfigBusy(true)

        try {

            if (action === "restore") {

                Logger.info("Restoring all artifacts to built-in versions...")
                const { rm } = await import("fs/promises")
                const artifactsDir = join(Settings.projectPath, "dist", "artifacts")
                try { await rm(artifactsDir, { recursive: true, force: true }) } catch { /* may not exist */ }
                await forceRestoreAllArtifacts()
                Logger.success("All artifacts restored to built-in versions")
                this.ui.store.flashConfigSuccess("All artifacts restored to built-in versions")

            } else if (action === "rebuild-transfer") {

                const client = this.sockets.get("client")
                if (!client.hasClients()) {
                    Logger.error("Cannot transfer components: No device connected")
                    this.ui.store.setConfigBusy(false)
                    return
                }

                const bspName = Settings.bspName!
                const watcherWasPaused = this.watcher.paused

                if (!watcherWasPaused) {
                    this.watcher.pause()
                    this.ui.store.updateStatus("watcher", "paused")
                }

                try {
                    if (Settings.localBuilder) {
                        Logger.info("Rebuilding Docker builder image (--local-builder)...")
                        await Runner.prepareDockerImage()
                    }

                    Logger.info("Rebuilding Strux components, application, and frontend...")

                    Runner.skipChown = true
                    try {
                        await compileFrontend()
                        await compileApplication()
                        await compileCage()
                        await compileWPE()
                        await compileScreen()
                        await buildStruxClient(true)
                    } finally {
                        Runner.skipChown = false
                        if (!Settings.noChown) {
                            await Runner.chownProjectFiles()
                        }
                    }

                    Logger.info("Components built, transferring to device...")

                    const frontendArchivePath = await this.createFrontendTransferArchive()
                    const cagePath = join(Settings.projectPath, "dist", "cache", bspName, "cage")
                    const wpePath = join(Settings.projectPath, "dist", "cache", bspName, "libstrux-extension.so")
                    const clientPath = join(Settings.projectPath, "dist", "cache", bspName, "client")
                    const cogPath = join(Settings.projectPath, "dist", "cache", bspName, "cog")
                    const screenPath = join(Settings.projectPath, "dist", "cache", bspName, "screen")

                    const sendComponent = async (filePath: string, destPath: string) => {
                        const file = Bun.file(filePath)
                        if (!await file.exists()) return
                        const data = Buffer.from(await file.arrayBuffer()).toString("base64")
                        const ack = this.waitForComponentAck(destPath)
                        client.broadcast({ type: "component", payload: { data, destPath } })
                        await ack
                    }

                    await sendComponent(cagePath, "/usr/bin/cage")
                    await sendComponent(wpePath, "/usr/lib/wpe-web-extensions/libstrux-extension.so")
                    await sendComponent(join(Settings.projectPath, "dist", "cache", bspName, "app", "main"), "/strux/.main-update")
                    await sendComponent(clientPath, "/strux/.client-update")
                    await sendComponent(cogPath, "/usr/bin/cog")
                    await sendComponent(screenPath, "/usr/bin/strux-screen")
                    await sendComponent(frontendArchivePath, "/strux/frontend")
                    Logger.info("Frontend archive transferred and extracted on device")

                    // Send scripts
                    const scriptsDir = join(Settings.projectPath, "dist", "artifacts", "scripts")
                    await sendComponent(join(scriptsDir, "init.sh"), "/init")
                    await sendComponent(join(scriptsDir, "strux.sh"), "/strux/strux.sh")
                    await sendComponent(join(scriptsDir, "strux-network.sh"), "/usr/bin/strux-network.sh")
                    await sendComponent(join(scriptsDir, "strux-run-cog.sh"), "/strux/strux-run-cog.sh")

                    // Send cage env if it exists
                    const cageEnvPath = join(Settings.projectPath, "dist", "cache", bspName, ".cage-env")
                    await sendComponent(cageEnvPath, "/strux/.cage-env")

                    Logger.info("Sending reboot command to device...")
                    client.broadcast({ type: "system-restart" })
                    Logger.success("Components and frontend transferred to device, rebooting...")
                    this.ui.store.flashConfigSuccess("Components and frontend transferred, rebooting...")
                } finally {
                    if (!watcherWasPaused) {
                        this.watcher.resume(false)
                        this.ui.store.updateStatus("watcher", "running")
                    }
                }

            } else if (action === "rebuild-builder") {

                Logger.info("Rebuilding Docker builder image...")
                await Runner.prepareDockerImage(undefined, true)
                Logger.success("Docker builder image rebuilt successfully")
                this.ui.store.flashConfigSuccess("Builder image rebuilt")

            } else if (action === "restart-service") {

                const client = this.sockets.get("client")
                if (!client.hasClients()) {
                    Logger.error("Cannot restart service: No device connected")
                    this.ui.store.setConfigBusy(false)
                    return
                }

                client.broadcast({ type: "system-restart-strux" })
                Logger.success("Restart command sent to device")
                this.ui.store.flashConfigSuccess("Strux service restart command sent")

            } else if (action === "reboot") {

                const client = this.sockets.get("client")
                if (!client.hasClients()) {
                    Logger.error("Cannot reboot: No device connected")
                    this.ui.store.setConfigBusy(false)
                    return
                }

                client.broadcast({ type: "system-restart" })
                Logger.success("Reboot command sent to device")
                this.ui.store.flashConfigSuccess("Reboot command sent to device")

            }

        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            Logger.error(`Config action failed: ${msg}`)
        } finally {
            this.ui.store.setConfigBusy(false)
        }

    }


    private async createFrontendTransferArchive(): Promise<string> {

        const frontendDir = join(Settings.projectPath, "dist", "cache", "frontend")
        if (!directoryExists(frontendDir)) {
            throw new Error(`Compiled frontend not found at ${frontendDir}`)
        }

        const archivePath = join(Settings.projectPath, "dist", "cache", "frontend-transfer.zip")
        await rm(archivePath, { force: true })

        const proc = Bun.spawn(["zip", "-rq", archivePath, "."], {
            cwd: frontendDir,
            stdout: "pipe",
            stderr: "pipe",
        })

        const stderr = await new Response(proc.stderr).text()
        const exitCode = await proc.exited
        if (exitCode !== 0) {
            throw new Error(stderr.trim() || `zip exited with code ${exitCode}`)
        }

        return archivePath

    }


    waitForComponentAck(destPath: string, timeoutMs = 30000): Promise<void> {

        const existing = this.componentAckWaiters.get(destPath)
        if (existing) {
            clearTimeout(existing.timeout)
            existing.reject(new Error(`Component ack waiter replaced for ${destPath}`))
            this.componentAckWaiters.delete(destPath)
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.componentAckWaiters.delete(destPath)
                reject(new Error(`Timed out waiting for component ack: ${destPath}`))
            }, timeoutMs)

            this.componentAckWaiters.set(destPath, {
                resolve: () => {
                    clearTimeout(timeout)
                    this.componentAckWaiters.delete(destPath)
                    resolve()
                },
                reject: (error) => {
                    clearTimeout(timeout)
                    this.componentAckWaiters.delete(destPath)
                    reject(error)
                },
                timeout,
            })
        })

    }


    handleComponentAck(destPath: string, status: "updated" | "error", message: string): void {

        const waiter = this.componentAckWaiters.get(destPath)
        if (!waiter) return

        if (status === "error") {
            waiter.reject(new Error(message || `Component transfer failed: ${destPath}`))
            return
        }

        waiter.resolve()

    }


    private handleFatalError(error: Error | unknown, type: string): void {

        if (error instanceof Error && error.name === "StruxExitError") {
            return
        }

        const errorMessage = error instanceof Error
            ? `${error.message}\n${error.stack ?? ""}`
            : String(error)

        Logger.error(`${type}: ${errorMessage}`)
        this.stop(1)

    }


    private registerErrorHandlers(): void {

        process.on("uncaughtException", (error) => {
            this.handleFatalError(error, "Uncaught Exception")
        })

        process.on("unhandledRejection", (error) => {
            this.handleFatalError(error, "Unhandled Rejection")
        })

        process.on("SIGINT", () => this.stop())
        process.on("SIGTERM", () => this.stop())

    }

}


// Entry point for the commander command
export async function dev(): Promise<void> {

    const server = DevServer.getInstance()
    await server.start()

}
