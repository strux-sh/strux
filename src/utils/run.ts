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

    private dockerImageBuilt = false

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
                    // Write directly to stdout - this should output all process output
                    process.stdout.write(text)
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
                    // Write directly to stderr - this should output all process errors
                    process.stderr.write(text)
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
     * Prepares the Docker Image and Folder.
     * Returns information about whether the image was rebuilt.
     */
    public async prepareDockerImage(cachedDockerHash?: string): Promise<{ imageHash: string; rebuilt: boolean }> {
        const currentHash = getDockerfileHash()

        // Check if Docker image already exists
        let imageExists = false
        try {
            const checkProc = Bun.spawn(["docker", "images", "-q", "strux-builder"], {
                stdout: "pipe",
                stderr: "pipe",
            })
            const checkOutput = await new Response(checkProc.stdout).text()
            await checkProc.exited
            imageExists = checkOutput.trim() !== ""
        } catch {
            // If check fails, proceed to build
        }

        // Determine if we need to rebuild
        const hashChanged = cachedDockerHash !== undefined && cachedDockerHash !== currentHash
        const needsRebuild = !imageExists || hashChanged

        if (!needsRebuild) {
            // Image exists and hash hasn't changed
            this.dockerImageBuilt = true
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
            Logger.error("Failed to create dist/artifacts folder. Please create it manually.")
            if (error instanceof Error) {
                Logger.error(error.message)
            }
            process.exit(1)
        }

        // Copy the dockerfile into dist/artifacts folder in the project directory
        await Bun.write(join(Settings.projectPath, "dist", "artifacts", "Dockerfile"), scriptsBaseDockerfile)

        // Build Docker image using the Dockerfile
        await this.runCommand("docker build -t strux-builder -f dist/artifacts/Dockerfile .", {
            message: "Building Docker image...",
            exitOnError: true,
            cwd: Settings.projectPath
        })

        // Mark as built after successful build
        this.dockerImageBuilt = true
        this.lastDockerImageHash = currentHash
        this.lastDockerImageRebuilt = true

        return { imageHash: currentHash, rebuilt: true }
    }

    public async runScriptInDocker(script: string, options: Omit<RunnerOptions, "cwd">) {
        if (!this.dockerImageBuilt) await this.prepareDockerImage(undefined)

        const spinner = new Spinner(options.message)
        // If verbose mode is enabled, don't use spinner (it interferes with output)
        if (!Settings.verbose) {
            spinner.start()
        } else {
            // In verbose mode, just log the message
            Logger.log(options.message)
        }

        // Build the script with chown at the end to fix permissions
        const userInfo = this.getHostUserInfo()
        // Trim trailing whitespace/newlines from script before appending chown command
        let finalScript = script.trimEnd()

        // Append chown command to fix permissions after script execution
        // Docker runs as root, so it can chown the mounted volume
        // Note: chown works with numeric UID/GID even if the user doesn't exist in the container
        // The host system will resolve these IDs to the actual user/group names
        if (userInfo) {
            finalScript = `${finalScript} && chown -R ${userInfo.uid}:${userInfo.gid} /project`
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

        // Add image and command (use bash since scripts use bash features)
        args.push("strux-builder", "/bin/bash", "-c", finalScript)
        let stdout = ""
        let stderr = ""

        // In verbose mode, use inherit stdio so output goes directly to terminal
        // This avoids buffering issues and matches the old working implementation
        if (Settings.verbose) {
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

        // Non-verbose mode: capture output for spinner and error display
        const proc = Bun.spawn(args, {
            stdout: "pipe",
            stderr: "pipe",
        })

        // Process stdout stream
        const stdoutPromise = (async () => {
            const decoder = new TextDecoder()
            for await (const chunk of proc.stdout) {
                const text = decoder.decode(chunk, { stream: true })
                stdout += text

                // Parse for progress markers line by line
                const lines = text.split("\n")
                for (const line of lines) {
                    const marker = "STRUX_PROGRESS:"
                    const idx = line.indexOf(marker)
                    if (idx >= 0) {
                        const msg = line.substring(idx + marker.length).trim()
                        if (msg) {
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
            }
        })()

        // Wait for both streams to finish and process to exit
        await Promise.all([stdoutPromise, stderrPromise])
        const exitCode = await proc.exited

        if (exitCode === 0) {
            const successMessage = options.messageOnSuccess ?? options.message
            spinner.stopWithSuccess(successMessage)
        } else {
            const errorMessage = options.messageOnError ?? `Command failed with exit code ${exitCode}`
            spinner.stop()
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
                process.exit(exitCode)
            }
        }

        return {
            exitCode,
            stdout,
            stderr
        }
    }

}

export const Runner = new RunnerClass()