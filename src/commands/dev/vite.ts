/***
 *
 *
 * Vite Dev Server
 *
 *
 */
import { Settings } from "../../settings"
import { Logger } from "../../utils/log"
import { frontendDockerMounts, frontendEnvironment, resolveFrontendLayout } from "../../utils/frontend-layout"
import { appendDockerMountArguments, Runner } from "../../utils/run"
import type { Subprocess } from "bun"

const VITE_DEV_SCRIPT = `
set -eo pipefail
cd "$FRONTEND_INSTALL_DIR"
workspace_args=()
if [[ -n "$FRONTEND_WORKSPACE_PACKAGE" ]]; then
    workspace_args+=(--workspace "$FRONTEND_WORKSPACE_PACKAGE")
fi
npm install "\${workspace_args[@]}"
npm run "$FRONTEND_DEV_SCRIPT" "\${workspace_args[@]}" -- --host 0.0.0.0 --port 5173
`.trim()

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

        // Watch for an unexpected exit so the TUI can show a failed Vite process.
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

            // DevServer.stop() exits the process immediately afterward, so ensure
            // the container is removed before returning.
            Bun.spawnSync(["docker", "rm", "-f", this.containerName], {
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
            })

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

        const frontendLayout = resolveFrontendLayout()
        const frontendEnv = frontendEnvironment(frontendLayout)

        // Ensure the local "strux-builder" image exists before running it. The
        // dev startup does not otherwise prepare it before Vite starts, and
        // (unlike a versioned GHCR tag) a local tag is never auto-pulled by
        // `docker run`. prepareDockerImage pulls+tags the published image, or
        // builds it from the Dockerfile when the version isn't published.
        await Runner.prepareDockerImage()

        const args = [
            "docker", "run", "--rm",
            "--name", this.containerName,
            "-p", "5173:5173",
            "-w", frontendLayout.containerInstallDirectory,
            "-e", "CHOKIDAR_USEPOLLING=true",
            "-e", "CHOKIDAR_INTERVAL=100",
            "-e", "FORCE_COLOR=1",
        ]

        for (const [key, value] of Object.entries(frontendEnv)) args.push("-e", `${key}=${value}`)
        appendDockerMountArguments(args, frontendDockerMounts(frontendLayout))

        // Use the locally-prepared builder tag so unreleased versions use the image prepared above.
        args.push("strux-builder", "/bin/bash", "-c", VITE_DEV_SCRIPT)

        this.process = Bun.spawn(args, {
            stdio: ["pipe", "pipe", "pipe"],
        })

    }


    private async startDirect(): Promise<void> {

        const frontendLayout = resolveFrontendLayout()

        this.process = Bun.spawn(["/bin/bash", "-c", VITE_DEV_SCRIPT], {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: frontendLayout.installDirectory,
            env: { ...viteChildEnv(), ...frontendEnvironment(frontendLayout, true) },
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
