/***
 *
 *
 *  Strux Dev Client Logging Service
 *
 */

import chalk from "chalk"

type LogLevel = "info" | "warn" | "error" | "debug"

type ServiceName = "Main" | "HostsService" | "SocketService" | "BinaryHandler" | "LogStreamer" | "CageLauncher"

class LoggerClass {

    private getLevelBadge(level: LogLevel): string {
        switch (level) {
            case "info":
                return `${chalk.bgCyan(" STRUX ")} ${chalk.blue("[INFO]")}`
            case "warn":
                return `${chalk.bgCyan(" STRUX ")} ${chalk.yellow("[WARN]")}`
            case "error":
                return `${chalk.bgCyan(" STRUX ")} ${chalk.red("[ERROR]")}`
            case "debug":
                return `${chalk.bgCyan(" STRUX ")} ${chalk.gray("[DEBUG]")}`
        }
    }

    private getServiceColor(service: ServiceName): (text: string) => string {
        switch (service) {
            case "Main":
                return chalk.cyan.bold
            case "HostsService":
                return chalk.magenta.bold
            case "SocketService":
                return chalk.green.bold
            case "BinaryHandler":
                return chalk.blue.bold
            case "LogStreamer":
                return chalk.yellow.bold
            case "CageLauncher":
                return chalk.cyan.bold
        }
    }

    private formatMessage(level: LogLevel, service: ServiceName, message: string): string {
        const levelBadge = this.getLevelBadge(level)
        const serviceColor = this.getServiceColor(service)
        const serviceTag = serviceColor(`[${service}]`.padEnd(18))

        return `${levelBadge} ${serviceTag} ${message}`
    }

    private log(level: LogLevel, service: ServiceName, message: string, ...args: unknown[]): void {
        const formatted = this.formatMessage(level, service, message)

        switch (level) {
            case "info":
                console.log(formatted, ...args)
                break
            case "warn":
                console.warn(formatted, ...args)
                break
            case "error":
                console.error(formatted, ...args)
                break
            case "debug":
                console.debug(formatted, ...args)
                break
        }
    }

    info(service: ServiceName, message: string, ...args: unknown[]): void {
        this.log("info", service, message, ...args)
    }

    warn(service: ServiceName, message: string, ...args: unknown[]): void {
        this.log("warn", service, message, ...args)
    }

    error(service: ServiceName, message: string, ...args: unknown[]): void {
        this.log("error", service, message, ...args)
    }

    debug(service: ServiceName, message: string, ...args: unknown[]): void {
        this.log("debug", service, message, ...args)
    }

}

export const Logger = new LoggerClass()

