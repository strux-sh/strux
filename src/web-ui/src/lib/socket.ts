/**
 * DevtoolSocket — thin WebSocket client for /devtool/ws.
 *
 * Connects with ?v=0.3.0 so the dev server's protocol layer leaves our
 * messages untranslated. Auto-reconnects. JSON control messages and binary
 * H.264 frames are surfaced via separate callbacks.
 */
import type { DevtoolInbound, DevtoolOutbound } from "./protocol"

export type ConnectionStatus = "connecting" | "connected" | "disconnected"

export class DevtoolSocket {
    private ws: WebSocket | null = null
    private readonly url: string
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null
    private closed = false

    onJson: ((msg: DevtoolInbound) => void) | null = null
    onBinary: ((buffer: ArrayBuffer) => void) | null = null
    onStatus: ((status: ConnectionStatus) => void) | null = null

    constructor(path = "/devtool/ws") {
        const proto = location.protocol === "https:" ? "wss:" : "ws:"
        this.url = `${proto}//${location.host}${path}?v=0.3.0`
    }

    connect(): void {
        this.closed = false
        this.onStatus?.("connecting")

        const ws = new WebSocket(this.url)
        ws.binaryType = "arraybuffer"
        this.ws = ws

        ws.onopen = () => this.onStatus?.("connected")

        ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                this.onBinary?.(event.data)
                return
            }
            try {
                this.onJson?.(JSON.parse(event.data as string) as DevtoolInbound)
            } catch (err) {
                console.error("devtool: bad json message", err)
            }
        }

        ws.onclose = () => {
            this.ws = null
            this.onStatus?.("disconnected")
            if (!this.closed) this.scheduleReconnect()
        }

        ws.onerror = () => ws.close()
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            this.connect()
        }, 1500)
    }

    send(msg: DevtoolOutbound): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg))
        }
    }

    close(): void {
        this.closed = true
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
        this.ws?.close()
        this.ws = null
    }
}
