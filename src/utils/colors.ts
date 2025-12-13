import chalk from "chalk"
import ora, { type Ora } from "ora"
import { spawn, type SpawnOptions } from "child_process"

let verbose = false

/**
 * Set the verbosity level
 */
export function setVerbose(v: boolean): void {
    verbose = v
}

/**
 * Returns the current verbosity level
 */
export function isVerbose(): boolean {
    return verbose
}

/**
 * Spinner wrapper that mimics the Go Spinner API
 */
export class Spinner {
    private spinner: Ora | null = null
    private message: string

    constructor(message: string) {
        this.message = message
    }

    /**
     * Start begins the spinner animation
     */
    start(): void {
        this.spinner = ora({
            text: this.message,
            color: "cyan",
        }).start()
    }

    /**
     * Stop stops the spinner
     */
    stop(): void {
        if (this.spinner) {
            this.spinner.stop()
            this.spinner = null
        }
    }

    /**
     * StopWithSuccess stops the spinner and shows a success message
     */
    stopWithSuccess(msg: string): void {
        if (this.spinner) {
            this.spinner.succeed(msg)
            this.spinner = null
        } else {
            success(msg)
        }
    }

    /**
     * StopWithError stops the spinner and shows an error message
     */
    stopWithError(msg: string): void {
        if (this.spinner) {
            this.spinner.fail(msg)
            this.spinner = null
        } else {
            error(msg)
        }
    }

    /**
     * UpdateMessage updates the spinner's current message
     */
    updateMessage(msg: string): void {
        this.message = msg
        if (this.spinner) {
            this.spinner.text = msg
        }
    }
}

/**
 * NewSpinner creates a new spinner with the given message
 */
export function newSpinner(msg: string): Spinner {
    return new Spinner(msg)
}

/**
 * Step prints a build step with formatting
 */
export function step(num: number, total: number, msg: string): void {
    console.log(chalk.cyan(`[${num}/${total}]`) + " " + chalk.bold(msg))
}

/**
 * Success prints a success message
 */
export function success(msg: string): void {
    console.log(chalk.greenBright("✓") + " " + msg)
}

/**
 * Info prints an info message
 */
export function info(msg: string): void {
    console.log(chalk.blue("→") + " " + msg)
}

/**
 * Debug prints a message only in verbose mode
 */
export function debug(msg: string): void {
    if (verbose) {
        console.log(chalk.dim("  " + msg))
    }
}

/**
 * Warning prints a warning message
 */
export function warning(msg: string): void {
    console.error(chalk.yellow("⚠") + " " + msg)
}

/**
 * Error prints an error message
 */
export function error(msg: string): void {
    console.error(chalk.redBright("✗") + " " + msg)
}

/**
 * Title prints a title/header
 */
export function title(msg: string): void {
    console.log("\n" + chalk.bold.magenta(msg))
}

/**
 * Cached prints a cached step message
 */
export function cached(msg: string): void {
    console.log(chalk.greenBright("✓") + " " + msg + " " + chalk.dim("(cached)"))
}

/**
 * Complete prints a completion message
 */
export function complete(msg: string): void {
    console.log("\n" + chalk.bold.greenBright("✓ " + msg))
}

/**
 * RunWithSpinner runs a command with a spinner, hiding output unless verbose or on error
 */
export async function runWithSpinner(
    command: string,
    args: string[],
    options: SpawnOptions,
    spinnerMsg: string,
    successMsg: string
): Promise<void> {
    if (verbose) {
        // In verbose mode, show all output
        info(spinnerMsg)
        const proc = spawn(command, args, {
            ...options,
            stdio: options.stdio ?? "inherit",
        })

        return new Promise((resolve, reject) => {
            proc.on("close", (code) => {
                if (code === 0) {
                    success(successMsg)
                    resolve()
                } else {
                    reject(new Error(`Command failed with exit code ${code}`))
                }
            })

            proc.on("error", (err) => {
                reject(err)
            })
        })
    }

    // Non-verbose: capture output, show spinner
    const spinner = newSpinner(spinnerMsg)
    spinner.start()

    const proc = spawn(command, args, {
        ...options,
        stdio: options.stdio ?? ["inherit", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    if (proc.stdout) {
        proc.stdout.on("data", (data) => {
            stdout += data.toString()
        })
    }

    if (proc.stderr) {
        proc.stderr.on("data", (data) => {
            stderr += data.toString()
        })
    }

    return new Promise((resolve, reject) => {
        proc.on("close", (code) => {
            if (code !== 0) {
                spinner.stopWithError(spinnerMsg)
                // Show captured output on error
                if (stdout) {
                    console.log(stdout)
                }
                if (stderr) {
                    console.error(stderr)
                }
                reject(new Error(`Command failed with exit code ${code}`))
            } else {
                spinner.stopWithSuccess(successMsg)
                resolve()
            }
        })

        proc.on("error", (err) => {
            spinner.stopWithError(spinnerMsg)
            reject(err)
        })
    })
}

/**
 * RunWithSpinnerOutput runs a command with a spinner but returns the captured output
 */
export async function runWithSpinnerOutput(
    command: string,
    args: string[],
    options: SpawnOptions,
    spinnerMsg: string,
    successMsg: string
): Promise<Buffer> {
    if (verbose) {
        info(spinnerMsg)
        const proc = spawn(command, args, {
            ...options,
            stdio: ["inherit", "pipe", "inherit"],
        })

        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = []

            if (proc.stdout) {
                proc.stdout.on("data", (chunk) => {
                    chunks.push(chunk)
                })
            }

            proc.on("close", (code) => {
                if (code === 0) {
                    success(successMsg)
                    resolve(Buffer.concat(chunks))
                } else {
                    reject(new Error(`Command failed with exit code ${code}`))
                }
            })

            proc.on("error", (err) => {
                reject(err)
            })
        })
    }

    const spinner = newSpinner(spinnerMsg)
    spinner.start()

    const proc = spawn(command, args, {
        ...options,
        stdio: ["inherit", "pipe", "pipe"],
    })

    const chunks: Buffer[] = []
    let stderr = ""

    if (proc.stdout) {
        proc.stdout.on("data", (chunk) => {
            chunks.push(chunk)
        })
    }

    if (proc.stderr) {
        proc.stderr.on("data", (data) => {
            stderr += data.toString()
        })
    }

    return new Promise((resolve, reject) => {
        proc.on("close", (code) => {
            if (code !== 0) {
                spinner.stopWithError(spinnerMsg)
                if (stderr) {
                    console.error(stderr)
                }
                reject(new Error(`Command failed with exit code ${code}`))
            } else {
                spinner.stopWithSuccess(successMsg)
                resolve(Buffer.concat(chunks))
            }
        })

        proc.on("error", (err) => {
            spinner.stopWithError(spinnerMsg)
            reject(err)
        })
    })
}

/**
 * RunWithSpinnerFunc runs a function with a spinner
 */
export async function runWithSpinnerFunc(
    fn: () => Promise<void> | void,
    spinnerMsg: string,
    successMsg: string
): Promise<void> {
    if (verbose) {
        info(spinnerMsg)
        await fn()
        success(successMsg)
        return
    }

    const spinner = newSpinner(spinnerMsg)
    spinner.start()

    try {
        await fn()
        spinner.stopWithSuccess(successMsg)
    } catch (err) {
        spinner.stopWithError(spinnerMsg)
        throw err
    }
}

/**
 * RunWithProgress runs a command with a spinner that updates based on STRUX_PROGRESS markers in output
 * The script should emit lines like: STRUX_PROGRESS: Installing packages...
 */
export async function runWithProgress(
    command: string,
    args: string[],
    options: SpawnOptions,
    initialMsg: string,
    successMsg: string
): Promise<void> {
    if (verbose) {
        // In verbose mode, show all output
        info(initialMsg)
        const proc = spawn(command, args, {
            ...options,
            stdio: "inherit",
        })

        return new Promise((resolve, reject) => {
            proc.on("close", (code) => {
                if (code === 0) {
                    success(successMsg)
                    resolve()
                } else {
                    reject(new Error(`Command failed with exit code ${code}`))
                }
            })

            proc.on("error", (err) => {
                reject(err)
            })
        })
    }

    const spinner = newSpinner(initialMsg)
    spinner.start()

    const proc = spawn(command, args, {
        ...options,
        stdio: ["inherit", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    if (proc.stdout) {
        proc.stdout.on("data", (data) => {
            const text = data.toString()
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
        })
    }

    if (proc.stderr) {
        proc.stderr.on("data", (data) => {
            stderr += data.toString()
        })
    }

    return new Promise((resolve, reject) => {
        proc.on("close", (code) => {
            if (code !== 0) {
                spinner.stopWithError(initialMsg)
                // Show captured output on error
                if (stdout) {
                    console.log(stdout)
                }
                if (stderr) {
                    console.error(stderr)
                }
                reject(new Error(`Command failed with exit code ${code}`))
            } else {
                spinner.stopWithSuccess(successMsg)
                resolve()
            }
        })

        proc.on("error", (err) => {
            spinner.stopWithError(initialMsg)
            reject(err)
        })
    })
}
