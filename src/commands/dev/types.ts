/****
 *
 *
 *  Dev Server Types
 *
 */


//------------------
// Client Websocket Server Messages
// -----------------

// Logging Messages
type LogLineType = "journalctl" | "service" | "app" | "cage" | "screen" | "early" | "client"
interface ClientMessageReceiveLog {type: "log-line", payload: { type: LogLineType, line: string, timestamp: string }}


// Binary Push
interface ClientMessageBinaryNew {type: "binary-new", payload: { data: string }}

// Sending Binary Acknowledgments
type BinaryAckStatus = "skipped" | "updated" | "error"
interface ClientMessageBinaryAck {type: "binary-ack", payload: { status: BinaryAckStatus, binary: string, currentChecksum?: string, receivedChecksum?: string}}
interface ClientMessageBinaryRequested {type: "binary-requested"}

// Components
interface ClientMessageComponent { type: "component", payload: { data: string, destPath: string }}
interface ClientMessageComponentAck { type: "component-ack", payload: { status: "updated" | "error", message: string, destPath: string }}
interface ClientMessageComponentArchive { type: "component-archive", payload: { data: string, extractPath: string }}
interface ClientMessageComponentArchiveAck { type: "component-archive-ack", payload: { status: "updated" | "error", message: string, extractPath: string }}

// Device Information
interface DeviceInfoInspectorPort { path: string, port: number }
export interface DeviceInfoOutputInfo { name: string, label?: string }
interface ClientMessageDeviceInfo { type: "device-info", payload: { ip: string, inspectorPorts: DeviceInfoInspectorPort[], outputs?: DeviceInfoOutputInfo[], version?: string }}
interface ClientMessageDeviceInfoRequested { type: "device-info-requested" }

// Screen
interface ClientMessageScreenRequest { type: "screen-request", payload: { outputName: string, serverHostURL: string }}
interface ClientMessageScreenStop { type: "screen-stop", payload: { outputName: string }}
interface ClientMessageScreenPicture { type: "screen-picture", payload: { outputName: string }}
interface ClientMessageScreenReady { type: "screen-ready", payload: { outputName: string, outputIndex: number, width: number, height: number, encoder: string, fps: number }}
interface ClientMessageScreenStopped { type: "screen-stopped", payload: { outputName: string }}
interface ClientMessageScreenError { type: "screen-error", payload: { outputName: string, error: string }}
interface ClientMessageScreenPictureReceived { type: "screen-picture-received", payload: { outputName: string, data: string, width: number, height: number }}

// Update
export type UpdateStatus = "pending" | "downloading" | "installing" | "completed" | "failed"

interface ClientMessageUpdate { type: "update", payload: { url: string} }
interface ClientMessageSystemUpdate { type: "system-update", payload: { url?: string, path?: string }}
interface ClientMessageSystemUpdateAck { type: "system-update-ack", payload: { status: "pending" | "error", message: string, slot?: string, version?: string }}
interface ClientMessageUpdateStatus { type: "update-status", payload: { status: UpdateStatus, message?: string }}
interface ClientMessageUpdateProgress { type: "update-progress", payload: { progress: number, status: UpdateStatus, message?: string, bytesWritten?: number, totalBytes?: number, slot?: string, version?: string }}
interface ClientMessageUpdateCheckRequest { type: "update-check-request" }
interface ClientMessageUpdateCheckResponse { type: "update-check-response", payload: { available: boolean, version: string, checksum: string }}

// SSH/TTY
interface ClientMessageSSHStart { type: "ssh-start", payload: { sessionID: string, shell: string, rows?: number, cols?: number }}
interface ClientMessageSSHResize { type: "ssh-resize", payload: { sessionID: string, rows: number, cols: number }}
interface ClientMessageSSHInput { type: "ssh-input", payload: { sessionID: string, data: string}}
interface ClientMessageSSHOutput { type: "ssh-output", payload: { sessionID: string, data: string}}
interface ClientMessageSSHExit { type: "ssh-exit", payload: { sessionID: string }}
interface ClientMessageSSHExitReceived { type: "ssh-exit-received", payload: { sessionID: string, code: number }}

// System Controls
interface ClientMessageSystemRestart { type: "system-restart" }
interface ClientMessageSystemRestartStrux { type: "system-restart-strux" }


export type ClientMessageSendable = |
    ClientMessageBinaryNew |
    ClientMessageBinaryAck |
    ClientMessageComponent |
    ClientMessageComponentArchive |
    ClientMessageDeviceInfoRequested |
    ClientMessageScreenRequest |
    ClientMessageScreenStop |
    ClientMessageUpdate |
    ClientMessageSystemUpdate |
    ClientMessageUpdateStatus |
    ClientMessageUpdateProgress |
    ClientMessageUpdateCheckResponse |
    ClientMessageSystemRestart |
    ClientMessageSystemRestartStrux |
    ClientMessageSSHStart |
    ClientMessageSSHResize |
    ClientMessageSSHInput |
    ClientMessageSSHExit |
    ClientMessageScreenPicture


export type ClientMessageReceivable = |
    ClientMessageReceiveLog |
    ClientMessageBinaryRequested |
    ClientMessageBinaryAck |
    ClientMessageComponentAck |
    ClientMessageComponentArchiveAck |
    ClientMessageDeviceInfo |
    ClientMessageSystemUpdateAck |
    ClientMessageUpdateProgress |
    ClientMessageUpdateCheckRequest |
    ClientMessageSSHOutput |
    ClientMessageSSHExitReceived |
    ClientMessageScreenReady |
    ClientMessageScreenStopped |
    ClientMessageScreenError |
    ClientMessageScreenPictureReceived


// ------------------
// Screen Websocket Server Messages  (device <-> dev server, /ws/screen)
//
// device -> server:  binary H.264 frames (ArrayBuffer)
// server -> device:  input-injection events (JSON), relayed from the web-ui.
//                    Lights up once the device-side wlr virtual-input client
//                    (Phase 2) parses them; harmless until then.
//
// Pointer coordinates are normalized 0..1 within the named output. Button
// codes are Linux evdev codes (BTN_LEFT=0x110, ...). Keyboard codes are evdev
// keycodes (evdev = xkb - 8). All events are keyed by outputName so each
// display gets its own virtual pointer/keyboard target.
// -----------------
type ScreenMessageScreenFrame = ArrayBuffer

interface ScreenMessageInputPointerMotion { type: "input-pointer-motion", payload: { outputName: string, x: number, y: number }}
interface ScreenMessageInputPointerButton { type: "input-pointer-button", payload: { outputName: string, button: number, pressed: boolean }}
interface ScreenMessageInputPointerAxis { type: "input-pointer-axis", payload: { outputName: string, axis: "vertical" | "horizontal", value: number }}
interface ScreenMessageInputKeyboardKey { type: "input-keyboard-key", payload: { outputName: string, keycode: number, pressed: boolean }}
interface ScreenMessageInputKeyboardModifiers { type: "input-keyboard-modifiers", payload: { outputName: string, depressed: number, latched: number, locked: number, group: number }}

export type ScreenInputMessage =
    ScreenMessageInputPointerMotion |
    ScreenMessageInputPointerButton |
    ScreenMessageInputPointerAxis |
    ScreenMessageInputKeyboardKey |
    ScreenMessageInputKeyboardModifiers

export type ScreenMessageSendable =
    ScreenInputMessage


export type ScreenMessageReceivable = |
    ScreenMessageScreenFrame


// ------------------
// Web UI Websocket Server Messages  (browser <-> dev server, /devtool/ws)
//
// The Vue dev tool connects here. The dev server is the only hub: it relays
// frames + device events down to the browser, and browser commands + input
// back up to the device. The browser never connects to the device directly.
//
// Binary H.264 frames are pushed to the browser out-of-band (broadcastBinary),
// so they are not part of the typed union below.
// -----------------

// Dashboard data shapes (server -> browser)
export type DevBuildState = "building" | "idle"
export interface DeviceStatus { connected: boolean, ip?: string, version?: string, arch?: string, bspName?: string }
export interface DashboardLogLine { source: string, line: string, timestamp: string }

// server -> browser
interface WebUIMessageOutputsAvailable { type: "outputs-available", payload: { outputs: DeviceInfoOutputInfo[] }}
interface WebUIMessageScreenReady { type: "screen-ready", payload: { outputName: string, outputIndex: number, width: number, height: number, encoder: string, fps: number }}
interface WebUIMessageScreenStopped { type: "screen-stopped", payload: { outputName: string }}
interface WebUIMessageScreenError { type: "screen-error", payload: { outputName: string, error: string }}
interface WebUIMessageScreenshotResult { type: "screen-screenshot-result", payload: { outputName: string, data: string, width: number, height: number }}
interface WebUIMessageDeviceDisconnected { type: "device-disconnected" }
interface WebUIMessageDeviceStatus { type: "device-status", payload: DeviceStatus }
interface WebUIMessageLogLine { type: "log-line", payload: DashboardLogLine }
interface WebUIMessageLogBacklog { type: "log-backlog", payload: { lines: DashboardLogLine[] }}
interface WebUIMessageBuildStatus { type: "build-status", payload: { state: DevBuildState, label?: string }}

// browser -> server
interface WebUIMessageStartStream { type: "start-stream", payload: { outputName: string }}
interface WebUIMessageStopStream { type: "stop-stream", payload: { outputName: string }}
interface WebUIMessageScreenshot { type: "screenshot", payload: { outputName: string }}
interface WebUIMessageDeviceReboot { type: "device-reboot" }
interface WebUIMessageDeviceRestartStrux { type: "device-restart-strux" }

export type WebUIMessageSendable = |
    WebUIMessageOutputsAvailable |
    WebUIMessageScreenReady |
    WebUIMessageScreenStopped |
    WebUIMessageScreenError |
    WebUIMessageScreenshotResult |
    WebUIMessageDeviceDisconnected |
    WebUIMessageDeviceStatus |
    WebUIMessageLogLine |
    WebUIMessageLogBacklog |
    WebUIMessageBuildStatus


export type WebUIMessageReceivable = |
    WebUIMessageStartStream |
    WebUIMessageStopStream |
    WebUIMessageScreenshot |
    WebUIMessageDeviceReboot |
    WebUIMessageDeviceRestartStrux |
    ScreenInputMessage
