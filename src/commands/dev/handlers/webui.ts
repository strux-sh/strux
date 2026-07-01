/***
 *
 *
 * Web UI Socket Handlers  (browser side of the relay, /devtool/ws)
 *
 * The Vue dev tool connects here. This handler is the browser-facing half of
 * the screen relay: it turns viewer commands into device commands (over the
 * client socket) and forwards viewer input to the device (over the screen
 * socket). Device -> browser events are pushed from the client/screen handlers.
 *
 * The browser never talks to the device directly — everything is relayed
 * through the dev server.
 *
 */
import { Logger } from "../../../utils/log"
import { DevServer } from "../index"
import type {
    WebUIMessageSendable,
    WebUIMessageReceivable,
    ClientMessageSendable,
    ClientMessageReceivable,
    ScreenMessageSendable,
    ScreenMessageReceivable,
    ScreenInputMessage,
} from "../types"
import type { Socket } from "../socket-manager"


export function registerWebUIHandlers(webui: Socket<WebUIMessageSendable, WebUIMessageReceivable>): void {

    const dev = DevServer.getInstance()

    const client = () => dev.sockets.get<ClientMessageSendable, ClientMessageReceivable>("client")
    const screen = () => dev.sockets.get<ScreenMessageSendable, ScreenMessageReceivable>("screen")


    webui.onConnect((ws) => {
        Logger.info(`Web UI viewer connected (${webui.getClients().size} total)`)

        // Snapshot the current dashboard state for the freshly-joined viewer.
        webui.send(ws, { type: "device-status", payload: dev.deviceStatus })
        webui.send(ws, { type: "build-status", payload: dev.buildState })
        if (dev.dashboardLogs.length > 0) {
            webui.send(ws, { type: "log-backlog", payload: { lines: dev.dashboardLogs } })
        }

        // Send whatever outputs we already know about, then ask the device for
        // a fresh list so a late-joining viewer is never stuck on an empty picker.
        if (dev.deviceOutputs.length > 0) {
            webui.send(ws, { type: "outputs-available", payload: { outputs: dev.deviceOutputs } })
        }
        if (client().hasClients()) {
            client().broadcast({ type: "device-info-requested" })
        } else {
            webui.send(ws, { type: "device-disconnected" })
        }
    })

    webui.onDisconnect((_ws) => {
        Logger.info(`Web UI viewer disconnected (${webui.getClients().size} remaining)`)
    })


    // --- Viewer commands -> device (over the client control socket) ---

    webui.on("start-stream", (payload, _ws) => {
        if (!client().hasClients()) return
        // serverHostURL is unused by the current device (it reuses the host it
        // dialed in on); kept for protocol compatibility.
        client().broadcast({ type: "screen-request", payload: { outputName: payload.outputName, serverHostURL: "" } })
    })

    webui.on("stop-stream", (payload, _ws) => {
        if (!client().hasClients()) return
        client().broadcast({ type: "screen-stop", payload: { outputName: payload.outputName } })
    })

    webui.on("screenshot", (payload, _ws) => {
        if (!client().hasClients()) return
        client().broadcast({ type: "screen-picture", payload: { outputName: payload.outputName } })
    })


    // --- Viewer input -> device (over the screen socket, server->device) ---
    // Same payload shapes flow straight through; the device-side injector
    // (Phase 2) interprets them. No-op while the screen channel is idle.

    const forwardInput = (msg: ScreenInputMessage) => {
        if (!screen().hasClients()) return
        screen().broadcast(msg)
    }

    webui.on("input-pointer-motion", (payload, _ws) => forwardInput({ type: "input-pointer-motion", payload }))
    webui.on("input-pointer-button", (payload, _ws) => forwardInput({ type: "input-pointer-button", payload }))
    webui.on("input-pointer-axis", (payload, _ws) => forwardInput({ type: "input-pointer-axis", payload }))
    webui.on("input-keyboard-key", (payload, _ws) => forwardInput({ type: "input-keyboard-key", payload }))
    webui.on("input-keyboard-modifiers", (payload, _ws) => forwardInput({ type: "input-keyboard-modifiers", payload }))


    // --- Device control -> device (over the client control socket) ---

    webui.on("device-reboot", (_payload, _ws) => {
        if (!client().hasClients()) return
        Logger.info("Web UI requested device reboot")
        client().broadcast({ type: "system-restart" })
    })

    webui.on("device-restart-strux", (_payload, _ws) => {
        if (!client().hasClients()) return
        Logger.info("Web UI requested strux service restart")
        client().broadcast({ type: "system-restart-strux" })
    })

}
