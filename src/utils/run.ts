/***
 *
 *
 *  Running Utilities
 *
 */

import { Spinner, Logger } from "./log"
import { Settings } from "../settings"
import { mkdir } from "fs/promises"
import { join } from "path"

// @ts-ignore
import scriptsBaseDockerfile from "../assets/scripts-base/Dockerfile" with { type: "text" }

/**
 * Computes the hash of the Dockerfile content
 */
export function getDockerfileHash(): string {
    return Bun.hash(scriptsBaseDockerfile).toString(16)
}

export interface RunnerOptions {
    message: string
    messageOnSuccess?: string
    messageOnError?: string
    alwaysShowOutput?: boolean
    cwd?: string
    exitOnError?: boolean
    env?: Record<string, string>
}

export class RunnerClass {

    private dockerImageReady = false

    /**
     * When true, runScriptInDocker skips the per-script chown.
     * Set this during the build pipeline and call chownProjectFiles() once at the end.
     */
    public skipChown = false

    /**
     * Gets the current user ID and group ID for passing to Docker container
     * Returns null on Windows (Docker Desktop handles permissions automatically)
     */
    private getHostUserInfo(): { uid: number; gid: number } | null {
        // On Windows, Docker Desktop handles permissions automatically
        if (process.platform === "win32") {
            return null
        }

        const uid = process.getuid?.()
        const gid = process.getgid?.()

        if (uid !== undefined && gid !== undefined) {
            return { uid, gid }
        }

        return null
    }

    public async runCommand(command: string, options: RunnerOptions) {
        const spinner = new Spinner(options.message)
        // If verbose mode is enabled, don't use spinner (it interferes with output)
        if (!Settings.verbose) {
            spinner.start()
        } else {
            // In verbose mode, just log the message
            Logger.log(options.message)
        }

        const args = command.split(" ")
        let stdout = ""
        let stderr = ""

        const proc = Bun.spawn(args, {
            stdout: "pipe",
            stderr: "pipe",
            cwd: options.cwd ?? process.cwd(),
            env: options.env ?? process.env
        })

        // Process stdout stream
        const stdoutPromise = (async () => {
            const decoder = new TextDecoder()
            for await (const chunk of proc.stdout) {
                const text = decoder.decode(chunk, { stream: true })
                stdout += text

                // In verbose mode, output everything immediately
                if (Settings.verbose) {
                    // Route through Logger when UI is active, otherwise write directly
                    if (Logger.hasSink()) {
                        Logger.raw(text)
                    } else {
                        process.stdout.write(text)
                    }
                }

                // Parse for progress markers line by line
                const lines = text.split("\n")
                for (const line of lines) {
                    const marker = "STRUX_PROGRESS:"
                    const idx = line.indexOf(marker)
                    if (idx >= 0) {
                        const msg = line.substring(idx + marker.length).trim()
                        if (msg) {
                            if (Settings.verbose) {
                                // In verbose mode, progress markers are already in the output above
                                // No need to log separately
                            } else {
                                spinner.updateMessage(msg)
                            }
                        }
                    }
                }
            }
        })()

        // Process stderr stream
        const stderrPromise = (async () => {
            const decoder = new TextDecoder()
            for await (const chunk of proc.stderr) {
                const text = decoder.decode(chunk, { stream: true })
                stderr += text

                // Output stderr if verbose is enabled
                if (Settings.verbose) {
                    // Route through Logger when UI is active, otherwise write directly
                    if (Logger.hasSink()) {
                        Logger.raw(text)
                    } else {
                        process.stderr.write(text)
                    }
                }
            }
        })()

        // Wait for both streams to finish and process to exit
        await Promise.all([stdoutPromise, stderrPromise])
        const exitCode = await proc.exited

        if (exitCode === 0) {
            const successMessage = options.messageOnSuccess ?? options.message
            if (Settings.verbose) {
                Logger.success(successMessage)
            } else {
                spinner.stopWithSuccess(successMessage)
            }
        } else {
            const errorMessage = options.messageOnError ?? `Command failed with exit code ${exitCode}`
            if (!Settings.verbose) {
                spinner.stop()
            }
            Logger.error(errorMessage)
            // Always show stderr if available
            if (stderr?.trim()) {
                Logger.raw(stderr)
            }
            // Also show stdout if it might contain error information (but filter out progress messages)
            if (stdout?.trim()) {
                const filteredStdout = stdout
                    .split("\n")
                    .filter(line => !line.includes("STRUX_PROGRESS:"))
                    .join("\n")
                if (filteredStdout.trim()) {
                    Logger.raw(filteredStdout)
                }
            }
            if (options.exitOnError) {
                // If we have a UI sink, throw an error to let the UI handle it gracefully
                if (Logger.hasSink()) {
                    const exitError = new Error(errorMessage)
                    exitError.name = "StruxExitError"
                    throw exitError
                }
                process.exit(exitCode)
            }
        }

        return {
            exitCode,
            stdout,
            stderr
        }
    }

    /**
     * Result of Docker image preparation
     */
    public lastDockerImageHash = ""
    public lastDockerImageRebuilt = false

    /**
     * Checks if a Docker image exists locally by name/tag.
     */
    private async checkImageExists(imageName: string): Promise<boolean> {
        try {
            const proc = Bun.spawn(["docker", "images", "-q", imageName], {
                stdout: "pipe",
                stderr: "pipe",
            })
            const output = await new Response(proc.stdout).text()
            await proc.exited
            return output.trim() !== ""
        } catch {
            return false
        }
    }

    /**
     * Prepares the Docker Image and Folder.
     * Returns information about whether the image was rebuilt.
     *
     * Strategy:
     * - If running inside the builder container (STRUX_IN_CONTAINER=1), skip Docker entirely
     * - If --local-builder flag is set, build from the embedded Dockerfile (original behavior)
     * - Otherwise, try to pull the versioned image from GHCR, fall back to local build on failure
     */
    public async prepareDockerImage(cachedDockerHash?: string): Promise<{ imageHash: string; rebuilt: boolean }> {
        const currentHash = getDockerfileHash()

        // If we're already inside the builder container, no Docker image needed
        if (Settings.inContainer) {
            this.dockerImageReady = true
            this.lastDockerImageHash = currentHash
            this.lastDockerImageRebuilt = false
            return { imageHash: currentHash, rebuilt: false }
        }

        // If --local-builder flag is set, use the original local build logic
        if (Settings.localBuilder) {
            return this.buildDockerImageLocally(currentHash, cachedDockerHash)
        }

        // Default: try to pull the versioned image from GHCR
        const imageExists = await this.checkImageExists("strux-builder")
        const hashChanged = cachedDockerHash !== undefined && cachedDockerHash !== currentHash

        // If we already have the image and hash hasn't changed, use it
        if (imageExists && !hashChanged) {
            this.dockerImageReady = true
            this.lastDockerImageHash = currentHash
            this.lastDockerImageRebuilt = false
            return { imageHash: currentHash, rebuilt: false }
        }

        // Try pulling from GHCR
        const remoteImage = Settings.builderImage
        Logger.log(`Pulling builder image: ${remoteImage}`)

        try {
            const pullResult = await this.runCommand(`docker pull ${remoteImage}`, {
                message: "Pulling builder image from registry...",
                exitOnError: false,
            })

            if (pullResult.exitCode === 0) {
                // Tag the pulled image as strux-builder for downstream compatibility
                await Bun.spawn(["docker", "tag", remoteImage, "strux-builder"], {
                    stdout: "pipe",
                    stderr: "pipe",
                }).exited

                this.dockerImageReady = true
                this.lastDockerImageHash = currentHash
                this.lastDockerImageRebuilt = false
                return { imageHash: currentHash, rebuilt: false }
            }
        } catch {
            // Pull failed, fall through to local build
        }

        // Fallback: build locally
        Logger.warning("Failed to pull builder image, falling back to local build...")
        return this.buildDockerImageLocally(currentHash, cachedDockerHash)
    }

    /**
     * Builds the Docker image locally from the embedded Dockerfile.
     */
    private async buildDockerImageLocally(currentHash: string, cachedDockerHash?: string): Promise<{ imageHash: string; rebuilt: boolean }> {
        const imageExists = await this.checkImageExists("strux-builder")
        const hashChanged = cachedDockerHash !== undefined && cachedDockerHash !== currentHash
        const needsRebuild = !imageExists || hashChanged

        if (!needsRebuild) {
            this.dockerImageReady = true
            this.lastDockerImageHash = currentHash
            this.lastDockerImageRebuilt = false
            return { imageHash: currentHash, rebuilt: false }
        }

        // If hash changed, remove old image first
        if (imageExists && hashChanged) {
            Logger.log("Dockerfile changed, rebuilding Docker image...")
            try {
                await Bun.spawn(["docker", "rmi", "-f", "strux-builder"], {
                    stdout: "pipe",
                    stderr: "pipe",
                }).exited
            } catch {
                // Ignore errors when removing old image
            }
        }

        const spinner = new Spinner("Creating dist folder...")
        spinner.start()

        try {
            await mkdir(join(Settings.projectPath, "dist", "artifacts"), { recursive: true })
            spinner.stopWithSuccess("Creating dist folder...")
        } catch (error) {
            spinner.stop()
            const errorMessage = "Failed to create dist/artifacts folder. Please create it manually."
            Logger.error(errorMessage)
            if (error instanceof Error) {
                Logger.error(error.message)
            }
            if (Logger.hasSink()) {
                const exitError = new Error(errorMessage)
                exitError.name = "StruxExitError"
                throw exitError
            }
            process.exit(1)
        }

        // Copy the dockerfile into dist/artifacts folder in the project directory
        await Bun.write(join(Settings.projectPath, "dist", "artifacts", "Dockerfile"), scriptsBaseDockerfile)

        // Build Docker image using the Dockerfile
        await this.runCommand("docker build -t strux-builder -f dist/artifacts/Dockerfile .", {
            message: "Building Docker image locally...",
            exitOnError: true,
            cwd: Settings.projectPath
        })

        this.dockerImageReady = true
        this.lastDockerImageHash = currentHash
        this.lastDockerImageRebuilt = true

        return { imageHash: currentHash, rebuilt: true }
    }

    /**
     * Builds the chown command string for fixing file permissions after Docker runs.
     * Returns null on Windows or if user info is unavailable.
     */
    private getChownCommand(): string | null {
        const userInfo = this.getHostUserInfo()
        if (!userInfo) return null
        return `(UIDGID="${userInfo.uid}:${userInfo.gid}"; find /project -path "/project/dist/cache/*/kernel-source" -prune -o -path "*/.git" -prune -o -exec chown -h "$UIDGID" {} +)`
    }

    /**
     * Runs a standalone chown on the project directory inside Docker.
     * Use this at the end of a build pipeline instead of chowning after every step.
     */
    public async chownProjectFiles(): Promise<void> {
        // No UID mismatch when running directly inside the container
        if (Settings.inContainer) return

        const chownCmd = this.getChownCommand()
        if (!chownCmd) return

        if (!this.dockerImageReady) await this.prepareDockerImage(undefined)

        const args: string[] = [
            "docker", "run", "--rm", "-i", "--privileged",
            "-v", `${Settings.projectPath}:/project`,
            "strux-builder", "/bin/bash", "-c", chownCmd
        ]

        const spinner = new Spinner("Fixing file permissions...")
        if (!Settings.verbose) {
            spinner.start()
        } else {
            Logger.log("Fixing file permissions...")
        }

        const proc = Bun.spawn(args, {
            stdout: Settings.verbose && !Logger.hasSink() ? "inherit" : "pipe",
            stderr: Settings.verbose && !Logger.hasSink() ? "inherit" : "pipe",
        })

        const exitCode = await proc.exited

        if (exitCode === 0) {
            if (Settings.verbose) {
                Logger.success("File permissions fixed")
            } else {
                spinner.stopWithSuccess("File permissions fixed")
            }
        } else {
            if (!Settings.verbose) {
                spinner.stop()
            }
            Logger.warning("Failed to fix file permissions. You may need to run: sudo chown -R $(id -u):$(id -g) .")
        }
    }

    /**
     * Runs a build script directly (no Docker wrapping).
     * Used when strux is already running inside the builder container.
     */
    private async runScriptDirect(script: string, options: Omit<RunnerOptions, "cwd">) {
        const spinner = new Spinner(options.message)
        if (!Settings.verbose) {
            spinner.start()
        } else {
            Logger.log(options.message)
        }

        const finalScript = script.trimEnd()
        const args = ["/bin/bash", "-c", finalScript]
        let stdout = ""
        let stderr = ""

        // In verbose mode without UI, use inherit stdio
        if (Settings.verbose && !Logger.hasSink()) {
            const proc = Bun.spawn(args, {
                stdout: "inherit",
                stderr: "inherit",
                env: { ...process.env, ...options.env },
                cwd: Settings.projectPath,
            })

            const exitCode = await proc.exited

            if (exitCode === 0) {
                Logger.success(options.messageOnSuccess ?? options.message)
            } else {
                Logger.error(options.messageOnError ?? `Command failed with exit code ${exitCode}`)
                if (options.exitOnError) {
                    process.exit(exitCode)
                }
            }

            return { exitCode, stdout: "", stderr: "" }
        }

        // Capture output for spinner, error display, and verbose output to UI
        const proc = Bun.spawn(args, {
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, ...options.env },
            cwd: Settings.projectPath,
        })

        const verboseWithUi = Settings.verbose && Logger.hasSink()

        const stdoutPromise = (async () => {
            const decoder = new TextDecoder()
            for await (const chunk of proc.stdout) {
                const text = decoder.decode(chunk, { stream: true })
                stdout += text

                if (verboseWithUi) {
                    Logger.raw(text)
                }

                const lines = text.split("\n")
                for (const line of lines) {
                    const marker = "STRUX_PROGRESS:"
                    const idx = line.indexOf(marker)
                    if (idx >= 0) {
                        const msg = line.substring(idx + marker.length).trim()
                        if (msg && !verboseWithUi) {
                            spinner.updateMessage(msg)
                        }
                    }
                }
            }
        })()

        const stderrPromise = (async () => {
            const decoder = new TextDecoder()
            for await (const chunk of proc.stderr) {
                const text = decoder.decode(chunk, { stream: true })
                stderr += text
                if (verboseWithUi) {
                    Logger.raw(text)
                }
            }
        })()

        await Promise.all([stdoutPromise, stderrPromise])
        const exitCode = await proc.exited

        if (exitCode === 0) {
            const successMessage = options.messageOnSuccess ?? options.message
            if (verboseWithUi) {
                Logger.success(successMessage)
            } else {
                spinner.stopWithSuccess(successMessage)
            }
        } else {
            const errorMessage = options.messageOnError ?? `Command failed with exit code ${exitCode}`
            if (!verboseWithUi) {
                spinner.stop()
            }
            Logger.error(errorMessage)
            if (!verboseWithUi) {
                if (stderr?.trim()) {
                    Logger.raw(stderr)
                }
                if (stdout?.trim()) {
                    const filteredStdout = stdout
                        .split("\n")
                        .filter(line => !line.includes("STRUX_PROGRESS:"))
                        .join("\n")
                    if (filteredStdout.trim()) {
                        Logger.raw(filteredStdout)
                    }
                }
            }
            if (options.exitOnError) {
                if (Logger.hasSink()) {
                    const exitError = new Error(errorMessage)
                    exitError.name = "StruxExitError"
                    throw exitError
                }
                process.exit(exitCode)
            }
        }

        return { exitCode, stdout, stderr }
    }

    public async runScriptInDocker(script: string, options: Omit<RunnerOptions, "cwd">) {
        // When running inside the builder container, execute scripts directly
        if (Settings.inContainer) {
            return this.runScriptDirect(script, options)
        }

        if (!this.dockerImageReady) await this.prepareDockerImage(undefined)

        const spinner = new Spinner(options.message)
        // If verbose mode is enabled, don't use spinner (it interferes with output)
        if (!Settings.verbose) {
            spinner.start()
        } else {
            // In verbose mode, just log the message
            Logger.log(options.message)
        }

        // Build the script, optionally appending chown to fix permissions.
        // When skipChown is true (e.g., during build pipeline), chown is deferred
        // to a single call at the end via chownProjectFiles().
        let finalScript = script.trimEnd()

        if (!this.skipChown) {
            const chownCmd = this.getChownCommand()
            if (chownCmd) {
                finalScript = `${finalScript} && ${chownCmd}`
            }
        }

        // Build Docker command arguments array directly
        const args: string[] = [
            "docker",
            "run",
            "--rm",
            "-i",  // Interactive mode for unbuffered output (needed for verbose mode)
            "--privileged"  // Required for debootstrap, mount, and chroot operations
        ]

        // Add environment variable flags
        if (options.env) {
            for (const [key, value] of Object.entries(options.env)) {
                args.push("-e", `${key}=${value}`)
            }
        }

        // Add volume mount
        args.push("-v", `${Settings.projectPath}:/project`)

        // If local runtime is set, mount it into the container
        if (Settings.localRuntime) {
            args.push("-v", `${Settings.localRuntime}:/strux-runtime:ro`)
        }

        // Add image and command (use bash since scripts use bash features)
        args.push("strux-builder", "/bin/bash", "-c", finalScript)
        let stdout = ""
        let stderr = ""

        // In verbose mode without UI, use inherit stdio so output goes directly to terminal
        // This avoids buffering issues and matches the old working implementation
        // When UI is active, we need to capture output and route it through the Logger
        if (Settings.verbose && !Logger.hasSink()) {
            const proc = Bun.spawn(args, {
                stdout: "inherit",
                stderr: "inherit",
            })

            const exitCode = await proc.exited

            if (exitCode === 0) {
                const successMessage = options.messageOnSuccess ?? options.message
                Logger.success(successMessage)
            } else {
                const errorMessage = options.messageOnError ?? `Command failed with exit code ${exitCode}`
                Logger.error(errorMessage)
                if (options.exitOnError) {
                    process.exit(exitCode)
                }
            }

            return {
                exitCode,
                stdout: "", // Not captured in verbose mode
                stderr: ""  // Not captured in verbose mode
            }
        }

        // Capture output for spinner, error display, and verbose output to UI
        const proc = Bun.spawn(args, {
            stdout: "pipe",
            stderr: "pipe",
        })

        // Check if we're in verbose mode with UI active
        const verboseWithUi = Settings.verbose && Logger.hasSink()

        // Process stdout stream
        const stdoutPromise = (async () => {
            const decoder = new TextDecoder()
            for await (const chunk of proc.stdout) {
                const text = decoder.decode(chunk, { stream: true })
                stdout += text

                // In verbose mode with UI, output everything immediately
                if (verboseWithUi) {
                    Logger.raw(text)
                }

                // Parse for progress markers line by line
                const lines = text.split("\n")
                for (const line of lines) {
                    const marker = "STRUX_PROGRESS:"
                    const idx = line.indexOf(marker)
                    if (idx >= 0) {
                        const msg = line.substring(idx + marker.length).trim()
                        if (msg && !verboseWithUi) {
                            spinner.updateMessage(msg)
                        }
                    }
                }
            }
        })()

        // Process stderr stream
        const stderrPromise = (async () => {
            const decoder = new TextDecoder()
            for await (const chunk of proc.stderr) {
                const text = decoder.decode(chunk, { stream: true })
                stderr += text

                // In verbose mode with UI, output stderr immediately
                if (verboseWithUi) {
                    Logger.raw(text)
                }
            }
        })()

        // Wait for both streams to finish and process to exit
        await Promise.all([stdoutPromise, stderrPromise])
        const exitCode = await proc.exited

        if (exitCode === 0) {
            const successMessage = options.messageOnSuccess ?? options.message
            if (verboseWithUi) {
                Logger.success(successMessage)
            } else {
                spinner.stopWithSuccess(successMessage)
            }
        } else {
            const errorMessage = options.messageOnError ?? `Command failed with exit code ${exitCode}`
            if (!verboseWithUi) {
                spinner.stop()
            }
            Logger.error(errorMessage)
            // In verbose+UI mode, output was already streamed, so only show on error in non-verbose mode
            if (!verboseWithUi) {
                // Always show stderr if available
                if (stderr?.trim()) {
                    Logger.raw(stderr)
                }
                // Also show stdout if it might contain error information (but filter out progress messages)
                if (stdout?.trim()) {
                    const filteredStdout = stdout
                        .split("\n")
                        .filter(line => !line.includes("STRUX_PROGRESS:"))
                        .join("\n")
                    if (filteredStdout.trim()) {
                        Logger.raw(filteredStdout)
                    }
                }
            }
            if (options.exitOnError) {
                // If we have a UI sink, throw an error to let the UI handle it gracefully
                if (Logger.hasSink()) {
                    const exitError = new Error(errorMessage)
                    exitError.name = "StruxExitError"
                    throw exitError
                }
                process.exit(exitCode)
            }
        }

        return {
            exitCode,
            stdout,
            stderr
        }
    }

    /**
     * Runs an interactive script in Docker with TTY support.
     * This is used for commands that require user interaction (e.g., menuconfig).
     */
    public async runInteractiveScriptInDocker(script: string, options: Omit<RunnerOptions, "cwd">) {
        // When running inside the builder container, execute directly
        if (Settings.inContainer) {
            Logger.log(options.message)

            const proc = Bun.spawn(["/bin/bash", "-c", script.trimEnd()], {
                stdout: "inherit",
                stderr: "inherit",
                stdin: "inherit",
                env: { ...process.env, ...options.env },
                cwd: Settings.projectPath,
            })

            const exitCode = await proc.exited

            if (exitCode === 0) {
                Logger.success(options.messageOnSuccess ?? options.message)
            } else {
                Logger.error(options.messageOnError ?? `Command failed with exit code ${exitCode}`)
                if (options.exitOnError) {
                    process.exit(exitCode)
                }
            }

            return { exitCode, stdout: "", stderr: "" }
        }

        if (!this.dockerImageReady) await this.prepareDockerImage(undefined)

        Logger.log(options.message)

        // Build the script with chown at the end to fix permissions
        const userInfo = this.getHostUserInfo()
        let finalScript = script.trimEnd()

        if (userInfo) {
            finalScript = `${finalScript} && (UIDGID="${userInfo.uid}:${userInfo.gid}"; find /project -path "/project/dist/cache/*/kernel-source" -prune -o -path "*/.git" -prune -o -exec chown -h "$UIDGID" {} +)`
        }

        // Build Docker command arguments array with TTY support
        const args: string[] = [
            "docker",
            "run",
            "--rm",
            "-it",  // Interactive TTY (both -i and -t required for menuconfig)
            "--privileged"
        ]

        // Add environment variable flags
        if (options.env) {
            for (const [key, value] of Object.entries(options.env)) {
                args.push("-e", `${key}=${value}`)
            }
        }

        // Add volume mount
        args.push("-v", `${Settings.projectPath}:/project`)

        // If local runtime is set, mount it into the container
        if (Settings.localRuntime) {
            args.push("-v", `${Settings.localRuntime}:/strux-runtime:ro`)
        }

        // Add image and command
        args.push("strux-builder", "/bin/bash", "-c", finalScript)

        // For interactive commands, use inherit stdio so user can interact
        const proc = Bun.spawn(args, {
            stdout: "inherit",
            stderr: "inherit",
            stdin: "inherit"
        })

        const exitCode = await proc.exited

        if (exitCode === 0) {
            const successMessage = options.messageOnSuccess ?? options.message
            Logger.success(successMessage)
        } else {
            const errorMessage = options.messageOnError ?? `Command failed with exit code ${exitCode}`
            Logger.error(errorMessage)
            if (options.exitOnError) {
                process.exit(exitCode)
            }
        }

        return {
            exitCode,
            stdout: "", // Not captured for interactive commands
            stderr: ""  // Not captured for interactive commands
        }
    }

}

export const Runner = new RunnerClass()
