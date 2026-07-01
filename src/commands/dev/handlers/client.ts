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
import type { ClientMessageSendable, ClientMessageReceivable, WebUIMessageSendable, WebUIMessageReceivable } from "../types"
import type { Socket } from "../socket-manager"
import type { ResourceName } from "../ui/App"


export function registerClientHandlers(client: Socket<ClientMessageSendable, ClientMessageReceivable>): void {

    const dev = DevServer.getInstance()

    // The web-ui relay: device screen events are forwarded down to viewers here.
    const webui = () => dev.sockets.get<WebUIMessageSendable, WebUIMessageReceivable>("webui")
    let lastLoggedUpdateStatus = ""
    let lastLoggedUpdateBucket = -1


    // Connection lifecycle
    client.onConnect((_ws) => {
        Logger.info("Client connected")
        dev.setDeviceStatus({ connected: true, bspName: Settings.bspName ?? undefined, arch: Settings.targetArch })
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

        // Tell viewers the device is gone and drop the cached outputs.
        dev.deviceOutputs = []
        dev.setDeviceStatus({ connected: false, ip: undefined, version: undefined })
        webui().broadcast({ type: "device-disconnected" })
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
        dev.pushDashboardLog({ source: payload.type, line: payload.line, timestamp: payload.timestamp })
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

        // Cache outputs and push them to any connected viewers.
        dev.deviceOutputs = payload.outputs ?? []
        webui().broadcast({ type: "outputs-available", payload: { outputs: dev.deviceOutputs } })

        // Update the dashboard device card.
        dev.setDeviceStatus({
            connected: true,
            ip: payload.ip,
            version: payload.version,
            bspName: Settings.bspName ?? undefined,
            arch: Settings.targetArch,
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


    // Screen — forward device stream events down to the web-ui viewers.
    client.on("screen-ready", (payload, _ws) => {
        webui().broadcast({ type: "screen-ready", payload })
    })

    client.on("screen-stopped", (payload, _ws) => {
        webui().broadcast({ type: "screen-stopped", payload })
    })

    client.on("screen-error", (payload, _ws) => {
        Logger.warning(`Screen error on ${payload.outputName}: ${payload.error}`)
        webui().broadcast({ type: "screen-error", payload })
    })

    client.on("screen-picture-received", (payload, _ws) => {
        // Device emits "screen-picture-received"; viewers expect "screen-screenshot-result".
        webui().broadcast({ type: "screen-screenshot-result", payload })
    })


    // Update
    client.on("update-check-request", (_payload, _ws) => {
        // TODO: Check for updates and respond
    })


}
