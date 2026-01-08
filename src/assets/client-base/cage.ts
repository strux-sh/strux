/***
 *
 *
 *  Cage and Cog Launcher
 *
 */
import { Logger } from "./logger"
import { SocketService } from "./socket"
import { spawn } from "child_process"
import { promisify } from "util"
import { exec } from "child_process"

const execAsync = promisify(exec)

export interface LaunchOptions {
    cogUrl: string
    displayResolution?: string
    splashImage?: string
    waitForBackend?: boolean
}

export class CageLauncherClass {

    private cageProcess: ReturnType<typeof spawn> | null = null
    private readonly cageStreamId = "cage"

    /**
     * Wait for backend to be ready on port 8080
     */
    async waitForBackend(timeoutSeconds = 60): Promise<boolean> {
        Logger.info("CageLauncher", "Waiting for backend on port 8080...")
        const startTime = Date.now()
        const timeout = timeoutSeconds * 1000

        while (Date.now() - startTime < timeout) {
            try {
                // Try to connect to backend
                const response = await fetch("http://localhost:8080", {
                    method: "HEAD",
                    signal: AbortSignal.timeout(1000),
                })
                if (response.ok) {
                    Logger.info("CageLauncher", "Backend is ready!")
                    return true
                }
            } catch (_error) {
                // Backend not ready yet, continue waiting
            }
            await Bun.sleep(500)
        }

        Logger.error("CageLauncher", `Backend did not start within ${timeoutSeconds} seconds`)
        return false
    }

    /**
     * Set display resolution using wlr-randr
     */
    async setDisplayResolution(resolution: string): Promise<void> {
        try {
            Logger.info("CageLauncher", `Setting display resolution to: ${resolution}`)
            await execAsync(`wlr-randr --output Virtual-1 --mode "${resolution}" 2>/dev/null || true`)
        } catch (_error) {
            Logger.warn("CageLauncher", "Failed to set display resolution")
        }
    }

    /**
     * Launch Cage compositor and Cog browser
     */
    async launchCageAndCog(options: LaunchOptions): Promise<void> {
        const {
            cogUrl,
            displayResolution = "1920x1080",
            splashImage,
            waitForBackend = true,
        } = options

        Logger.info("CageLauncher", `Preparing to launch Cage and Cog with URL: ${cogUrl}`)

        // Wait for backend if requested
        if (waitForBackend) {
            const backendReady = await this.waitForBackend()
            if (!backendReady) {
                Logger.error("CageLauncher", "Backend not ready, cannot launch Cage/Cog")
                throw new Error("Backend not ready")
            }
        }

        // Prepare cage arguments
        const cageArgs: string[] = []
        if (splashImage) {
            cageArgs.push(`--splash-image=${splashImage}`)
        }

        // Build the command to run inside Cage
        // This sets the resolution and then launches Cog
        const cageCommand = [
            ...cageArgs,
            "--",
            "sh",
            "-c",
            `wlr-randr --output Virtual-1 --mode "${displayResolution}" 2>/dev/null || true; exec cog "${cogUrl}" --web-extensions-dir=/usr/lib/wpe-web-extensions`,
        ]

        Logger.info("CageLauncher", "Starting Cage compositor...")

        // Launch Cage with the command
        this.cageProcess = spawn("cage", cageCommand, {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                WPE_WEB_EXTENSION_PATH: "/usr/lib/wpe-web-extensions",
                SEATD_SOCK: "/run/seatd.sock",
                WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: "1",
                WEBKIT_FORCE_SANDBOX: "0",
            },
        })

        // Redirect output to log files and socket
        const cageLogPath = "/tmp/strux-cage.log"
        const cageLogWriter = await Bun.file(cageLogPath).writer()

        // Helper function to emit log line to socket if connected
        const emitLogLine = (line: string) => {
            if (SocketService.isConnected() && SocketService.getSocket()) {
                try {
                    SocketService.getSocket()?.emit("log-line", {
                        streamId: this.cageStreamId,
                        line,
                        service: "cage",
                        timestamp: new Date().toISOString(),
                    })
                } catch (_error) {
                    // Ignore socket errors, continue logging to file
                }
            }
        }

        // Redirect stdout and stderr to log file and socket
        if (this.cageProcess.stdout) {
            this.cageProcess.stdout.on("data", (data) => {
                try {
                    // Write to file
                    cageLogWriter.write(data)

                    // Also send to socket if connected
                    const text = data.toString()
                    const lines = text.split("\n")
                    for (const line of lines) {
                        if (line.trim()) {
                            emitLogLine(line)
                        }
                    }
                } catch {
                    // Ignore write errors
                }
            })
        }
        if (this.cageProcess.stderr) {
            this.cageProcess.stderr.on("data", (data) => {
                try {
                    // Write to file
                    cageLogWriter.write(data)

                    // Also send to socket if connected
                    const text = data.toString()
                    const lines = text.split("\n")
                    for (const line of lines) {
                        if (line.trim()) {
                            emitLogLine(line)
                        }
                    }
                } catch {
                    // Ignore write errors
                }
            })
        }

        // Close writer when process exits
        this.cageProcess.on("exit", () => {
            try {
                cageLogWriter.end()
            } catch {
                // Ignore close errors
            }
        })

        this.cageProcess.on("exit", (code) => {
            Logger.info("CageLauncher", `Cage exited with code: ${code}`)
            this.cageProcess = null
        })

        this.cageProcess.on("error", (error) => {
            Logger.error("CageLauncher", `Cage process error: ${error}`)
        })

        Logger.info("CageLauncher", "Cage and Cog launched successfully")
    }

    /**
     * Cleanup processes
     */
    cleanup(): void {
        if (this.cageProcess) {
            Logger.info("CageLauncher", "Cleaning up Cage process...")
            this.cageProcess.kill()
            this.cageProcess = null
        }
    }
}

export const CageLauncher = new CageLauncherClass()

