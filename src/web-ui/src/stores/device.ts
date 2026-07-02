/**
 * Device store — the single source of truth for the dev-tool's connection to
 * the dev server, the device's outputs, and the per-output screen streams.
 *
 * Owns one DevtoolSocket. Binary frames are dispatched to a sink registered by
 * the view (which holds the <video>/jMuxer instances).
 */
import { defineStore } from "pinia"
import { ref, shallowReactive } from "vue"
import { DevtoolSocket, type ConnectionStatus } from "@/lib/socket"
import { parseFrame, type BuildState, type DeviceStatus, type DevtoolInbound, type DevtoolOutbound, type LogLine, type OutputInfo } from "@/lib/protocol"

export type StreamStatus = "starting" | "streaming" | "stopping" | "stopped" | "error"

export interface StreamState {
  outputName: string
  /**
   * The device's outputIndex for this session, reported in screen-ready and
   * matching the index byte in each binary frame header. -1 until ready.
   */
  index: number
  status: StreamStatus
  width: number
  height: number
  encoder: string
  fps: number
  error?: string
}

export interface ScreenshotResult {
  outputName: string
  data: string
  width: number
  height: number
}

export type FrameSink = (outputIndex: number, h264: Uint8Array) => void

export const useDeviceStore = defineStore("device", () => {
    const status = ref<ConnectionStatus>("connecting")
    const deviceConnected = ref(false)
    const outputs = ref<OutputInfo[]>([])
    const streams = shallowReactive<Record<string, StreamState>>({})
    const screenshot = ref<ScreenshotResult | null>(null)

    // Dashboard state
    const deviceStatus = ref<DeviceStatus>({ connected: false })
    const buildState = ref<{ state: BuildState; label?: string }>({ state: "idle" })
    const logs = ref<LogLine[]>([])
    const MAX_LOGS = 500

    let socket: DevtoolSocket | null = null
    let frameSink: FrameSink | null = null

    function init(): void {
        if (socket) return
        socket = new DevtoolSocket()
        socket.onStatus = (s) => { status.value = s }
        socket.onJson = handleJson
        socket.onBinary = (buf) => {
            const frame = parseFrame(buf)
            if (frame) frameSink?.(frame.outputIndex, frame.data)
        }
        socket.connect()
    }

    function handleJson(msg: DevtoolInbound): void {
        switch (msg.type) {
            case "outputs-available":
                deviceConnected.value = true
                outputs.value = msg.payload.outputs
                break

            case "screen-ready": {
                const p = msg.payload
                streams[p.outputName] = {
                    outputName: p.outputName,
                    index: p.outputIndex,
                    status: "streaming",
                    width: p.width,
                    height: p.height,
                    encoder: p.encoder,
                    fps: p.fps,
                }
                break
            }

            case "screen-stopped": {
                const stream = streams[msg.payload.outputName]
                if (stream && stream.status !== "starting") {
                    stream.status = "stopped"
                    stream.index = -1
                }
                break
            }

            case "screen-error": {
                const stream = streams[msg.payload.outputName]
                if (stream) {
                    stream.status = "error"
                    stream.error = msg.payload.error
                }
                break
            }

            case "screen-screenshot-result":
                screenshot.value = msg.payload
                break

            case "device-disconnected":
                deviceConnected.value = false
                deviceStatus.value = { ...deviceStatus.value, connected: false, ip: undefined, version: undefined }
                outputs.value = []
                for (const name of Object.keys(streams)) delete streams[name]
                break

            case "device-status":
                deviceStatus.value = msg.payload
                deviceConnected.value = msg.payload.connected
                break

            case "build-status":
                buildState.value = msg.payload
                break

            case "log-line":
                logs.value.push(msg.payload)
                if (logs.value.length > MAX_LOGS) logs.value.splice(0, logs.value.length - MAX_LOGS)
                break

            case "log-backlog":
                logs.value = msg.payload.lines.slice(-MAX_LOGS)
                break
        }
    }

    function startStream(outputName: string): void {
        // Always reset: a stale entry (stopped/error) must not carry its old
        // index or status into the new session.
        streams[outputName] = {
            outputName,
            index: -1,
            status: "starting",
            width: 0,
            height: 0,
            encoder: "",
            fps: 0,
        }
        send({ type: "start-stream", payload: { outputName } })
    }

    function stopStream(outputName: string): void {
        // Optimistically mark as stopping; the device's screen-stopped event
        // confirms the daemon actually exited.
        const stream = streams[outputName]
        if (stream) stream.status = "stopping"
        send({ type: "stop-stream", payload: { outputName } })
    }

    function takeScreenshot(outputName: string): void {
        send({ type: "screenshot", payload: { outputName } })
    }

    function clearScreenshot(): void {
        screenshot.value = null
    }

    function rebootDevice(): void {
        send({ type: "device-reboot" })
    }

    function restartStrux(): void {
        send({ type: "device-restart-strux" })
    }

    function send(msg: DevtoolOutbound): void {
        socket?.send(msg)
    }

    function setFrameSink(sink: FrameSink | null): void {
        frameSink = sink
    }

    return {
        status,
        deviceConnected,
        outputs,
        streams,
        screenshot,
        deviceStatus,
        buildState,
        logs,
        init,
        startStream,
        stopStream,
        takeScreenshot,
        clearScreenshot,
        rebootDevice,
        restartStrux,
        send,
        setFrameSink,
    }
})
