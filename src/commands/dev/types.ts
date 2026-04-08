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

// Device Information
interface DeviceInfoInspectorPort { path: string, port: number }
interface DeviceInfoOutputInfo { name: string, label?: string }
interface ClientMessageDeviceInfo { type: "device-info", payload: { ip: string, inspectorPorts: DeviceInfoInspectorPort[], outputs?: DeviceInfoOutputInfo[], version?: string }}
interface ClientMessageDeviceInfoRequested { type: "device-info-requested" }

// Screen
interface ClientMessageScreenRequest { type: "screen-request", payload: { outputName: string, serverHostURL: string }}
interface ClientMessageScreenPicture { type: "screen-picture", payload: { outputName: string }}
interface ClientMessageScreenPictureReceived { type: "screen-picture-received", payload: { outputName: string, data: string, width: number, height: number }}

// Update (Future use)
type UpdateStatus = "pending" | "downloading" | "installing" | "completed" | "failed"

interface ClientMessageUpdate { type: "update", payload: { url: string} }
interface ClientMessageUpdateStatus { type: "update-status", payload: { status: UpdateStatus, message?: string }}
interface ClientMessageUpdateProgress { type: "update-progress", payload: { progress: number, status: UpdateStatus}}
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
    ClientMessageDeviceInfoRequested |
    ClientMessageScreenRequest |
    ClientMessageUpdate |
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
    ClientMessageDeviceInfo |
    ClientMessageUpdateCheckRequest |
    ClientMessageSSHOutput |
    ClientMessageSSHExitReceived |
    ClientMessageScreenPictureReceived


// ------------------
// Screen Websocket Server Messages
// -----------------
type ScreenMessageScreenFrame = ArrayBuffer
interface ScreenMessageScreenRegister { type: "screen-register", payload: { outputName: string }}
interface ScreenMessageKeyboardInput { type: "screen-keyboard-input", payload: { outputName: string, data: string }}
interface ScreenMessageMouseInput { type: "screen-mouse-input", payload: { outputName: string, data: string }}

export type ScreenMessageSendable = |
    ScreenMessageKeyboardInput |
    ScreenMessageMouseInput


export type ScreenMessageReceivable = |
    ScreenMessageScreenFrame |
    ScreenMessageScreenRegister
