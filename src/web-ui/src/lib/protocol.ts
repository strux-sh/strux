/**
 * Dev-tool WebSocket protocol (browser <-> dev server, /devtool/ws).
 *
 * Mirrors the WebUIMessage* unions in the CLI (src/commands/dev/types.ts).
 * The dev server is the only hub — the browser never talks to the device
 * directly. Binary H.264 frames arrive out-of-band (see FrameHeader below).
 */

export interface OutputInfo {
  name: string
  label?: string
}

export type PointerAxis = "vertical" | "horizontal"

export type BuildState = "building" | "idle"

export interface DeviceStatus {
  connected: boolean
  ip?: string
  version?: string
  arch?: string
  bspName?: string
}

export interface LogLine {
  source: string
  line: string
  timestamp: string
}

// Browser -> server
export type DevtoolOutbound =
  | { type: "start-stream"; payload: { outputName: string } }
  | { type: "stop-stream"; payload: { outputName: string } }
  | { type: "screenshot"; payload: { outputName: string } }
  | { type: "input-pointer-motion"; payload: { outputName: string; x: number; y: number } }
  | { type: "input-pointer-button"; payload: { outputName: string; button: number; pressed: boolean } }
  | { type: "input-pointer-axis"; payload: { outputName: string; axis: PointerAxis; value: number } }
  | { type: "input-keyboard-key"; payload: { outputName: string; keycode: number; pressed: boolean } }
  | { type: "input-keyboard-modifiers"; payload: { outputName: string; depressed: number; latched: number; locked: number; group: number } }
  | { type: "device-reboot" }
  | { type: "device-restart-strux" }

// Server -> browser
export type DevtoolInbound =
  | { type: "outputs-available"; payload: { outputs: OutputInfo[] } }
  | { type: "screen-ready"; payload: { outputName: string; outputIndex: number; width: number; height: number; encoder: string; fps: number } }
  | { type: "screen-stopped"; payload: { outputName: string } }
  | { type: "screen-error"; payload: { outputName: string; error: string } }
  | { type: "screen-screenshot-result"; payload: { outputName: string; data: string; width: number; height: number } }
  | { type: "device-disconnected" }
  | { type: "device-status"; payload: DeviceStatus }
  | { type: "log-line"; payload: LogLine }
  | { type: "log-backlog"; payload: { lines: LogLine[] } }
  | { type: "build-status"; payload: { state: BuildState; label?: string } }

/**
 * Binary frame wire format (device -> server -> browser, relayed verbatim):
 *   [0]      uint8   output index
 *   [1..8]   uint64  timestamp (big-endian) — unused by the viewer
 *   [9]      uint8   keyframe flag           — unused by the viewer
 *   [10..]   bytes   raw H.264 (Annex-B)
 */
export const FRAME_HEADER_BYTES = 10

export interface ParsedFrame {
  outputIndex: number
  data: Uint8Array
}

export function parseFrame(buffer: ArrayBuffer): ParsedFrame | null {
    if (buffer.byteLength <= FRAME_HEADER_BYTES) return null
    const view = new DataView(buffer)
    return {
        outputIndex: view.getUint8(0),
        data: new Uint8Array(buffer, FRAME_HEADER_BYTES),
    }
}

// Linux evdev pointer button codes (input-event-codes.h).
export const BTN_LEFT = 0x110
export const BTN_RIGHT = 0x111
export const BTN_MIDDLE = 0x112

// Map a DOM MouseEvent.button to its evdev code.
export function evdevButton(domButton: number): number {
    switch (domButton) {
        case 0: return BTN_LEFT
        case 1: return BTN_MIDDLE
        case 2: return BTN_RIGHT
        default: return BTN_LEFT
    }
}
