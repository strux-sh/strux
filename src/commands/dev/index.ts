/***
 *
 *
 * Dev Command
 *
 *
 */
import { join } from "path"
import { Settings } from "../../settings"
import { Logger } from "../../utils/log"
import { MainYAMLValidator } from "../../types/main-yaml"
import { fileExists } from "../../utils/path"
import { build as buildCommand } from "../build"
import { compileApplication, compileCage, compileWPE, compileScreen, buildStruxClient } from "../build/steps"
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


        // Run the initial build
        if (!Settings.isRemoteOnly) {
            await this.initialBuild()
        }

        // Register error handlers
        this.registerErrorHandlers()

        // Start the TUI and route Logger through it
        if (process.env.STRUX_DEV_NO_UI !== "1") {

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
                this.ui.store.appendLog("device", {
                    level: entry.level,
                    message: entry.message,
                    formatted: entry.formatted,
                    timestamp: Date.now(),
                })
            })

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

                if (Settings.localBuilder) {
                    Logger.info("Rebuilding Docker builder image (--local-builder)...")
                    await Runner.prepareDockerImage()
                }

                Logger.info("Rebuilding Strux components...")

                Runner.skipChown = true
                try {
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

                const cagePath = join(Settings.projectPath, "dist", "cache", bspName, "cage")
                const wpePath = join(Settings.projectPath, "dist", "cache", bspName, "libstrux-extension.so")
                const clientPath = join(Settings.projectPath, "dist", "cache", bspName, "client")
                const cogPath = join(Settings.projectPath, "dist", "cache", bspName, "cog")
                const screenPath = join(Settings.projectPath, "dist", "cache", bspName, "screen")

                const sendComponent = async (filePath: string, destPath: string) => {
                    const file = Bun.file(filePath)
                    if (!await file.exists()) return
                    const data = Buffer.from(await file.arrayBuffer()).toString("base64")
                    client.broadcast({ type: "component", payload: { data, destPath } })
                }

                await sendComponent(cagePath, "/usr/bin/cage")
                await sendComponent(wpePath, "/usr/lib/wpe-web-extensions/libstrux-extension.so")
                await sendComponent(clientPath, "/strux/client")
                await sendComponent(cogPath, "/usr/bin/cog")
                await sendComponent(screenPath, "/usr/bin/strux-screen")

                // Send scripts
                const scriptsDir = join(Settings.projectPath, "dist", "artifacts", "scripts")
                await sendComponent(join(scriptsDir, "init.sh"), "/init")
                await sendComponent(join(scriptsDir, "strux.sh"), "/strux/strux.sh")
                await sendComponent(join(scriptsDir, "strux-network.sh"), "/usr/bin/strux-network.sh")
                await sendComponent(join(scriptsDir, "strux-run-cog.sh"), "/strux/strux-run-cog.sh")

                // Send cage env if it exists
                const cageEnvPath = join(Settings.projectPath, "dist", "cache", bspName, ".cage-env")
                await sendComponent(cageEnvPath, "/strux/.cage-env")

                // Reboot after transfer
                setTimeout(() => {
                    Logger.info("Sending reboot command to device...")
                    client.broadcast({ type: "system-restart" })
                }, 2000)

                Logger.success("Components transferred to device, rebooting...")
                this.ui.store.flashConfigSuccess("Components transferred, rebooting...")

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
