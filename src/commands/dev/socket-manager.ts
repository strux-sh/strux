/***
 *
 *
 * Socket Manager
 *
 *
 */
import type { ServerWebSocket } from "bun"
import { toCanonicalType, toWireType, transformReceivedPayload, transformSentPayload, FALLBACK_PROTOCOL_VERSION } from "./protocol"


// ----------------------
// Type Utilities
// ----------------------

type ExtractByType<TUnion, TType extends string> =
    TUnion extends { type: TType } ? TUnion : never

type PayloadOf<TUnion, TType extends string> =
    ExtractByType<TUnion, TType> extends { payload: infer P } ? P : never

type MessageTypes<TUnion> =
    TUnion extends { type: infer T extends string } ? T : never


// ----------------------
// WebSocket Data
// ----------------------

interface WebSocketData {
    socketName: string
    version: string
}


// ----------------------
// Socket
// ----------------------

type MessageHandler<TReceive, K extends string> = (payload: PayloadOf<TReceive, K>, ws: ServerWebSocket<WebSocketData>) => void
type BinaryHandler = (data: ArrayBuffer, ws: ServerWebSocket<WebSocketData>) => void
type ConnectionHandler = (ws: ServerWebSocket<WebSocketData>) => void

export class Socket<TSend, TReceive> {

    readonly name: string
    private handlers = new Map<string, MessageHandler<TReceive, any>>()
    private binaryHandler: BinaryHandler | null = null
    private connectHandler: ConnectionHandler | null = null
    private disconnectHandler: ConnectionHandler | null = null
    private clients = new Set<ServerWebSocket<WebSocketData>>()


    constructor(name: string) {

        this.name = name

    }


    // Register a typed message handler
    on<K extends MessageTypes<TReceive> & string>(type: K, handler: MessageHandler<TReceive, K>): void {

        this.handlers.set(type, handler)

    }


    // Register a binary message handler
    onBinary(handler: BinaryHandler): void {

        this.binaryHandler = handler

    }


    // Register connect/disconnect handlers
    onConnect(handler: ConnectionHandler): void {

        this.connectHandler = handler

    }

    onDisconnect(handler: ConnectionHandler): void {

        this.disconnectHandler = handler

    }


    // Send a typed message to a specific client
    send(ws: ServerWebSocket<WebSocketData>, message: TSend): void {

        const msg = message as any
        const wireType = toWireType(ws.data.version, msg.type)
        const wirePayload = transformSentPayload(ws.data.version, msg.type, msg.payload)
        ws.send(JSON.stringify({ type: wireType, payload: wirePayload }))

    }


    // Send raw binary data to a specific client
    sendBinary(ws: ServerWebSocket<WebSocketData>, data: ArrayBuffer | Uint8Array): void {

        ws.send(data)

    }


    // Broadcast a typed message to all connected clients
    broadcast(message: TSend): void {

        const msg = message as any

        this.clients.forEach((ws) => {

            const wireType = toWireType(ws.data.version, msg.type)
            const wirePayload = transformSentPayload(ws.data.version, msg.type, msg.payload)
            ws.send(JSON.stringify({ type: wireType, payload: wirePayload }))

        })

    }


    // Broadcast raw binary data to all connected clients
    broadcastBinary(data: ArrayBuffer | Uint8Array): void {

        this.clients.forEach((ws) => {

            ws.send(data)

        })

    }


    // Get all connected clients
    getClients(): Set<ServerWebSocket<WebSocketData>> {

        return this.clients

    }


    // Check if any clients are connected
    hasClients(): boolean {

        return this.clients.size > 0

    }


    // --- Internal methods used by SocketManager ---

    _addClient(ws: ServerWebSocket<WebSocketData>): void {

        this.clients.add(ws)
        this.connectHandler?.(ws)

    }

    _removeClient(ws: ServerWebSocket<WebSocketData>): void {

        this.clients.delete(ws)
        this.disconnectHandler?.(ws)

    }

    _handleMessage(ws: ServerWebSocket<WebSocketData>, raw: string | Buffer | ArrayBuffer): void {

        if (typeof raw !== "string") {

            const buffer = raw instanceof ArrayBuffer ? raw : raw.buffer as ArrayBuffer
            this.binaryHandler?.(buffer, ws)
            return

        }

        const message = JSON.parse(raw) as { type: string, payload?: unknown }
        const canonicalType = toCanonicalType(ws.data.version, message.type)
        const payload = transformReceivedPayload(ws.data.version, canonicalType, message.payload)
        const handler = this.handlers.get(canonicalType)
        handler?.(payload as any, ws)

    }

}


// ----------------------
// Socket Manager
// ----------------------

interface SocketConfig {
    path?: string
    port?: number
    auth?: boolean
    aliases?: string[]
}

export class SocketManager {

    private static instance: SocketManager
    private sockets = new Map<string, Socket<any, any>>()
    private configs = new Map<string, SocketConfig>()
    private sharedServer: ReturnType<typeof Bun.serve> | null = null
    private portServers = new Map<number, ReturnType<typeof Bun.serve>>()
    private authKey: string | null = null


    static getInstance(): SocketManager {

        if (!SocketManager.instance) {

            SocketManager.instance = new SocketManager()

        }

        return SocketManager.instance

    }


    // Check if a request is authenticated
    private isAuthenticated(req: Request): boolean {

        if (!this.authKey) return true

        const url = new URL(req.url)
        const keyFromParam = url.searchParams.get("key")

        if (keyFromParam === this.authKey) return true

        const authHeader = req.headers.get("authorization")

        if (authHeader === `Bearer ${this.authKey}`) return true

        // v0.2.0 legacy: X-Client-Key header
        const legacyKey = req.headers.get("x-client-key")

        if (legacyKey === this.authKey) return true

        return false

    }


    // Create a named socket with path or port routing
    create<TSend, TReceive>(name: string, config: SocketConfig): Socket<TSend, TReceive> {

        if (this.sockets.has(name)) {

            throw new Error(`Socket "${name}" already exists`)

        }

        const socket = new Socket<TSend, TReceive>(name)
        this.sockets.set(name, socket)
        this.configs.set(name, config)

        return socket

    }


    // Get an existing socket by name
    get<TSend = any, TReceive = any>(name: string): Socket<TSend, TReceive> {

        const socket = this.sockets.get(name)

        if (!socket) {

            throw new Error(`Socket "${name}" not found`)

        }

        return socket as Socket<TSend, TReceive>

    }


    // Start all servers
    listen(opts: { port: number, authKey?: string }): void {

        this.authKey = opts.authKey ?? null

        // Collect path-based sockets for the shared server
        const pathMap = new Map<string, Socket<any, any>>()
        const pathToName = new Map<string, string>()
        const authCheck = (req: Request, nameOrPath: string): Response | null => {
            const name = pathToName.get(nameOrPath) ?? nameOrPath
            const config = this.configs.get(name)
            if (config?.auth === false) return null
            if (!this.isAuthenticated(req)) return new Response("Unauthorized", { status: 401 })
            return null
        }

        this.configs.forEach((config, name) => {

            const socket = this.sockets.get(name)!

            if (config.port) {

                // Standalone port server
                const standaloneSocket = socket
                const server = Bun.serve<WebSocketData>({

                    port: config.port,

                    fetch(req, server) {

                        const rejected = authCheck(req, name)
                        if (rejected) return rejected

                        const url = new URL(req.url)
                        const version = url.searchParams.get("v") ?? FALLBACK_PROTOCOL_VERSION

                        const upgraded = server.upgrade(req, { data: { socketName: name, version } })
                        if (!upgraded) return new Response("WebSocket upgrade failed", { status: 400 })

                    },

                    websocket: {
                        open: (ws) => standaloneSocket._addClient(ws),
                        close: (ws) => standaloneSocket._removeClient(ws),
                        message: (ws, msg) => standaloneSocket._handleMessage(ws, msg),
                    }

                })

                this.portServers.set(config.port, server)

            } else if (config.path) {

                pathMap.set(config.path, socket)
                pathToName.set(config.path, name)

                // Register legacy path aliases
                if (config.aliases) {
                    for (const alias of config.aliases) {
                        pathMap.set(alias, socket)
                        pathToName.set(alias, name)
                    }
                }

            }

        })

        // Shared server for path-based sockets
        if (pathMap.size > 0) {

            this.sharedServer = Bun.serve<WebSocketData>({

                port: opts.port,

                fetch(req, server) {

                    const url = new URL(req.url)

                    if (!pathMap.has(url.pathname)) {
                        return new Response("Not found", { status: 404 })
                    }

                    const rejected = authCheck(req, url.pathname)
                    if (rejected) return rejected

                    const version = url.searchParams.get("v") ?? FALLBACK_PROTOCOL_VERSION

                    const upgraded = server.upgrade(req, { data: { socketName: url.pathname, version } })
                    if (!upgraded) return new Response("WebSocket upgrade failed", { status: 400 })

                },

                websocket: {

                    open(ws: ServerWebSocket<WebSocketData>) {
                        const socket = pathMap.get(ws.data.socketName)
                        socket?._addClient(ws)
                    },

                    close(ws: ServerWebSocket<WebSocketData>) {
                        const socket = pathMap.get(ws.data.socketName)
                        socket?._removeClient(ws)
                    },

                    message(ws: ServerWebSocket<WebSocketData>, msg) {
                        const socket = pathMap.get(ws.data.socketName)
                        socket?._handleMessage(ws, msg)
                    },

                }

            })

        }

    }


    // Stop all servers
    close(): void {

        this.sharedServer?.stop()
        this.sharedServer = null

        this.portServers.forEach((server) => {

            server.stop()

        })

        this.portServers.clear()
        this.sockets.clear()
        this.configs.clear()

    }

}
