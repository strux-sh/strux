/***
 *
 *
 * Vite Dev Server
 *
 *
 */
import { Settings } from "../../settings"
import { Logger } from "../../utils/log"
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

    onOutput: ((line: string) => void) | null = null


    async start(): Promise<void> {

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

    }


    stop(): void {

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

        this.process = Bun.spawn([
            "docker", "run", "--rm",
            "--name", this.containerName,
            "-v", `${projectPath}:/project`,
            "-p", "5173:5173",
            "-w", "/project/frontend",
            "-e", "CHOKIDAR_USEPOLLING=true",
            "-e", "CHOKIDAR_INTERVAL=100",
            "-e", "FORCE_COLOR=1",
            Settings.builderImage,
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
