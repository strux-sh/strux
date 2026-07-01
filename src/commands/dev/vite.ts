/***
 *
 *
 * Vite Dev Server
 *
 *
 */
import { Settings } from "../../settings"
import { Logger } from "../../utils/log"
import { Runner } from "../../utils/run"
import type { Subprocess } from "bun"


/** Env for Vite/npm child: stdout is piped (not a TTY), so picocolors would strip colors unless forced. */
function viteChildEnv(): NodeJS.ProcessEnv {

    const env = { ...process.env, FORCE_COLOR: "1" } as Record<string, string | undefined>
    delete env.NO_COLOR
    return env as NodeJS.ProcessEnv

}


export class ViteManager {

    private process: Subprocess | null = null
    private containerName = "strux-vite-dev"
    private stopping = false

    onOutput: ((line: string) => void) | null = null
    // Fired when the Vite process exits without an explicit stop() — e.g. the
    // container fails to launch or the dev server crashes. Lets the TUI flip the
    // Vite status to "error" instead of leaving it green.
    onExit: ((code: number | null) => void) | null = null


    async start(): Promise<void> {

        this.stopping = false
        Logger.info("Starting Vite dev server...")

        // Clean up any leftover container from a previous crash
        if (!Settings.inContainer) {

            await Bun.$`docker rm -f ${this.containerName}`.quiet().nothrow()

        }

        if (Settings.inContainer) {

            await this.startDirect()

        } else {

            await this.startDocker()

        }

        Logger.info("Vite dev server started on http://localhost:5173")

        // Stream stdout/stderr
        this.streamOutput()

        // Watch for an unexpected exit (e.g. the builder image is missing, the
        // container fails to launch, or the dev server crashes) so the TUI can
        // show it failed rather than leaving the status green.
        this.watchExit()

    }


    private watchExit(): void {

        const proc = this.process
        if (!proc) return

        void proc.exited.then((code) => {
            if (this.stopping) return
            this.process = null
            this.emit(`Vite dev server exited unexpectedly (exit code ${code})`)
            this.onExit?.(code)
        })

    }


    stop(): void {

        this.stopping = true

        if (this.process) {

            this.process.kill()
            this.process = null

        }

        // Fallback: stop the Docker container if running on host
        if (!Settings.inContainer) {

            Bun.$`docker stop -t 3 ${this.containerName}`.quiet().nothrow()

        }

        Logger.info("Vite dev server stopped")

    }


    private emit(line: string): void {

        if (this.onOutput) {
            this.onOutput(line)
        } else {
            Logger.info(`[vite] ${line}`)
        }

    }


    private async startDocker(): Promise<void> {

        const projectPath = process.cwd()

        // Ensure the local "strux-builder" image exists before running it. The
        // dev startup does not otherwise prepare it before Vite starts, and
        // (unlike a versioned GHCR tag) a local tag is never auto-pulled by
        // `docker run`. prepareDockerImage pulls+tags the published image, or
        // builds it from the Dockerfile when the version isn't published.
        await Runner.prepareDockerImage()

        this.process = Bun.spawn([
            "docker", "run", "--rm",
            "--name", this.containerName,
            "-v", `${projectPath}:/project`,
            "-p", "5173:5173",
            "-w", "/project/frontend",
            "-e", "CHOKIDAR_USEPOLLING=true",
            "-e", "CHOKIDAR_INTERVAL=100",
            "-e", "FORCE_COLOR=1",
            // Use the locally-prepared builder tag (Runner.prepareDockerImage pulls
            // the versioned GHCR image and tags it "strux-builder", or builds it
            // from the Dockerfile when the version isn't published — e.g. an
            // unreleased dev version). Running Settings.builderImage directly would
            // try to pull ghcr.io/…:<version> and fail for unpublished versions.
            "strux-builder",
            "/bin/bash", "-c", "npm install && npm run dev -- --host 0.0.0.0 --port 5173",
        ], {
            stdio: ["pipe", "pipe", "pipe"],
        })

    }


    private async startDirect(): Promise<void> {

        this.process = Bun.spawn([
            "/bin/bash", "-c",
            "cd /project/frontend && npm install && npm run dev -- --host 0.0.0.0 --port 5173",
        ], {
            stdio: ["pipe", "pipe", "pipe"],
            env: viteChildEnv(),
        })

    }


    private async streamOutput(): Promise<void> {

        if (!this.process) return

        for (const stream of [this.process.stdout, this.process.stderr]) {

            if (!stream || typeof stream === "number") continue

            const reader = (stream as ReadableStream<Uint8Array>).getReader()
            const decoder = new TextDecoder()
            let buffer = ""

            const read = async () => {

                while (true) {

                    const { done, value } = await reader.read()
                    if (done) break

                    buffer += decoder.decode(value, { stream: true })
                    const lines = buffer.split("\n")
                    buffer = lines.pop() ?? ""

                    for (const line of lines) {

                        if (line.trim()) this.emit(line)

                    }

                }

                // Flush remaining buffer
                if (buffer.trim()) this.emit(buffer)

            }

            read()

        }

    }

}
