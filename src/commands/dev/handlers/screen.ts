/***
 *
 *
 * Screen Socket Handlers
 *
 *
 */
import { Logger } from "../../../utils/log"
import type { ScreenMessageSendable, ScreenMessageReceivable } from "../types"
import type { Socket } from "../socket-manager"


export function registerScreenHandlers(screen: Socket<ScreenMessageSendable, ScreenMessageReceivable>): void {


    screen.onConnect((_ws) => {
        Logger.info("Screen client connected")
    })

    screen.onDisconnect((_ws) => {
        Logger.info("Screen client disconnected")
    })


    // Binary frame relay from device to all viewers
    screen.onBinary((_data, _ws) => {
        // TODO: Broadcast frame to all connected screen viewers
    })


    // Screen registration
    screen.on("screen-register", (payload, _ws) => {
        Logger.info(`Screen registered: ${payload.outputName}`)
    })


}
