/***
 *
 *
 *  Logging Utilities
 *
 */

import { Settings } from "../settings"
import chalk from "chalk"
import ora, { type Ora } from "ora"

export class Logger {

    static prefix = chalk.black.bgCyan(" STRUX ")


    public static log(message: string) {

        console.log(`${Logger.prefix} ${chalk.blue("→")} ${message}`)
    }

    public static success(message: string) {

        console.log(`${Logger.prefix} ${chalk.greenBright("✓")} ${message}`)

    }

    public static debug(message: string) {

        if (Settings.verbose) {

            console.log(`${Logger.prefix} ${chalk.yellow("[DEBUG]")} ${chalk.dim(message)}`)

        }

    }

    public static error(message: string) {

        console.error(`${Logger.prefix} ${chalk.redBright("✗")} ${message}`)
    }

    public static errorWithExit(message: string) {
        console.error(`${Logger.prefix} ${chalk.redBright("✗")} ${message}`)
        process.exit(1)
    }

    public static cached(message: string) {


        console.log(`${Logger.prefix} ${message} ${chalk.dim("(cached)")}`)

    }

    public static title(msg: string): void {
        console.log("\n" + chalk.bold.magenta(msg))
    }

}

export class Spinner {


    private spinner: Ora | null = null
    private message: string

    constructor( message: string) {

        this.message = message
    }


    start(): void {
        this.spinner = ora({
            text: this.message,
            color: "cyan",
        }).start()
    }

    stop(): void {
        if (this.spinner) {
            this.spinner.stop()
            this.spinner = null
        }
    }

    stopWithSuccess(msg: string): void {
        if (this.spinner) {
            this.spinner.succeed(msg)
            this.spinner = null
        } else {
            Logger.success(msg)
        }
    }


    stopWithError(msg: string): void {
        if (this.spinner) {
            this.spinner.fail(msg)
            this.spinner = null
        } else {
            Logger.error(msg)
        }
    }

    updateMessage(msg: string): void {
        this.message = msg
        if (this.spinner) {
            this.spinner.text = msg
        }
    }
}