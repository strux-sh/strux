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
 *
 *  Server -> Client Events:
 *  - "new-binary": Send binary update { data: string } (base64 encoded)
 *  - "start-logs": Start log streaming { streamId, type, service? }
 *  - "stop-logs": Stop log streaming { streamId }
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
    type: "journalctl" | "service"
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


interface BinaryAckPayload {
    status: "skipped" | "updated" | "error"
    message: string
    currentChecksum?: string
    receivedChecksum?: string
}


interface DevServerOptions {
    port: number
    clientKey: string
    onClientConnected?: () => void
    onClientDisconnected?: () => void
    onBinaryRequested?: () => void
}


interface WebSocketData {
    authenticated: boolean
    clientKey: string
}


// -----------------------------------------
//  Dev Server Class
// -----------------------------------------

export class DevServer {

    private server: Server<WebSocketData> | null = null

    private client: ServerWebSocket<WebSocketData> | null = null

    private options: DevServerOptions

    private activeLogStreams = new Map<string, { type: string; service?: string }>()

    private currentBinary: Buffer | null = null

    private bonjour: Bonjour | null = null

    private bonjourService: Service | null = null


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

                // Handle WebSocket upgrade on /ws endpoint
                if (url.pathname === "/ws") {

                    const clientKey = req.headers.get("x-client-key") ?? ""

                    const success = server.upgrade(req, {
                        data: {
                            authenticated: false,
                            clientKey: clientKey
                        }
                    })

                    if (success) {
                        return undefined
                    }

                    return new Response("WebSocket upgrade failed", { status: 400 })

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

                    self.handleOpen(ws)

                },

                message(ws, message) {

                    self.handleMessage(ws, message)

                },

                close(ws, code, reason) {

                    self.handleClose(ws, code, reason)

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

            // Clear all active log streams
            this.activeLogStreams.clear()

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

        // Format and display the log line
        const timestamp = payload.timestamp ? chalk.dim(payload.timestamp) : ""

        const service = payload.service ? chalk.cyan(`[${payload.service}]`) : ""

        const streamId = chalk.magenta(`[${payload.streamId}]`)

        const line = payload.line

        // Print the log line to console
        console.log(`${timestamp} ${streamId} ${service} ${line}`)

    }


    private handleLogError(payload: LogErrorPayload): void {

        Logger.error(`Log stream error (${payload.streamId}): ${payload.error}`)

    }


    private handleBinaryAck(payload: BinaryAckPayload): void {

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
     * Use "journalctl" type for all system logs, or "service" type with a service name.
     *
     * @param streamId - Unique identifier for this log stream
     * @param type - Type of log stream: "journalctl" or "service"
     * @param service - Service name (required if type is "service")
     * @returns true if the event was sent successfully
     */
    public startLogStream(streamId: string, type: "journalctl" | "service", service?: string): boolean {

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
    public getPort(): number {

        return this.options.port

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
