/***
 *
 *
 * Client Socket Handlers
 *
 *
 */
import { join } from "path"
import { Settings } from "../../../settings"
import { Logger } from "../../../utils/log"
import { DevServer } from "../index"
import type { ClientMessageSendable, ClientMessageReceivable } from "../types"
import type { Socket } from "../socket-manager"
import type { ResourceName } from "../ui/App"


export function registerClientHandlers(client: Socket<ClientMessageSendable, ClientMessageReceivable>): void {

    const dev = DevServer.getInstance()
    let lastLoggedUpdateStatus = ""
    let lastLoggedUpdateBucket = -1


    // Connection lifecycle
    client.onConnect((_ws) => {
        Logger.info("Client connected")
        dev.ui.store.updateStatus("device", "connected")
        dev.ui.store.updateStatus("device:app", "running")
        dev.ui.store.updateStatus("device:cage", "running")
        dev.ui.store.updateStatus("device:system", "running")
        dev.ui.store.updateStatus("device:early", "running")
        dev.ui.store.updateStatus("device:screen", "running")
        dev.ui.store.updateStatus("device:client", "running")
    })

    client.onDisconnect((_ws) => {
        Logger.warning("Client disconnected")
        lastLoggedUpdateStatus = ""
        lastLoggedUpdateBucket = -1
        dev.ssh.clearAll()
        dev.ui.store.updateStatus("device", "disconnected")
        dev.ui.store.updateStatus("device:app", "stopped")
        dev.ui.store.updateStatus("device:cage", "stopped")
        dev.ui.store.updateStatus("device:system", "stopped")
        dev.ui.store.updateStatus("device:early", "stopped")
        dev.ui.store.updateStatus("device:screen", "stopped")
        dev.ui.store.updateStatus("device:client", "stopped")
        dev.ui.store.setDeviceIP(undefined)
        dev.ui.store.clearSystemUpdateProgress()
    })


    // Logging — route to sub-resource by log type
    const logTypeToResource: Record<string, ResourceName> = {
        "journalctl": "device:system",
        "service":    "device:system",
        "app":        "device:app",
        "cage":       "device:cage",
        "screen":     "device:screen",
        "early":      "device:early",
        "client":     "device:client",
    }

    client.on("log-line", (payload, _ws) => {
        const resource = logTypeToResource[payload.type] ?? "device"
        dev.ui.store.appendLog(resource, {
            level: "info",
            message: payload.line,
            timestamp: Date.now(),
        })
    })


    // Device info
    client.on("device-info", (payload, _ws) => {
        Logger.info(`Device connected: ${payload.ip}${payload.version ? ` (v${payload.version})` : ""}`)
        dev.ui.store.setDeviceInfo({
            ip: payload.ip,
            inspectorPorts: payload.inspectorPorts,
            outputs: payload.outputs,
            version: payload.version,
        })
    })


    // Binary acknowledgments
    client.on("binary-ack", (payload, _ws) => {
        Logger.info(`Binary ${payload.binary}: ${payload.status}`)
    })


    // Component acknowledgments
    client.on("component-ack", (payload, _ws) => {
        const detail = payload.message ? ` (${payload.message})` : ""
        Logger.info(`Component ${payload.destPath || payload.message}: ${payload.status}${detail}`)
        dev.handleComponentAck(payload.destPath, payload.status, payload.message)
    })

    client.on("component-archive-ack", (payload, _ws) => {
        Logger.info(`Archive ${payload.extractPath || payload.message}: ${payload.status}`)
    })

    client.on("system-update-ack", (payload, _ws) => {
        const detail = [
            payload.version ? `version=${payload.version}` : "",
            payload.slot ? `slot=${payload.slot}` : "",
            payload.message,
        ].filter(Boolean).join(", ")
        Logger.info(`System update: ${payload.status}${detail ? ` (${detail})` : ""}`)
        dev.handleSystemUpdateAck(payload.status, payload.message)
    })

    client.on("update-progress", (payload, _ws) => {
        const progress = Math.max(0, Math.min(100, Math.round(payload.progress ?? 0)))
        const details = [
            payload.version ? `version=${payload.version}` : "",
            payload.slot ? `slot=${payload.slot}` : "",
            payload.message,
        ].filter(Boolean).join(", ")

        const bucket = Math.floor(progress / 10)
        const shouldLog =
            payload.status !== lastLoggedUpdateStatus ||
            payload.status === "completed" ||
            payload.status === "failed" ||
            bucket > lastLoggedUpdateBucket

        if (shouldLog) {
            Logger.info(`System update ${payload.status}: ${progress}%${details ? ` (${details})` : ""}`)
            lastLoggedUpdateStatus = payload.status
            lastLoggedUpdateBucket = bucket
        }

        dev.ui.store.setSystemUpdateProgress({
            status: payload.status,
            progress,
            message: payload.message,
            bytesWritten: payload.bytesWritten,
            totalBytes: payload.totalBytes,
            slot: payload.slot,
            version: payload.version,
        })
    })


    // SSH output — route to TUI
    client.on("ssh-output", (payload, _ws) => {
        dev.ssh.handleOutput(payload.sessionID, payload.data)
    })

    client.on("ssh-exit-received", (payload, _ws) => {
        Logger.info(`SSH session ${payload.sessionID} exited with code ${payload.code}`)
        dev.ssh.handleExit(payload.sessionID, payload.code)
    })


    // Binary requested — device is asking for the current binary
    client.on("binary-requested", async (_payload, ws) => {

        const bspName = Settings.bspName!
        const binaryPath = join(Settings.projectPath, "dist", "cache", bspName, "app", "main")
        const binaryFile = Bun.file(binaryPath)

        if (await binaryFile.exists()) {
            const binaryData = Buffer.from(await binaryFile.arrayBuffer())
            const base64 = binaryData.toString("base64")
            client.send(ws, { type: "binary-new", payload: { data: base64 } })
            Logger.info("Binary sent to device (requested)")

        } else {

            Logger.warning(`Compiled binary not found at ${binaryPath}`)

        }

    })


    // Screen
    client.on("screen-picture-received", (payload, _ws) => {
        // TODO: Forward screenshot to UI
    })


    // Update
    client.on("update-check-request", (_payload, _ws) => {
        // TODO: Check for updates and respond
    })


}
