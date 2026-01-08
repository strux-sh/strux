/***
 *
 *
 *  Strux Dev Client Socket Service
 *
 */

import { io, Socket } from "socket.io-client"
import type { HostsServiceClass } from "./hosts"
import type { DevClientConfig } from "./config"
import { BinaryHandler } from "./binary"
import { Logger } from "./logger"
import { LogStreamer } from "./logs"

export class SocketServiceClass {

    private instance: Socket | null = null
    private config: DevClientConfig | null = null
    private connectedHost: { host: string, port: number } | null = null
    private reconnectAttempts = 0
    private maxReconnectAttempts = 5
    private reconnectDelay = 1000 // Start with 1 second

    constructor() {
        // Instance will be created when attempting connection
    }

    /**
     * Attempts to connect to discovered hosts sequentially
     * Tries each host until one succeeds or all fail
     */
    async attemptConnection(hostsService: HostsServiceClass, config: DevClientConfig): Promise<boolean> {
        this.config = config

        const hosts = hostsService.services

        if (hosts.length === 0) {
            Logger.error("SocketService", "No hosts available to connect to")
            return false
        }

        Logger.info("SocketService", `Attempting to connect to ${hosts.length} host(s)...`)

        // Try each host sequentially
        for (const hostInfo of hosts) {
            const success = await this.tryConnect(hostInfo)
            if (success) {
                this.connectedHost = hostInfo
                this.setupEventHandlers()
                Logger.info("SocketService", `Successfully connected to ${hostInfo.host}:${hostInfo.port}`)
                return true
            }
        }

        Logger.error("SocketService", "Failed to connect to any host")
        return false
    }

    getConnectedHost(): { host: string, port: number } | null {
        return this.connectedHost
    }

    /**
     * Attempts to connect to a specific host with timeout
     */
    private async tryConnect(hostInfo: { host: string, port: number }): Promise<boolean> {
        return new Promise((resolve) => {
            const url = `http://${hostInfo.host}:${hostInfo.port}`
            Logger.info("SocketService", `Trying to connect to ${url}...`)

            const socket = io(url, {
                timeout: 5000,
                reconnection: false, // We'll handle reconnection manually
                transports: ["websocket", "polling"],
                auth: {
                    clientKey: this.config?.clientKey ?? "",
                },
            })

            // Set a timeout for the connection attempt
            const timeout = setTimeout(() => {
                socket.disconnect()
                socket.removeAllListeners()
                Logger.warn("SocketService", `Connection timeout for ${url}`)
                resolve(false)
            }, 5000)

            socket.on("connect", () => {
                clearTimeout(timeout)
                this.instance = socket
                resolve(true)
            })

            socket.on("connect_error", (error) => {
                clearTimeout(timeout)
                Logger.warn("SocketService", `Connection error for ${url}: ${error.message}`)
                socket.disconnect()
                socket.removeAllListeners()
                resolve(false)
            })
        })
    }

    /**
     * Sets up event handlers for the connected socket
     */
    private setupEventHandlers(): void {
        if (!this.instance) return

        this.instance.on("connect", async () => {
            Logger.info("SocketService", "Socket connected")
            this.reconnectAttempts = 0
            this.reconnectDelay = 1000 // Reset delay

            // Request binary on connection to check if update is needed
            await this.requestBinary()
        })

        this.instance.on("disconnect", (reason) => {
            Logger.warn("SocketService", `Socket disconnected: ${reason}`)
            LogStreamer.stopAllStreams()
            this.instance = null

            // Attempt reconnection if we have a connected host
            if (this.connectedHost && this.reconnectAttempts < this.maxReconnectAttempts) {
                this.scheduleReconnect()
            }
        })

        this.instance.on("error", (error) => {
            Logger.error("SocketService", "Socket error:", error)
        })

        this.instance.on("new-binary", async (payload: { data: Buffer }) => {
            await BinaryHandler.handleBinaryUpdate(payload.data)
        })

        this.instance.on("start-logs", async (payload: { streamId: string, type: "journalctl" | "service", service?: string }) => {
            try {
                if (payload.type === "journalctl") {
                    await LogStreamer.startJournalctlStream(payload.streamId, (line) => {
                        this.instance?.emit("log-line", {
                            streamId: payload.streamId,
                            line,
                            timestamp: new Date().toISOString(),
                        })
                    })
                } else if (payload.type === "service" && payload.service) {
                    await LogStreamer.startServiceStream(payload.streamId, payload.service, (line) => {
                        this.instance?.emit("log-line", {
                            streamId: payload.streamId,
                            line,
                            service: payload.service,
                            timestamp: new Date().toISOString(),
                        })
                    })
                }
            } catch (error) {
                Logger.error("SocketService", "Error starting log stream:", error)
                this.instance?.emit("log-stream-error", {
                    streamId: payload.streamId,
                    error: error instanceof Error ? error.message : String(error),
                })
            }
        })

        this.instance.on("stop-logs", (payload: { streamId: string }) => {
            LogStreamer.stopStream(payload.streamId)
        })
    }

    /**
     * Requests the binary from the server and updates if needed
     */
    private async requestBinary(): Promise<void> {
        if (!this.instance || !this.isConnected()) {
            Logger.error("SocketService", "Cannot request binary: not connected")
            return
        }

        try {
            const currentChecksum = await BinaryHandler.getCurrentBinaryChecksum()
            Logger.info("SocketService", `Current binary checksum: ${currentChecksum ?? "none"}`)

            this.instance.timeout(30000).emit("request-binary", (err: Error | null, response: { data: Buffer } | null) => {
                if (err) {
                    Logger.error("SocketService", `Error requesting binary: ${err.message}`)
                    return
                }

                if (!response?.data) {
                    Logger.error("SocketService", "Invalid response from server: missing data")
                    return
                }

                Logger.info("SocketService", "Received binary from server")
                BinaryHandler.handleBinaryUpdate(Buffer.from(response.data))
            })
        } catch (error) {
            Logger.error("SocketService", "Error in requestBinary:", error)
        }
    }

    /**
     * Schedules a reconnection attempt with exponential backoff
     */
    private scheduleReconnect(): void {
        this.reconnectAttempts++
        const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000)

        Logger.info("SocketService", `Scheduling reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`)

        setTimeout(async () => {
            if (!this.connectedHost || !this.config) return

            Logger.info("SocketService", `Attempting reconnection to ${this.connectedHost.host}:${this.connectedHost.port}`)
            const success = await this.tryConnect(this.connectedHost)

            if (success) {
                this.setupEventHandlers()
            } else if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.scheduleReconnect()
            } else {
                Logger.error("SocketService", "Max reconnection attempts reached")
            }
        }, delay)
    }

    /**
     * Disconnects the socket
     */
    disconnect(): void {
        LogStreamer.stopAllStreams()
        if (this.instance) {
            this.instance.disconnect()
            this.instance = null
        }
        this.connectedHost = null
        this.reconnectAttempts = 0
    }

    /**
     * Gets the current socket instance
     */
    getSocket(): Socket | null {
        return this.instance
    }

    /**
     * Checks if currently connected
     */
    isConnected(): boolean {
        return this.instance?.connected ?? false
    }

}

export const SocketService = new SocketServiceClass()
