/***
 *
 *
 *  Dev Server
 *
 *  WebSocket server for dev mode communication with the Strux client.
 *  Uses a simple JSON protocol with event-based message handling.
 *
 *  Message Format:
 *  {
 *      "type": "event-name",
 *      "payload": { ... event data ... }
 *  }
 *
 *  Client -> Server Events:
 *  - "request-binary": Request the current binary (no payload)
 *  - "log-line": Send a log line { streamId, line, service?, timestamp }
 *  - "log-stream-error": Send an error { streamId, error }
 *  - "exec-output": Send console output { sessionId, stream, data }
 *  - "exec-exit": Send console exit { sessionId, code }
 *  - "exec-error": Send console error { sessionId, error }
 *
 *  Server -> Client Events:
 *  - "new-binary": Send binary update { data: string } (base64 encoded)
 *  - "start-logs": Start log streaming { streamId, type, service? }
 *  - "stop-logs": Stop log streaming { streamId }
 *  - "exec-start": Start interactive shell { sessionId, shell? }
 *  - "exec-input": Send input { sessionId, data }
 *
 */

import type { Server, ServerWebSocket } from "bun"

import { Bonjour, type Service } from "bonjour-service"

import chalk from "chalk"

import { Logger } from "../../utils/log"


// -----------------------------------------
//  Types
// -----------------------------------------

interface Message {
    type: string
    payload?: unknown
}


interface BinaryPayload {
    data: string  // Base64 encoded binary data
}


interface StartLogsPayload {
    streamId: string
    type: "journalctl" | "service" | "app" | "cage" | "early"
    service?: string
}


interface StopLogsPayload {
    streamId: string
}


interface LogLinePayload {
    streamId: string
    line: string
    service?: string
    timestamp: string
}


interface LogErrorPayload {
    streamId: string
    error: string
}


interface ExecStartPayload {
    sessionId: string
    shell?: string
}

interface ExecInputPayload {
    sessionId: string
    data: string
}

interface ExecOutputPayload {
    sessionId: string
    stream: "stdout" | "stderr"
    data: string
}

interface ExecExitPayload {
    sessionId: string
    code: number
}

interface ExecErrorPayload {
    sessionId: string
    error: string
}

interface BinaryAckPayload {
    status: "skipped" | "updated" | "error"
    message: string
    currentChecksum?: string
    receivedChecksum?: string
}


export type ComponentType = "cage" | "wpe-extension" | "client" | "script" | "screen" | "cog"

interface ComponentPayload {
    componentType: ComponentType
    data: string  // Base64 encoded binary data
    destPath: string
}


interface ComponentAckPayload {
    componentType: string
    status: "updated" | "error"
    message: string
}


interface DeviceInfoInspectorPort {
    path: string
    port: number
}


interface DeviceInfoOutputInfo {
    name: string
}

interface DeviceInfoPayload {
    ip: string
    inspectorPorts: DeviceInfoInspectorPort[]
    outputs?: DeviceInfoOutputInfo[]
}


interface ScreenReadyPayload {
    outputName: string
    width: number
    height: number
    encoder: string
    fps: number
}

interface ScreenStoppedPayload {
    outputName: string
}

interface ScreenErrorPayload {
    outputName: string
    error: string
}

interface ScreenScreenshotResultPayload {
    outputName: string
    data: string  // base64 JPEG
    width: number
    height: number
}


interface DevServerOptions {
    port: number
    clientKey: string
    onClientConnected?: () => void
    onClientDisconnected?: () => void
    onBinaryRequested?: () => void
    onLogLine?: (payload: LogLinePayload) => void
    onLogError?: (payload: LogErrorPayload) => void
    onBinaryAck?: (payload: BinaryAckPayload) => void
    onExecOutput?: (payload: ExecOutputPayload) => void
    onExecExit?: (payload: ExecExitPayload) => void
    onExecError?: (payload: ExecErrorPayload) => void
    onComponentAck?: (payload: ComponentAckPayload) => void
    onDeviceInfo?: (payload: DeviceInfoPayload) => void
    onScreenReady?: (payload: ScreenReadyPayload) => void
    onScreenStopped?: (payload: ScreenStoppedPayload) => void
    onScreenError?: (payload: ScreenErrorPayload) => void
    onScreenScreenshot?: (payload: ScreenScreenshotResultPayload) => void
}


interface WebSocketData {
    authenticated: boolean
    clientKey: string
    type: "device" | "device-screen" | "viewer"
}


// -----------------------------------------
//  Dev Server Class
// -----------------------------------------

export class DevServer {

    private server: Server<WebSocketData> | null = null

    private client: ServerWebSocket<WebSocketData> | null = null

    private screenClient: ServerWebSocket<WebSocketData> | null = null

    private screenViewers = new Set<ServerWebSocket<WebSocketData>>()

    private options: DevServerOptions

    private activeLogStreams = new Map<string, { type: string; service?: string }>()

    private currentBinary: Buffer | null = null

    private bonjour: Bonjour | null = null

    private bonjourService: Service | null = null

    private screenViewerHtml: string | null = null

    private deviceOutputs: DeviceInfoOutputInfo[] = []


    constructor(options: DevServerOptions) {

        this.options = options

    }


    // -----------------------------------------
    //  Server Lifecycle
    // -----------------------------------------

    public start(): void {

        const self = this

        this.server = Bun.serve<WebSocketData>({

            port: this.options.port,

            fetch(req, server) {

                const url = new URL(req.url)

                // Handle WebSocket upgrade on /ws endpoint (device control)
                if (url.pathname === "/ws") {

                    const clientKey = req.headers.get("x-client-key") ?? ""

                    const success = server.upgrade(req, {
                        data: {
                            authenticated: false,
                            clientKey: clientKey,
                            type: "device" as const
                        }
                    })

                    if (success) {
                        return undefined
                    }

                    return new Response("WebSocket upgrade failed", { status: 400 })

                }

                // Handle WebSocket upgrade on /ws/screen (device binary frame data)
                if (url.pathname === "/ws/screen") {

                    const clientKey = req.headers.get("x-client-key") ?? ""

                    const success = server.upgrade(req, {
                        data: {
                            authenticated: false,
                            clientKey: clientKey,
                            type: "device-screen" as const
                        }
                    })

                    if (success) {
                        return undefined
                    }

                    return new Response("WebSocket upgrade failed", { status: 400 })

                }

                // Handle WebSocket upgrade on /screen/ws (web viewer)
                if (url.pathname === "/screen/ws") {

                    const success = server.upgrade(req, {
                        data: {
                            authenticated: true,
                            clientKey: "",
                            type: "viewer" as const
                        }
                    })

                    if (success) {
                        return undefined
                    }

                    return new Response("WebSocket upgrade failed", { status: 400 })

                }

                // Serve the screen viewer HTML
                if (url.pathname === "/screen") {

                    if (self.screenViewerHtml) {
                        return new Response(self.screenViewerHtml, {
                            headers: { "Content-Type": "text/html; charset=utf-8" }
                        })
                    }

                    return new Response("Screen viewer not available", { status: 404 })

                }

                // Health check endpoint
                if (url.pathname === "/health") {

                    return new Response(JSON.stringify({
                        status: "ok",
                        clientConnected: self.isClientConnected()
                    }), {
                        headers: { "Content-Type": "application/json" }
                    })

                }

                return new Response("Not Found", { status: 404 })

            },

            websocket: {

                open(ws) {

                    if (ws.data.type === "device-screen") {
                        self.handleScreenOpen(ws)
                    } else if (ws.data.type === "viewer") {
                        self.handleViewerOpen(ws)
                    } else {
                        self.handleOpen(ws)
                    }

                },

                message(ws, message) {

                    if (ws.data.type === "device-screen") {
                        self.handleScreenMessage(ws, message)
                    } else if (ws.data.type === "viewer") {
                        self.handleViewerMessage(ws, message)
                    } else {
                        self.handleMessage(ws, message)
                    }

                },

                close(ws, code, reason) {

                    if (ws.data.type === "device-screen") {
                        self.handleScreenClose(ws)
                    } else if (ws.data.type === "viewer") {
                        self.handleViewerClose(ws)
                    } else {
                        self.handleClose(ws, code, reason)
                    }

                }

            }

        })

        Logger.log(`Dev server started on port ${this.options.port}`)

        // Start Bonjour/mDNS advertisement
        this.startBonjourAdvertisement()

    }


    public stop(): void {

        // Stop Bonjour advertisement first
        this.stopBonjourAdvertisement()

        if (this.server) {

            this.server.stop()

            this.server = null

            Logger.log("Dev server stopped")

        }

    }


    // -----------------------------------------
    //  Bonjour/mDNS Advertisement
    // -----------------------------------------

    private startBonjourAdvertisement(): void {

        try {

            this.bonjour = new Bonjour()

            // Publish the service as _strux-dev._tcp (matching what the Go client looks for)
            this.bonjourService = this.bonjour.publish({
                name: "Strux Dev Server",
                type: "strux-dev",
                port: this.options.port,
                txt: {
                    version: "1.0"
                }
            })

            Logger.log("Bonjour advertisement started (_strux-dev._tcp)")

        } catch (error) {

            Logger.warning(`Failed to start Bonjour advertisement: ${(error as Error).message}`)

        }

    }


    private stopBonjourAdvertisement(): void {

        if (this.bonjourService) {

            if (this.bonjourService.stop) {

                this.bonjourService.stop()

            }

            this.bonjourService = null

        }

        if (this.bonjour) {

            this.bonjour.destroy()

            this.bonjour = null

            Logger.log("Bonjour advertisement stopped")

        }

    }


    public isClientConnected(): boolean {

        return this.client !== null

    }


    // -----------------------------------------
    //  WebSocket Handlers
    // -----------------------------------------

    private handleOpen(ws: ServerWebSocket<WebSocketData>): void {

        // Check if a client is already connected
        if (this.client !== null) {

            Logger.warning("Rejecting connection: A client is already connected")

            ws.close(4001, "Another client is already connected")

            return

        }

        // Validate client key
        const clientKey = ws.data.clientKey

        if (clientKey !== this.options.clientKey) {

            Logger.warning("Rejecting connection: Invalid client key")

            ws.close(4002, "Invalid client key")

            return

        }

        // Accept the connection
        ws.data.authenticated = true

        this.client = ws

        Logger.success("Client connected")

        // Notify callback
        if (this.options.onClientConnected) {

            this.options.onClientConnected()

        }

    }


    private handleMessage(ws: ServerWebSocket<WebSocketData>, message: string | Buffer): void {

        // Ensure client is authenticated
        if (!ws.data.authenticated) {

            Logger.warning("Received message from unauthenticated client")

            return

        }

        // Parse the message
        let msg: Message

        try {

            const messageStr = typeof message === "string" ? message : message.toString()

            msg = JSON.parse(messageStr) as Message

        } catch {

            Logger.warning("Failed to parse message from client")

            return

        }

        // Dispatch to event handler
        this.dispatchEvent(msg.type, msg.payload)

    }


    private handleClose(_ws: ServerWebSocket<WebSocketData>, code: number, reason: string): void {

        if (this.client === _ws) {

            this.client = null

            // Clear the screen data channel too (device is gone)
            this.screenClient = null

            // Clear all active log streams
            this.activeLogStreams.clear()

            // Notify viewers that streams have stopped
            this.broadcastToViewers("device-disconnected", {})

            Logger.warning(`Client disconnected (code: ${code}, reason: ${reason || "none"})`)

            // Notify callback
            if (this.options.onClientDisconnected) {

                this.options.onClientDisconnected()

            }

        }

    }


    // -----------------------------------------
    //  Event Dispatch
    // -----------------------------------------

    private dispatchEvent(eventType: string, payload: unknown): void {

        switch (eventType) {

            case "request-binary":
                this.handleRequestBinary()
                break

            case "log-line":
                this.handleLogLine(payload as LogLinePayload)
                break

            case "log-stream-error":
                this.handleLogError(payload as LogErrorPayload)
                break

            case "binary-ack":
                this.handleBinaryAck(payload as BinaryAckPayload)
                break
            case "exec-output":
                this.handleExecOutput(payload as ExecOutputPayload)
                break
            case "exec-exit":
                this.handleExecExit(payload as ExecExitPayload)
                break
            case "exec-error":
                this.handleExecError(payload as ExecErrorPayload)
                break

            case "component-ack":
                this.handleComponentAck(payload as ComponentAckPayload)
                break

            case "device-info":
                this.handleDeviceInfo(payload as DeviceInfoPayload)
                break

            case "screen-ready":
                this.handleScreenReady(payload as ScreenReadyPayload)
                break

            case "screen-stopped":
                this.handleScreenStopped(payload as ScreenStoppedPayload)
                break

            case "screen-error":
                this.handleScreenError(payload as ScreenErrorPayload)
                break

            case "screen-screenshot-result":
                this.handleScreenScreenshot(payload as ScreenScreenshotResultPayload)
                break

            default:
                Logger.warning(`Unknown event type: ${eventType}`)

        }

    }


    // -----------------------------------------
    //  Client Event Handlers
    // -----------------------------------------

    private handleRequestBinary(): void {

        Logger.log("Client requested binary")

        // Notify callback
        if (this.options.onBinaryRequested) {

            this.options.onBinaryRequested()

        }

        // If we have a current binary, send it
        if (this.currentBinary) {

            this.sendBinary(this.currentBinary)

        }

    }


    private handleLogLine(payload: LogLinePayload): void {
        if (this.options.onLogLine) {
            this.options.onLogLine(payload)
            return
        }

        // Format and display the log line
        const timestamp = payload.timestamp ? chalk.dim(payload.timestamp) : ""

        const service = payload.service ? chalk.cyan(`[${payload.service}]`) : ""

        // Use different colors for different stream types
        let streamId: string
        let line: string

        if (payload.streamId === "app") {
            // App logs get a green prefix and the line is highlighted
            streamId = chalk.green.bold("[APP]")
            line = chalk.green(payload.line)
        } else if (payload.streamId === "cage") {
            // Cage logs get a blue prefix and the line is highlighted
            streamId = chalk.blue.bold("[CAGE]")
            line = chalk.blue(payload.line)
        } else {
            streamId = chalk.magenta(`[${payload.streamId}]`)
            line = payload.line
        }

        // Print the log line to console
        console.log(`${timestamp} ${streamId} ${service} ${line}`)

    }


    private handleLogError(payload: LogErrorPayload): void {
        if (this.options.onLogError) {
            this.options.onLogError(payload)
            return
        }

        Logger.error(`Log stream error (${payload.streamId}): ${payload.error}`)

    }


    private handleBinaryAck(payload: BinaryAckPayload): void {
        if (this.options.onBinaryAck) {
            this.options.onBinaryAck(payload)
            return
        }

        switch (payload.status) {

            case "skipped":
                Logger.info(`Binary skipped: ${payload.message}`)
                if (payload.currentChecksum && payload.receivedChecksum) {
                    Logger.info(`  Current checksum: ${payload.currentChecksum.substring(0, 16)}...`)
                    Logger.info(`  Received checksum: ${payload.receivedChecksum.substring(0, 16)}...`)
                }
                break

            case "updated":
                Logger.success(`Binary updated on device: ${payload.message}`)
                break

            case "error":
                Logger.error(`Binary update failed: ${payload.message}`)
                break

        }

    }

    private handleExecOutput(payload: ExecOutputPayload): void {
        if (this.options.onExecOutput) {
            this.options.onExecOutput(payload)
            return
        }

        Logger.log(`Console output (${payload.sessionId}): ${payload.data}`)
    }

    private handleExecExit(payload: ExecExitPayload): void {
        if (this.options.onExecExit) {
            this.options.onExecExit(payload)
            return
        }

        Logger.info(`Console exited (${payload.sessionId}) with code ${payload.code}`)
    }

    private handleExecError(payload: ExecErrorPayload): void {
        if (this.options.onExecError) {
            this.options.onExecError(payload)
            return
        }

        Logger.error(`Console error (${payload.sessionId}): ${payload.error}`)
    }


    private handleComponentAck(payload: ComponentAckPayload): void {
        if (this.options.onComponentAck) {
            this.options.onComponentAck(payload)
            return
        }

        if (payload.status === "updated") {
            Logger.success(`Component ${payload.componentType} updated: ${payload.message}`)
        } else {
            Logger.error(`Component ${payload.componentType} failed: ${payload.message}`)
        }
    }


    private handleDeviceInfo(payload: DeviceInfoPayload): void {
        // Store outputs for viewer auto-discovery
        if (payload.outputs) {
            this.deviceOutputs = payload.outputs
            Logger.log(`Device outputs: ${payload.outputs.map(o => o.name).join(", ")}`)
            // Notify viewers of available outputs
            this.broadcastToViewers("outputs-available", { outputs: payload.outputs })
        }

        if (this.options.onDeviceInfo) {
            this.options.onDeviceInfo(payload)
            return
        }

        Logger.info(`Device IP: ${payload.ip}`)
        for (const port of payload.inspectorPorts) {
            Logger.info(`  Inspector: ${port.path} -> http://${payload.ip}:${port.port}`)
        }
    }


    // -----------------------------------------
    //  Server -> Client Events
    // -----------------------------------------

    private emit(eventType: string, payload?: unknown): boolean {

        if (!this.client) {

            Logger.warning("Cannot emit event: No client connected")

            return false

        }

        const message: Message = {
            type: eventType,
            payload: payload
        }

        try {

            this.client.send(JSON.stringify(message))

            return true

        } catch (error) {

            Logger.error(`Failed to emit event: ${(error as Error).message}`)

            return false

        }

    }


    /**
     * Stream a binary to the connected client.
     * The binary is base64 encoded before sending.
     *
     * @param binary - The binary data to send
     * @returns true if the binary was sent successfully, false otherwise
     */
    public sendBinary(binary: Buffer): boolean {

        if (!this.client) {

            Logger.warning("Cannot send binary: No client connected")

            return false

        }

        // Store the current binary for future request-binary events
        this.currentBinary = binary

        // Base64 encode the binary
        const base64Data = binary.toString("base64")

        const payload: BinaryPayload = {
            data: base64Data
        }

        Logger.log(`Streaming binary to client (${binary.length} bytes)`)

        return this.emit("new-binary", payload)

    }


    /**
     * Start a log stream on the client.
     * Use "journalctl" type for all system logs, "service" type with a service name,
     * "app" type for the user's Go app output, "cage" type for Cage/Cog compositor logs,
     * or "early" type for best-effort early boot logs.
     *
     * @param streamId - Unique identifier for this log stream
     * @param type - Type of log stream: "journalctl", "service", "app", or "cage"
     * @param service - Service name (required if type is "service")
     * @returns true if the event was sent successfully
     */
    public startLogStream(streamId: string, type: "journalctl" | "service" | "app" | "cage" | "early", service?: string): boolean {

        if (type === "service" && !service) {

            Logger.error("Service name is required for service log streams")

            return false

        }

        // Track the active log stream
        this.activeLogStreams.set(streamId, { type, service })

        const payload: StartLogsPayload = {
            streamId: streamId,
            type: type,
            service: service
        }

        Logger.log(`Starting log stream: ${streamId} (${type}${service ? `: ${service}` : ""})`)

        return this.emit("start-logs", payload)

    }


    /**
     * Stop a log stream on the client.
     *
     * @param streamId - The stream ID to stop
     * @returns true if the event was sent successfully
     */
    public stopLogStream(streamId: string): boolean {

        // Remove from active streams
        this.activeLogStreams.delete(streamId)

        const payload: StopLogsPayload = {
            streamId: streamId
        }

        Logger.log(`Stopping log stream: ${streamId}`)

        return this.emit("stop-logs", payload)

    }


    /**
     * Stop all active log streams.
     */
    public stopAllLogStreams(): void {

        for (const streamId of this.activeLogStreams.keys()) {

            this.stopLogStream(streamId)

        }

    }


    /**
     * Get the list of active log stream IDs.
     */
    public getActiveLogStreams(): string[] {

        return Array.from(this.activeLogStreams.keys())

    }


    /**
     * Update the current binary that will be sent on request-binary events.
     * Does not immediately send the binary to the client.
     *
     * @param binary - The binary data to store
     */
    public setCurrentBinary(binary: Buffer): void {

        this.currentBinary = binary

    }


    /**
     * Get the server port.
     */
    /**
     * Start an interactive exec session on the client.
     */
    public startExecSession(sessionId: string, shell?: string): boolean {
        const payload: ExecStartPayload = {
            sessionId,
            shell
        }

        Logger.log(`Starting exec session: ${sessionId}`)

        return this.emit("exec-start", payload)
    }

    /**
     * Send input to an interactive exec session.
     */
    public sendExecInput(sessionId: string, data: string): boolean {
        const payload: ExecInputPayload = {
            sessionId,
            data
        }

        return this.emit("exec-input", payload)
    }

    /**
     * Send a component binary to the connected client for replacement on device.
     *
     * @param componentType - The type of component being sent
     * @param binary - The binary data to send
     * @param destPath - The target filesystem path on the device
     * @returns true if the event was sent successfully
     */
    public sendComponent(componentType: ComponentType, binary: Buffer, destPath: string): boolean {

        if (!this.client) {

            Logger.warning("Cannot send component: No client connected")

            return false

        }

        const base64Data = binary.toString("base64")

        const payload: ComponentPayload = {
            componentType,
            data: base64Data,
            destPath
        }

        Logger.log(`Streaming ${componentType} component to client (${binary.length} bytes) -> ${destPath}`)

        return this.emit("new-component", payload)

    }


    /**
     * Tell the connected client to restart the Strux service.
     *
     * @returns true if the event was sent successfully
     */
    public sendRestartService(): boolean {

        Logger.log("Sending restart-service command to client")

        return this.emit("restart-service", null)

    }


    /**
     * Tell the connected client to reboot the device.
     *
     * @returns true if the event was sent successfully
     */
    public sendReboot(): boolean {

        Logger.log("Sending reboot command to client")

        return this.emit("reboot", null)

    }


    /**
     * Get the server port.
     */
    public getPort(): number {

        return this.options.port

    }


    /**
     * Set the screen viewer HTML content (embedded asset).
     */
    public setScreenViewerHtml(html: string): void {

        this.screenViewerHtml = html

    }


    // -----------------------------------------
    //  Screen Streaming
    // -----------------------------------------

    /**
     * Start screen streaming for the given output on the device.
     */
    public startScreen(outputName: string): boolean {

        Logger.log(`Starting screen stream for output: ${outputName} (client connected: ${this.client !== null})`)
        return this.emit("screen-start", { outputName })

    }

    /**
     * Stop screen streaming for the given output on the device.
     */
    public stopScreen(outputName: string): boolean {

        return this.emit("screen-stop", { outputName })

    }

    /**
     * Request a screenshot from the given output on the device.
     */
    public requestScreenshot(outputName: string): boolean {

        return this.emit("screen-screenshot", { outputName })

    }


    // -----------------------------------------
    //  Screen Device WebSocket (/ws/screen)
    // -----------------------------------------

    private handleScreenOpen(ws: ServerWebSocket<WebSocketData>): void {

        // Validate client key
        if (ws.data.clientKey !== this.options.clientKey) {
            Logger.warning("Rejecting screen connection: Invalid client key")
            ws.close(4002, "Invalid client key")
            return
        }

        ws.data.authenticated = true
        this.screenClient = ws
        Logger.log("Screen data channel connected")

    }

    private handleScreenMessage(_ws: ServerWebSocket<WebSocketData>, message: string | Buffer): void {

        // Binary frame data from device — relay to all screen viewers
        if (typeof message !== "string") {
            for (const viewer of this.screenViewers) {
                try {
                    viewer.send(message)
                } catch {
                    // Viewer disconnected, will be cleaned up on close
                }
            }
        }

    }

    private handleScreenClose(_ws: ServerWebSocket<WebSocketData>): void {

        if (this.screenClient === _ws) {
            this.screenClient = null
            Logger.log("Screen data channel disconnected")
        }

    }


    // -----------------------------------------
    //  Screen Viewer WebSocket (/screen/ws)
    // -----------------------------------------

    private handleViewerOpen(ws: ServerWebSocket<WebSocketData>): void {

        this.screenViewers.add(ws)
        Logger.log(`Screen viewer connected (${this.screenViewers.size} total)`)

        // If we already have cached outputs, send them immediately
        if (this.deviceOutputs.length > 0) {
            try {
                ws.send(JSON.stringify({
                    type: "outputs-available",
                    payload: { outputs: this.deviceOutputs }
                }))
            } catch {
                // Viewer might have disconnected already
            }
        }

        // Request fresh device info from the device (includes outputs)
        this.emit("get-device-info", null)

    }

    private handleViewerMessage(ws: ServerWebSocket<WebSocketData>, message: string | Buffer): void {

        Logger.log(`Viewer message received: ${typeof message === "string" ? message : message.toString()}`)

        // Parse JSON commands from the viewer
        try {
            const msgStr = typeof message === "string" ? message : message.toString()
            const msg = JSON.parse(msgStr) as Message

            switch (msg.type) {
                case "start-stream": {
                    const payload = msg.payload as { outputName: string }
                    if (payload?.outputName) {
                        this.startScreen(payload.outputName)
                    }
                    break
                }
                case "stop-stream": {
                    const payload = msg.payload as { outputName: string }
                    if (payload?.outputName) {
                        this.stopScreen(payload.outputName)
                    }
                    break
                }
                case "screenshot": {
                    const payload = msg.payload as { outputName: string }
                    if (payload?.outputName) {
                        this.requestScreenshot(payload.outputName)
                    }
                    break
                }
                default:
                    break
            }
        } catch {
            // Ignore invalid messages from viewer
        }

    }

    private handleViewerClose(ws: ServerWebSocket<WebSocketData>): void {

        this.screenViewers.delete(ws)
        Logger.log(`Screen viewer disconnected (${this.screenViewers.size} remaining)`)

    }


    // -----------------------------------------
    //  Screen Event Handlers (from device)
    // -----------------------------------------

    private handleScreenReady(payload: ScreenReadyPayload): void {
        // Forward to viewers
        this.broadcastToViewers("screen-ready", payload)

        if (this.options.onScreenReady) {
            this.options.onScreenReady(payload)
        }
    }

    private handleScreenStopped(payload: ScreenStoppedPayload): void {
        this.broadcastToViewers("screen-stopped", payload)

        if (this.options.onScreenStopped) {
            this.options.onScreenStopped(payload)
        }
    }

    private handleScreenError(payload: ScreenErrorPayload): void {
        this.broadcastToViewers("screen-error", payload)

        if (this.options.onScreenError) {
            this.options.onScreenError(payload)
        }
    }

    private handleScreenScreenshot(payload: ScreenScreenshotResultPayload): void {
        this.broadcastToViewers("screen-screenshot-result", payload)

        if (this.options.onScreenScreenshot) {
            this.options.onScreenScreenshot(payload)
        }
    }

    /**
     * Broadcast a JSON message to all connected screen viewers.
     */
    private broadcastToViewers(type: string, payload: unknown): void {

        const message = JSON.stringify({ type, payload })

        for (const viewer of this.screenViewers) {
            try {
                viewer.send(message)
            } catch {
                // Will be cleaned up on close
            }
        }

    }

}


// -----------------------------------------
//  Singleton Instance (optional usage)
// -----------------------------------------

let serverInstance: DevServer | null = null


/**
 * Create and start a dev server instance.
 * Only one server can be active at a time.
 *
 * @param options - Server configuration options
 * @returns The dev server instance
 */
export function createDevServer(options: DevServerOptions): DevServer {

    if (serverInstance) {

        serverInstance.stop()

    }

    serverInstance = new DevServer(options)

    serverInstance.start()

    return serverInstance

}


/**
 * Get the current dev server instance, if one exists.
 */
export function getDevServer(): DevServer | null {

    return serverInstance

}


/**
 * Stop the current dev server instance.
 */
export function stopDevServer(): void {

    if (serverInstance) {

        serverInstance.stop()

        serverInstance = null

    }

}
