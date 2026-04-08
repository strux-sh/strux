/***
 *
 *
 * File Watcher
 *
 *
 */
import { join } from "path"
import { Settings } from "../../settings"
import { Logger } from "../../utils/log"
import { Runner } from "../../utils/run"
import { MainYAMLValidator } from "../../types/main-yaml"
import { compileApplication } from "../build/steps"
import { build as buildCommand } from "../build"
import { DevServer } from "./index"


const DEBOUNCE_MS = 300
const COOLDOWN_MS = 1000

const WATCH_EXTENSIONS = [".go", ".mod", ".sum", ".yaml"]
const IGNORE_DIRS = ["frontend/", "dist/", "assets/", "bsp/", "overlay/", ".git/"]


export class FileWatcher {

    private watcher: ReturnType<typeof import("chokidar").watch> | null = null
    private debounceTimer: ReturnType<typeof setTimeout> | null = null
    private cooldownUntil = 0
    private building = false
    private pendingBuild: "full" | "app" | null = null
    private pendingBuildFiles = new Set<string>()
    private _paused = false
    private changedWhilePaused = new Set<string>()

    onOutput: ((line: string) => void) | null = null
    onStatusChange: ((status: "running" | "building" | "idle" | "paused") => void) | null = null
    onFileChanged: ((path: string) => void) | null = null


    async start(projectRoot: string): Promise<void> {

        const chokidar = await import("chokidar")

        this.watcher = chokidar.watch(projectRoot, {
            persistent: true,
            ignoreInitial: true,
            ignored: (filePath: string) => {

                if (IGNORE_DIRS.some((d) => filePath.includes(d))) return true
                return false

            },
        })

        this.watcher.on("change", (path) => this.handleChange(path))
        this.watcher.on("add", (path) => this.handleChange(path))

        Logger.info("File watcher started")

    }


    stop(): void {

        this.watcher?.close()
        this.watcher = null

        if (this.debounceTimer) {

            clearTimeout(this.debounceTimer)
            this.debounceTimer = null

        }

    }


    get paused(): boolean { return this._paused }


    pause(): void {

        this._paused = true
        this.changedWhilePaused.clear()
        this.emit("Watcher paused")
        this.onStatusChange?.("paused")

    }


    resume(): void {

        this._paused = false
        const changed = this.changedWhilePaused
        this.changedWhilePaused = new Set()

        if (changed.size > 0) {
            // Determine build type from accumulated changes
            const hasYaml = [...changed].some((f) => f.endsWith(".yaml"))
            const buildType = hasYaml ? "full" as const : "app" as const
            this.emit(`Resumed with ${changed.size} pending change(s), triggering ${buildType} rebuild...`)
            this.triggerBuild(buildType)
        } else {
            this.emit("Watcher resumed")
        }

        this.onStatusChange?.("running")

    }


    private emit(line: string): void {

        if (this.onOutput) {
            this.onOutput(line)
        } else {
            Logger.info(`[watcher] ${line}`)
        }

    }


    private handleChange(path: string): void {

        if (!WATCH_EXTENSIONS.some((ext) => path.endsWith(ext))) return
        if (Date.now() < this.cooldownUntil) return

        this.onFileChanged?.(path)

        // When paused, accumulate changes but don't trigger builds
        if (this._paused) {
            this.changedWhilePaused.add(path)
            this.emit(`Changed (paused): ${path}`)
            return
        }

        const buildType = path.endsWith(".yaml") ? "full" : "app"

        // Queue with priority: full > app
        if (this.building) {

            this.pendingBuildFiles.add(path)

            if (!this.pendingBuild || buildType === "full") {
                this.pendingBuild = buildType
            }
            return

        }

        // Debounce rapid changes
        if (this.debounceTimer) clearTimeout(this.debounceTimer)

        this.debounceTimer = setTimeout(() => {
            this.triggerBuild(buildType)
        }, DEBOUNCE_MS)

    }


    private async triggerBuild(type: "full" | "app"): Promise<void> {

        this.building = true
        this.onStatusChange?.("building")
        this.emit(`File change detected, triggering ${type} rebuild...`)

        try {

            if (type === "full") {
                await this.fullRebuild()
            } else {
                await this.appRebuild()
            }

        } catch (error) {

            const msg = error instanceof Error ? error.message : String(error)
            this.emit(`Build failed: ${msg}`)
            Logger.error(`${type} rebuild failed: ${msg}`)

        }

        this.building = false
        this.onStatusChange?.("running")
        this.cooldownUntil = Date.now() + COOLDOWN_MS

        // Process queued build, but ignore if only go.mod/go.sum changed (build artifacts)
        if (this.pendingBuild) {

            const next = this.pendingBuild
            const files = this.pendingBuildFiles

            this.pendingBuild = null
            this.pendingBuildFiles = new Set()

            const isOnlyGoModSum = [...files].every((f) =>
                f.endsWith("go.mod") || f.endsWith("go.sum")
            )

            if (!isOnlyGoModSum) {
                this.triggerBuild(next)
            }

        }

    }


    private async appRebuild(): Promise<void> {

        // Skip per-step chown for speed, single pass after
        Runner.skipChown = true

        try {
            await compileApplication()
        } finally {
            Runner.skipChown = false
            if (!Settings.noChown) {
                await Runner.chownProjectFiles()
            }
        }

        this.emit("Application compiled, sending to device...")

        await this.sendBinaryToDevice()

    }


    private async fullRebuild(): Promise<void> {

        Settings.isDevMode = true

        // Reload config in case YAML changed
        MainYAMLValidator.validateAndLoad()

        await buildCommand()

        this.emit("Full rebuild complete")

    }


    private async sendBinaryToDevice(): Promise<void> {

        const dev = DevServer.getInstance()
        const client = dev.sockets.get("client")

        if (!client.hasClients()) {

            this.emit("No device connected, skipping binary push")
            return

        }

        const bspName = Settings.bspName!
        const binaryPath = join(Settings.projectPath, "dist", "cache", bspName, "app", "main")
        const binaryFile = Bun.file(binaryPath)

        if (!await binaryFile.exists()) {

            this.emit(`Compiled binary not found at ${binaryPath}`)
            return

        }

        const binaryData = Buffer.from(await binaryFile.arrayBuffer())
        const base64 = binaryData.toString("base64")

        client.broadcast({ type: "binary-new", payload: { data: base64 } })

        this.emit("Binary sent to device")

    }

}
