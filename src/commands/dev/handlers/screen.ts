/***
 *
 *
 * Screen Socket Handlers  (device side of the relay, /ws/screen)
 *
 * The device dials out here and streams binary H.264 frames. We relay every
 * frame to all connected web-ui viewers. Input events travel the other way
 * (web-ui -> device) and are sent from the web-ui handler via screen.broadcast.
 *
 */
import { Logger } from "../../../utils/log"
import { DevServer } from "../index"
import type { ScreenMessageSendable, ScreenMessageReceivable, WebUIMessageSendable, WebUIMessageReceivable } from "../types"
import type { Socket } from "../socket-manager"


export function registerScreenHandlers(screen: Socket<ScreenMessageSendable, ScreenMessageReceivable>): void {

    const dev = DevServer.getInstance()


    screen.onConnect((_ws) => {
        Logger.info("Screen data channel connected")
    })

    screen.onDisconnect((_ws) => {
        Logger.info("Screen data channel disconnected")
    })


    // Binary H.264 frames from the device -> relay to all web-ui viewers.
    let frameCount = 0
    screen.onBinary((data, _ws) => {
        const webui = dev.sockets.get<WebUIMessageSendable, WebUIMessageReceivable>("webui")
        webui.broadcastBinary(data)
        frameCount++
        if (frameCount === 1 || frameCount % 120 === 0) {
            Logger.info(`Screen relay: ${frameCount} frames (last ${data.byteLength}B) -> ${webui.getClients().size} viewer(s)`)
        }
    })

}
