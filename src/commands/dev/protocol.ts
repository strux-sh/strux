/***
 *
 *
 * Protocol Version Definitions
 *
 * Maps between canonical message names (v0.3.0) and wire names for each client version.
 * When a client connects, its version is read from the `v` query param.
 * Incoming messages are translated from wire → canonical before handlers see them.
 * Outgoing messages are translated from canonical → wire before sending.
 *
 * To add a new version:
 * 1. Add an entry to PROTOCOLS with send/receive/transformReceive/transformSend maps
 * 2. Only map names that differ from canonical — omitted names pass through unchanged
 *
 */


type PayloadTransform = (payload: any) => any

interface ProtocolMapping {
    // canonical → wire (for messages sent TO the client)
    send: Record<string, string>
    // wire → canonical (for messages received FROM the client)
    receive: Record<string, string>
    // Transform received payload from wire format to canonical format (keyed by canonical type)
    transformReceive: Record<string, PayloadTransform>
    // Transform sent payload from canonical format to wire format (keyed by canonical type)
    transformSend: Record<string, PayloadTransform>
}


const PROTOCOLS: Record<string, ProtocolMapping> = {

    // v0.2.0 — original message names and payload shapes
    "0.2.0": {

        send: {
            "binary-new":            "new-binary",
            "ssh-start":             "exec-start",
            "ssh-input":             "exec-input",
            "ssh-exit":              "exec-exit",
            "component":             "new-component",
            "device-info-requested": "get-device-info",
            "system-restart":        "reboot",
            "system-restart-strux":  "restart-service",
            "screen-request":        "screen-start",
            "screen-picture":        "screen-screenshot",
        },

        receive: {
            "request-binary":           "binary-requested",
            "exec-output":              "ssh-output",
            "exec-exit":                "ssh-exit-received",
            "exec-error":               "ssh-exit-received",
            "screen-screenshot-result": "screen-picture-received",
            "log-stream-error":         "log-line",
        },

        // v0.2.0 wire payload → canonical payload
        transformReceive: {

            // v0.2.0: { streamId, line, service?, timestamp }
            // canonical: { type, line, timestamp }
            "log-line": (p) => ({
                type: p.service ? "service" : "journalctl",
                line: p.line,
                timestamp: p.timestamp,
            }),

            // v0.2.0: { sessionId, stream, data }
            // canonical: { sessionID, data }
            "ssh-output": (p) => ({
                sessionID: p.sessionId ?? p.sessionID,
                data: p.data,
            }),

            // v0.2.0: { sessionId, code }
            // canonical: { sessionID, code }
            "ssh-exit-received": (p) => ({
                sessionID: p.sessionId ?? p.sessionID,
                code: p.code ?? 1,
            }),

            // v0.2.0: { status, message, currentChecksum, receivedChecksum }
            // canonical: { status, binary, currentChecksum?, receivedChecksum? }
            "binary-ack": (p) => ({
                status: p.status,
                binary: p.message ?? "",
                currentChecksum: p.currentChecksum,
                receivedChecksum: p.receivedChecksum,
            }),

            // v0.2.0: { componentType, status, message }
            // canonical: { status, message, destPath }
            "component-ack": (p) => ({
                status: p.status,
                message: p.message ?? "",
                destPath: p.message ?? p.componentType ?? "",
            }),

        },

        // canonical payload → v0.2.0 wire payload
        transformSend: {

            // canonical: { sessionID, shell }
            // v0.2.0: { sessionId, shell }
            "ssh-start": (p) => ({
                sessionId: p.sessionID,
                shell: p.shell,
            }),

            // canonical: { sessionID, data }
            // v0.2.0: { sessionId, data }
            "ssh-input": (p) => ({
                sessionId: p.sessionID,
                data: p.data,
            }),

            // canonical: { sessionID }
            // v0.2.0: { sessionId }
            "ssh-exit": (p) => ({
                sessionId: p.sessionID,
            }),

            // canonical: { data, destPath }
            // v0.2.0: { componentType, data, destPath }
            "component": (p) => ({
                componentType: "",
                data: p.data,
                destPath: p.destPath,
            }),

        },

    },

    // v0.3.0 — canonical names and payloads, no translation needed
    "0.3.0": {

        send: {},
        receive: {},
        transformReceive: {},
        transformSend: {},

    },

}


// The latest protocol version
export const LATEST_PROTOCOL_VERSION = "0.3.0"

// Fallback when no version is sent (legacy clients)
export const FALLBACK_PROTOCOL_VERSION = "0.2.0"


// Get the protocol mapping for a version, falls back to latest
export function getProtocol(version: string): ProtocolMapping {

    return PROTOCOLS[version]! ?? PROTOCOLS[LATEST_PROTOCOL_VERSION]

}


// Translate a canonical message type to wire type for sending to a client
export function toWireType(version: string, canonicalType: string): string {

    const protocol = getProtocol(version)
    return protocol.send[canonicalType] ?? canonicalType

}


// Translate a wire message type to canonical type for handler dispatch
export function toCanonicalType(version: string, wireType: string): string {

    const protocol = getProtocol(version)
    return protocol.receive[wireType] ?? wireType

}


// Transform a received payload from wire format to canonical format
export function transformReceivedPayload(version: string, canonicalType: string, payload: any): any {

    const protocol = getProtocol(version)
    const transform = protocol.transformReceive[canonicalType]
    return transform ? transform(payload) : payload

}


// Transform a sent payload from canonical format to wire format
export function transformSentPayload(version: string, canonicalType: string, payload: any): any {

    const protocol = getProtocol(version)
    const transform = protocol.transformSend[canonicalType]
    return transform ? transform(payload) : payload

}


// Check if a version is supported
export function isVersionSupported(version: string): boolean {

    return version in PROTOCOLS

}


// Get all supported versions
export function getSupportedVersions(): string[] {

    return Object.keys(PROTOCOLS)

}
