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
import { assertShellSafeEnv, splitSafeCommand } from "./sanitize"

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

    private writeVerboseOutputLine(line: string, stream: "stdout" | "stderr"): void {
        if (Logger.hasSink()) {
            Logger.raw(line)
            return
        }

        Logger.finishProgressBar()
        const output = stream === "stderr" ? process.stderr : process.stdout
        output.write(`${line}\n`)
    }

    private async collectProcessStream(
        stream: ReadableStream<Uint8Array>,
        options: {
            verboseOutput?: boolean
            outputStream?: "stdout" | "stderr"
            handleProgressMarkers?: boolean
            spinner?: Spinner
        } = {}
    ): Promise<string> {
        const decoder = new TextDecoder()
        let output = ""
        let pendingLine = ""

        const processLine = (line: string): void => {
            if (options.handleProgressMarkers && Logger.isProgressMarkerLine(line)) {
                Logger.tryHandleProgressMarker(line, { spinner: options.spinner })
                return
            }

            if (options.verboseOutput) {
                this.writeVerboseOutputLine(line, options.outputStream ?? "stdout")
            }
        }

        for await (const chunk of stream) {
            const text = decoder.decode(chunk, { stream: true })
            output += text
            pendingLine += text

            const lines = pendingLine.split("\n")
            pendingLine = lines.pop() ?? ""
            for (const line of lines) {
                processLine(line.endsWith("\r") ? line.slice(0, -1) : line)
            }
        }

        const remainingText = decoder.decode()
        if (remainingText) {
            output += remainingText
            pendingLine += remainingText
        }

        if (pendingLine) {
            processLine(pendingLine.endsWith("\r") ? pendingLine.slice(0, -1) : pendingLine)
        }

        return output
    }

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

    public async runCommand(command: string | string[], options: RunnerOptions) {
        const args = Array.isArray(command)
            ? command
            : splitSafeCommand(command)

        const spinner = new Spinner(options.message)
        // If verbose mode is enabled, don't use spinner (it interferes with output)
        if (!Settings.verbose) {
            spinner.start()
        } else {
            // In verbose mode, just log the message
            Logger.log(options.message)
        }

        const proc = Bun.spawn(args, {
            stdout: "pipe",
            stderr: "pipe",
            cwd: options.cwd ?? process.cwd(),
            env: options.env ?? process.env
        })

        // Process stdout stream
        const stdoutPromise = this.collectProcessStream(proc.stdout, {
            verboseOutput: Settings.verbose,
            outputStream: "stdout",
            handleProgressMarkers: true,
            spinner,
        })

        // Process stderr stream
        const stderrPromise = this.collectProcessStream(proc.stderr, {
            verboseOutput: Settings.verbose,
            outputStream: "stderr",
            handleProgressMarkers: Settings.verbose,
            spinner,
        })

        // Wait for both streams to finish and process to exit
        const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
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
                    .filter(line => !Logger.isProgressMarkerLine(line))
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
    public async prepareDockerImage(cachedDockerHash?: string, force?: boolean): Promise<{ imageHash: string; rebuilt: boolean }> {
        const currentHash = getDockerfileHash()

        // If we're already inside the builder container, no Docker image needed
        if (Settings.inContainer) {
            this.dockerImageReady = true
            this.lastDockerImageHash = currentHash
            this.lastDockerImageRebuilt = false
            return { imageHash: currentHash, rebuilt: false }
        }

        // If --local-builder flag is set or force rebuild requested, use local build logic
        if (Settings.localBuilder || force) {
            return this.buildDockerImageLocally(currentHash, cachedDockerHash, force)
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
            const pullResult = await this.runCommand(["docker", "pull", remoteImage], {
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
    /**
     * Gets the Dockerfile hash label from the existing strux-builder Docker image.
     * Returns null if the image doesn't exist or has no label.
     */
    private async getImageDockerfileHash(): Promise<string | null> {
        try {
            const proc = Bun.spawn(
                ["docker", "inspect", "--format", "{{index .Config.Labels \"strux.dockerfile.hash\"}}", "strux-builder"],
                { stdout: "pipe", stderr: "pipe" }
            )
            const exitCode = await proc.exited
            if (exitCode !== 0) return null
            const output = await new Response(proc.stdout).text()
            const hash = output.trim()
            return hash && hash !== "<no value>" ? hash : null
        } catch {
            return null
        }
    }

    private async buildDockerImageLocally(currentHash: string, cachedDockerHash?: string, force?: boolean): Promise<{ imageHash: string; rebuilt: boolean }> {
        const imageExists = await this.checkImageExists("strux-builder")

        // Determine if rebuild is needed by comparing hashes.
        // Priority: explicit cached hash > image label > session hash
        let compareHash = cachedDockerHash ?? this.lastDockerImageHash
        if (compareHash === undefined && imageExists) {
            // No cached or session hash — check the image label to see if it
            // was built from this Dockerfile version
            const labelHash = await this.getImageDockerfileHash()
            if (labelHash !== null) {
                compareHash = labelHash
            } else {
                // Image exists but has no hash label — it came from GHCR or an
                // old local build. Force rebuild so we get a properly labeled image.
                Logger.log("Existing image has no Dockerfile hash label, rebuilding...")
            }
        }
        const hashChanged = compareHash !== undefined && compareHash !== currentHash
        // Rebuild if: no image, hash mismatch, forced, or image has no label (unlabeled GHCR image)
        const noLabel = imageExists && compareHash === undefined && cachedDockerHash === undefined && this.lastDockerImageHash === undefined
        const needsRebuild = !imageExists || hashChanged || (force ?? false) || noLabel

        Logger.log(`Local builder: imageExists=${imageExists}, compareHash=${compareHash}, currentHash=${currentHash}, needsRebuild=${needsRebuild}`)

        if (!needsRebuild) {
            this.dockerImageReady = true
            this.lastDockerImageHash = currentHash
            this.lastDockerImageRebuilt = false
            return { imageHash: currentHash, rebuilt: false }
        }

        // Remove old image if it exists
        if (imageExists) {
            Logger.log("Rebuilding Docker image...")
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

        // Build Docker image using the Dockerfile, labeling with the hash for future comparison
        await this.runCommand(["docker", "build", "-t", "strux-builder", "--label", `strux.dockerfile.hash=${currentHash}`, "-f", "dist/artifacts/Dockerfile", "."], {
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

    private withGitSafeProjectDirectory(script: string): string {
        return `git config --global --add safe.directory "$PROJECT_DIR" 2>/dev/null || true\n${script.trimEnd()}`
    }

    private getScriptPathEnv(): Record<string, string> {
        const projectDir = Settings.inContainer ? Settings.projectPath : "/project"
        const projectDistDir = `${projectDir}/dist`
        const env: Record<string, string> = {
            PROJECT_DIR: projectDir,
            PROJECT_FOLDER: projectDir,
            PROJECT_DIST_DIR: projectDistDir,
            PROJECT_DIST_FOLDER: projectDistDir,
            PROJECT_DIST_ARTIFACTS_FOLDER: `${projectDistDir}/artifacts`,
            SHARED_CACHE_DIR: `${projectDistDir}/cache`
        }

        if (Settings.bspName) {
            env.BSP_CACHE_DIR = `${projectDistDir}/cache/${Settings.bspName}`
            env.PROJECT_DIST_CACHE_FOLDER = env.BSP_CACHE_DIR
            env.PROJECT_DIST_OUTPUT_FOLDER = `${projectDistDir}/output/${Settings.bspName}`
            env.BSP_FOLDER = `${projectDir}/bsp/${Settings.bspName}`
        }

        return env
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

        const finalScript = this.withGitSafeProjectDirectory(script)
        const args = ["/bin/bash", "-c", finalScript]
        assertShellSafeEnv({ ...options.env, ...this.getScriptPathEnv() }, "script environment variable")

        // Capture output for spinner, error display, and verbose output to UI
        const proc = Bun.spawn(args, {
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, ...options.env, ...this.getScriptPathEnv() },
            cwd: Settings.projectPath,
        })

        const stdoutPromise = this.collectProcessStream(proc.stdout, {
            verboseOutput: Settings.verbose,
            outputStream: "stdout",
            handleProgressMarkers: true,
            spinner,
        })

        const stderrPromise = this.collectProcessStream(proc.stderr, {
            verboseOutput: Settings.verbose,
            outputStream: "stderr",
            handleProgressMarkers: Settings.verbose,
            spinner,
        })

        const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
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
            if (!Settings.verbose) {
                if (stderr?.trim()) {
                    Logger.raw(stderr)
                }
                if (stdout?.trim()) {
                    const filteredStdout = stdout
                        .split("\n")
                        .filter(line => !Logger.isProgressMarkerLine(line))
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
        let finalScript = this.withGitSafeProjectDirectory(script)

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

        const scriptEnv = { ...options.env, ...this.getScriptPathEnv() }
        assertShellSafeEnv(scriptEnv, "script environment variable")

        // Add environment variable flags
        for (const [key, value] of Object.entries(scriptEnv)) {
            args.push("-e", `${key}=${value}`)
        }

        // Add volume mount
        args.push("-v", `${Settings.projectPath}:/project`)

        // If local runtime is set, mount it into the container
        if (Settings.localRuntime) {
            args.push("-v", `${Settings.localRuntime}:/strux-runtime:ro`)
        }

        // Add image and command (use bash since scripts use bash features)
        args.push("strux-builder", "/bin/bash", "-c", finalScript)

        // Capture output for spinner, error display, and verbose output to UI
        const proc = Bun.spawn(args, {
            stdout: "pipe",
            stderr: "pipe",
        })

        // Process stdout stream
        const stdoutPromise = this.collectProcessStream(proc.stdout, {
            verboseOutput: Settings.verbose,
            outputStream: "stdout",
            handleProgressMarkers: true,
            spinner,
        })

        // Process stderr stream
        const stderrPromise = this.collectProcessStream(proc.stderr, {
            verboseOutput: Settings.verbose,
            outputStream: "stderr",
            handleProgressMarkers: Settings.verbose,
            spinner,
        })

        // Wait for both streams to finish and process to exit
        const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
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
            // In verbose mode, output was already streamed, so only show on error in non-verbose mode
            if (!Settings.verbose) {
                // Always show stderr if available
                if (stderr?.trim()) {
                    Logger.raw(stderr)
                }
                // Also show stdout if it might contain error information (but filter out progress messages)
                if (stdout?.trim()) {
                    const filteredStdout = stdout
                        .split("\n")
                        .filter(line => !Logger.isProgressMarkerLine(line))
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

            const proc = Bun.spawn(["/bin/bash", "-c", this.withGitSafeProjectDirectory(script)], {
                stdout: "inherit",
                stderr: "inherit",
                stdin: "inherit",
                env: { ...process.env, ...options.env, ...this.getScriptPathEnv() },
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
        let finalScript = this.withGitSafeProjectDirectory(script)

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

        const scriptEnv = { ...options.env, ...this.getScriptPathEnv() }
        assertShellSafeEnv(scriptEnv, "script environment variable")

        // Add environment variable flags
        for (const [key, value] of Object.entries(scriptEnv)) {
            args.push("-e", `${key}=${value}`)
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
