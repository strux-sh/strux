/***
 *
 *
 *  Logging Utilities
 *
 */

import { Settings } from "../settings"
import chalk from "chalk"
import ora, { type Ora } from "ora"

// Unicode box-drawing characters for consistent styling
const ICONS = {
    arrow: "›",
    success: "✓",
    error: "✗",
    warning: "⚠",
    cached: "◆",
    debug: "○",
    info: "•",
    spinner: "◐",
} as const

export class Logger {
    // Styled prefix badge
    static prefix = chalk.bold.cyan("strux")

    // Format a message with the standard prefix
    private static format(icon: string, iconColor: (s: string) => string, message: string): string {
        return `${Logger.prefix} ${iconColor(icon)} ${message}`
    }

    public static log(message: string) {
        console.log(Logger.format(ICONS.arrow, chalk.cyan, message))
    }

    public static success(message: string) {
        console.log(Logger.format(ICONS.success, chalk.green, chalk.green(message)))
    }

    public static debug(message: string) {
        if (Settings.verbose) {
            console.log(Logger.format(ICONS.debug, chalk.yellow, chalk.dim(message)))
        }
    }

    public static error(message: string) {
        console.error(Logger.format(ICONS.error, chalk.red, chalk.red(message)))
    }

    public static errorWithExit(message: string) {
        Logger.error(message)
        process.exit(1)
    }

    public static cached(message: string) {
        console.log(Logger.format(ICONS.cached, chalk.magenta, `${message} ${chalk.dim("(cached)")}`))
    }

    public static warning(message: string) {
        console.log(Logger.format(ICONS.warning, chalk.yellow, chalk.yellow(message)))
    }

    public static info(message: string) {
        console.log(Logger.format(ICONS.info, chalk.blue, message))
    }

    public static title(msg: string): void {
        console.log()
        console.log(chalk.bold.cyan(`${msg}`))
        console.log(chalk.dim("─".repeat(Math.min(msg.length + 4, 60))))
    }

    public static blank(): void {
        console.log()
    }

    // For printing raw output (like error details) with proper indentation
    public static raw(message: string): void {
        const indent = "       " // Align with message text after prefix and icon
        const lines = message.split("\n")
        for (const line of lines) {
            if (line.trim()) {
                console.log(`${indent}${chalk.dim(line)}`)
            }
        }
    }
}

export class Spinner {
    private spinner: Ora | null = null
    private message: string

    constructor(message: string) {
        this.message = message
    }

    private formatSpinnerText(msg: string): string {
        return `${Logger.prefix} ${chalk.cyan(ICONS.spinner)} ${msg}`
    }

    start(): void {
        this.spinner = ora({
            text: this.formatSpinnerText(this.message),
            spinner: {
                interval: 80,
                frames: ["◐", "◓", "◑", "◒"].map(f => `${Logger.prefix} ${chalk.cyan(f)}`)
            },
            prefixText: "",
        }).start()
        // Override the text to not duplicate the prefix
        if (this.spinner) {
            this.spinner.text = this.message
        }
    }

    stop(): void {
        if (this.spinner) {
            this.spinner.stop()
            this.spinner = null
        }
    }

    stopWithSuccess(msg: string): void {
        if (this.spinner) {
            this.spinner.stop()
            this.spinner = null
        }
        Logger.success(msg)
    }

    stopWithError(msg: string): void {
        if (this.spinner) {
            this.spinner.stop()
            this.spinner = null
        }
        Logger.error(msg)
    }

    stopWithCached(msg: string): void {
        if (this.spinner) {
            this.spinner.stop()
            this.spinner = null
        }
        Logger.cached(msg)
    }

    updateMessage(msg: string): void {
        this.message = msg
        if (this.spinner) {
            this.spinner.text = msg
        }
    }
}
