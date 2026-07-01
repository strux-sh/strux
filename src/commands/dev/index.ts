/***
 *
 *
 * Dev Command
 *
 *
 */
import { join } from "path"
import { readdir, rm, stat } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { Settings } from "../../settings"
import { Logger } from "../../utils/log"
import { MainYAMLValidator } from "../../types/main-yaml"
import { BSPYamlValidator } from "../../types/bsp-yaml"
import { directoryExists, fileExists } from "../../utils/path"
import { build as buildCommand } from "../build"
import { runFlashScripts, type FlashOutputSource } from "../flash"
import { compileApplication, compileCage, compileFrontend, compileWPE, compileScreen, buildStruxClient } from "../build/steps"
import { regenerateArtifacts } from "../build/artifacts"
import { Runner } from "../../utils/run"
import { loadBuildCacheManifest, shouldRebuildStep, updateStepCache } from "../build/cache"
import { Socket, SocketManager } from "./socket-manager"
import { QEMUManager } from "./qemu"
import { ViteManager } from "./vite"
import { FileWatcher } from "./watcher"
import { MDNSPublisher } from "./mdns"
import { DevUI } from "./ui"
import { SSHManager } from "./ssh"
import { registerClientHandlers } from "./handlers/client"
import { registerScreenHandlers } from "./handlers/screen"
import { registerWebUIHandlers } from "./handlers/webui"
import type { ClientMessageSendable, ClientMessageReceivable, ScreenMessageSendable, ScreenMessageReceivable, WebUIMessageSendable, WebUIMessageReceivable, DeviceInfoOutputInfo, DeviceStatus, DashboardLogLine, DevBuildState } from "./types"


const DEV_UI_NOT_BUILT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>STRUX dev</title></head>` +
    `<body style="margin:0;font-family:ui-monospace,monospace;background:#0a0a1e;color:#eeeef6;display:flex;` +
    `align-items:center;justify-content:center;height:100vh"><div style="text-align:center">` +
    `<h2 style="color:#8b5cf6;letter-spacing:.2em">STRUX // DEV UI NOT BUILT</h2>` +
    `<p style="color:#a0a0cc">Run <code style="color:#34ffaa">bun run build:web-ui</code> and reload.</p></div></body></html>`


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
    // Latest outputs reported by the device; replayed to web-ui viewers on connect.
    deviceOutputs: DeviceInfoOutputInfo[] = []
    // Dashboard state mirrored to web-ui viewers (also snapshotted on connect).
    deviceStatus: DeviceStatus = { connected: false }
    buildState: { state: DevBuildState, label?: string } = { state: "idle" }
    dashboardLogs: DashboardLogLine[] = []
    private static readonly MAX_DASHBOARD_LOGS = 300
    private webUiHtmlCache: string | null = null
    private componentAckWaiters = new Map<string, {
        resolve: () => void
        reject: (error: Error) => void
        timeout: ReturnType<typeof setTimeout>
    }>()
    private systemUpdateAckWaiter: {
        resolve: () => void
        reject: (error: Error) => void
        timeout: ReturnType<typeof setTimeout>
    } | null = null
    private updateBundleRoutes = new Map<string, string>()


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


        this.loadFlashCapability()


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
            this.ui.store.setCanFlash(this.activeBspHasFlashScript())

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
                    this.ui.store.setCanFlash(this.activeBspHasFlashScript())
                }

            }

        }

        // Set up websocket servers
        const client = this.sockets.create<ClientMessageSendable, ClientMessageReceivable>("client", { path: "/client", aliases: ["/ws"] })
        const screen = this.sockets.create<ScreenMessageSendable, ScreenMessageReceivable>("screen", { path: "/screen", auth: false, aliases: ["/ws/screen"] })
        const webui = this.sockets.create<WebUIMessageSendable, WebUIMessageReceivable>("webui", { path: "/devtool/ws", auth: false })
        this.sockets.setHTTPRouteHandler((req) => this.handleHTTPRoute(req))

        // Register handlers
        registerClientHandlers(client)
        registerScreenHandlers(screen)
        registerWebUIHandlers(webui)

        // Start the server FIRST so the device can connect immediately.
        const serverPort = Settings.main?.dev?.server?.fallback_hosts?.[0]?.port ?? 8000
        this.sockets.listen({ port: serverPort, authKey: this.clientKey })
        Logger.info(`Dev server listening on port ${serverPort}`)
        Logger.info(`Dev tool: http://localhost:${serverPort}/screen`)

        // Build the dev UI in the background — never block device connections on it.
        this.ensureWebUIBuilt().catch(() => { /* best-effort */ })

        // Wire subsystem output to TUI tabs
        this.vite.onOutput = (line) => {
            this.ui.store.appendLog("vite", { level: "info", message: line, timestamp: Date.now() })
        }
        this.vite.onExit = () => {
            // Vite died (e.g. the builder image is missing / container failed to
            // launch) — surface it as a failure instead of a green "running" icon.
            this.ui.store.updateStatus("vite", "error")
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
            this.setBuildState(status === "building" ? "building" : "idle", status === "building" ? "Rebuilding" : undefined)
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


    private activeBspHasFlashScript(): boolean {

        return Settings.bsp?.scripts?.some((script) => script.step === "flash_script") ?? false

    }


    private loadFlashCapability(): void {

        if (!Settings.bspName) return

        const bspYamlPath = join(Settings.projectPath, "bsp", Settings.bspName, "bsp.yaml")
        if (!fileExists(bspYamlPath)) return

        const result = BSPYamlValidator.safeValidate(bspYamlPath)
        if (!result.success || !result.data) return

        Settings.bsp = result.data.bsp

    }


    async handleConfigAction(action: string): Promise<void> {

        this.ui.store.setConfigBusy(true)

        try {

            if (action === "restore") {

                Logger.info("Restoring all artifacts to built-in versions...")
                await regenerateArtifacts()
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
                        // Source dirs (client/cage/wpe/screen) are derived — refresh
                        // them from embedded before compiling, since this path runs
                        // outside the full build pipeline that normally does it.
                        await regenerateArtifacts()
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

            } else if (action === "install-update") {

                const client = this.sockets.get<ClientMessageSendable, ClientMessageReceivable>("client")
                if (!client.hasClients()) {
                    Logger.error("Cannot install update: No device connected")
                    this.ui.store.setConfigBusy(false)
                    return
                }

                const bundlePath = await this.findLatestUpdateBundle()
                await this.sendSystemUpdateBundle(client, bundlePath)

                Logger.success("System update accepted by device")
                this.ui.store.flashConfigSuccess("System update accepted; device will reboot")

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

            } else if (action === "flash") {

                if (!this.activeBspHasFlashScript()) {
                    throw new Error(`Not Available for this BSP: ${Settings.bspName ?? "unknown"} does not define a flash_script in bsp.yaml.`)
                }

                this.ui.store.clearLogs("flash")
                this.ui.store.updateStatus("flash", "running")
                this.ui.store.appendLog("flash", {
                    level: "info",
                    message: `Running flash scripts for BSP ${Settings.bspName ?? Settings.main?.bsp ?? "unknown"}`,
                    timestamp: Date.now(),
                })

                const outputLevel = (source: FlashOutputSource) => source === "stderr" ? "raw" : source === "system" ? "info" : "raw"
                await runFlashScripts({
                    onOutput: (data, source) => {
                        this.ui.store.appendLog("flash", {
                            level: outputLevel(source),
                            message: data,
                            timestamp: Date.now(),
                        })
                    },
                })

                this.ui.store.updateStatus("flash", "idle")
                this.ui.store.flashConfigSuccess("Flash completed")

            }

        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            Logger.error(`Config action failed: ${msg}`)
            if (action === "flash") {
                this.ui.store.updateStatus("flash", "error")
                this.ui.store.appendLog("flash", {
                    level: "error",
                    message: msg,
                    timestamp: Date.now(),
                })
            }
        } finally {
            this.ui.store.setConfigBusy(false)
        }

    }


    private isAuthorizedControlRequest(req: Request): boolean {

        const url = new URL(req.url)
        const keyFromParam = url.searchParams.get("key")
        if (keyFromParam && keyFromParam === this.clientKey) return true

        const authHeader = req.headers.get("authorization")
        if (authHeader === `Bearer ${this.clientKey}`) return true

        const legacyKey = req.headers.get("x-client-key")
        return Boolean(legacyKey && legacyKey === this.clientKey)

    }


    // --- Dashboard data relay (web-ui) ---
    // State updates are cached (for the on-connect snapshot) and broadcast to
    // viewers. Null-safe: callable before the webui socket exists (e.g. during
    // the initial build) — it just updates the cache with no live viewers.

    private webuiSocket(): Socket<WebUIMessageSendable, WebUIMessageReceivable> | null {
        try {
            return this.sockets.get<WebUIMessageSendable, WebUIMessageReceivable>("webui")
        } catch {
            return null
        }
    }

    setDeviceStatus(patch: Partial<DeviceStatus>): void {
        this.deviceStatus = { ...this.deviceStatus, ...patch }
        this.webuiSocket()?.broadcast({ type: "device-status", payload: this.deviceStatus })
    }

    pushDashboardLog(entry: DashboardLogLine): void {
        this.dashboardLogs.push(entry)
        if (this.dashboardLogs.length > DevServer.MAX_DASHBOARD_LOGS) this.dashboardLogs.shift()
        this.webuiSocket()?.broadcast({ type: "log-line", payload: entry })
    }

    setBuildState(state: DevBuildState, label?: string): void {
        this.buildState = { state, label }
        this.webuiSocket()?.broadcast({ type: "build-status", payload: this.buildState })
    }


    // Load the embedded single-file dev tool. Embedded at compile time in the
    // binary; read from disk (or a friendly placeholder) when run from source.
    private async loadWebUIHtml(): Promise<string> {

        if (this.webUiHtmlCache) return this.webUiHtmlCache

        try {
            const mod = await import("./web-ui-asset")
            this.webUiHtmlCache = mod.default
            return this.webUiHtmlCache
        } catch { /* not embedded / dist not built */ }

        try {
            const file = Bun.file(join(import.meta.dir, "../../web-ui/dist/index.html"))
            if (await file.exists()) {
                this.webUiHtmlCache = await file.text()
                return this.webUiHtmlCache
            }
        } catch { /* fall through to placeholder */ }

        return DEV_UI_NOT_BUILT_HTML
    }


    // Build the dev UI on first run from source if it hasn't been built yet.
    // No-op in the compiled binary (no web-ui source dir on disk).
    private async ensureWebUIBuilt(): Promise<void> {

        const webUiDir = join(import.meta.dir, "../../web-ui")
        if (!directoryExists(webUiDir)) return
        if (fileExists(join(webUiDir, "dist", "index.html"))) return

        Logger.info("Building dev UI (first run)...")
        try {
            await Bun.$`bun run build-only`.cwd(webUiDir).quiet()
            Logger.success("Dev UI built")
        } catch {
            Logger.warning("Could not build dev UI automatically — run 'bun run build:web-ui'")
        }

    }


    private async handleHTTPRoute(req: Request): Promise<Response | null> {

        const url = new URL(req.url)

        // Serve the single-file dev tool for its client-side routes.
        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/screen")) {
            const html = await this.loadWebUIHtml()
            return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
        }

        if (url.pathname === "/__strux/dev/system-update") {
            if (req.method !== "POST") {
                return new Response("Method not allowed", { status: 405 })
            }
            if (!this.isAuthorizedControlRequest(req)) {
                return new Response("Unauthorized", { status: 401 })
            }

            const client = this.sockets.get<ClientMessageSendable, ClientMessageReceivable>("client")
            if (!client.hasClients()) {
                return new Response("No connected client", { status: 409 })
            }

            let requestedPath = ""
            if ((req.headers.get("content-type") ?? "").includes("application/json")) {
                const payload = await req.json().catch(() => ({})) as { path?: string }
                requestedPath = payload.path ?? ""
            }

            const bundlePath = requestedPath || await this.findLatestUpdateBundle()
            if (!fileExists(bundlePath)) {
                return new Response(`Update bundle not found: ${bundlePath}`, { status: 404 })
            }

            Logger.info(`CLI requested system update: ${bundlePath}`)

            try {
                await this.sendSystemUpdateBundle(client, bundlePath)
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return new Response(message, { status: 500 })
            }

            return new Response("System update accepted by device")
        }

        const match = url.pathname.match(/^\/__strux\/updates\/([^/]+)$/)
        if (!match) return null

        const token = match[1] ?? ""
        const bundlePath = this.updateBundleRoutes.get(token)
        if (!bundlePath) {
            return new Response("Update bundle not found", { status: 404 })
        }

        const file = Bun.file(bundlePath)
        return new Response(file, {
            headers: {
                "content-type": "application/octet-stream",
                "content-disposition": `attachment; filename="${bundlePath.split("/").pop() ?? "update.struxb"}"`,
            },
        })

    }


    private async findLatestUpdateBundle(): Promise<string> {

        const bspName = Settings.bspName!
        const outputDir = join(Settings.projectPath, "dist", "output", bspName)
        const entries = await readdir(outputDir, { withFileTypes: true }).catch(() => [])
        const bundles = await Promise.all(entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".struxb"))
            .map(async (entry) => {
                const path = join(outputDir, entry.name)
                const info = await stat(path)
                return { path, mtimeMs: info.mtimeMs }
            }))

        bundles.sort((a, b) => b.mtimeMs - a.mtimeMs)
        const latest = bundles[0]
        if (!latest) {
            throw new Error(`No .struxb update bundle found in ${outputDir}. Run strux update bundle first.`)
        }

        return latest.path

    }


    private registerUpdateBundleRoute(bundlePath: string): string {

        const token = randomUUID()
        this.updateBundleRoutes.set(token, bundlePath)

        return `/__strux/updates/${token}`

    }


    private async sendSystemUpdateBundle(client: Socket<ClientMessageSendable, ClientMessageReceivable>, bundlePath: string): Promise<void> {

        const clients = [...client.getClients()]
        if (clients.length === 0) {
            throw new Error("No connected client")
        }
        if (clients.length > 1) {
            throw new Error("Multiple Strux clients are connected; update target selection is not implemented yet.")
        }

        const ws = clients[0]!
        const routePath = this.registerUpdateBundleRoute(bundlePath)
        const bundleURL = new URL(routePath, client.getClientHTTPBaseURL(ws)).toString()

        Logger.info(`Sending system update URL to device: ${bundleURL}`)

        const ack = this.waitForSystemUpdateAck()
        client.send(ws, { type: "system-update", payload: { url: bundleURL } })
        await ack

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


    waitForSystemUpdateAck(timeoutMs = 30000): Promise<void> {

        if (this.systemUpdateAckWaiter) {
            clearTimeout(this.systemUpdateAckWaiter.timeout)
            this.systemUpdateAckWaiter.reject(new Error("System update ack waiter replaced"))
            this.systemUpdateAckWaiter = null
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.systemUpdateAckWaiter = null
                reject(new Error("Timed out waiting for system update ack"))
            }, timeoutMs)

            this.systemUpdateAckWaiter = {
                resolve: () => {
                    clearTimeout(timeout)
                    this.systemUpdateAckWaiter = null
                    resolve()
                },
                reject: (error) => {
                    clearTimeout(timeout)
                    this.systemUpdateAckWaiter = null
                    reject(error)
                },
                timeout,
            }
        })

    }


    handleSystemUpdateAck(status: "pending" | "error", message: string): void {

        const waiter = this.systemUpdateAckWaiter
        if (!waiter) return

        if (status === "error") {
            waiter.reject(new Error(message || "System update failed"))
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
