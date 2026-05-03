/***
 *
 *
 * Update Handlers
 *
 *
 */
import { Logger } from "../../../utils/log"
import type { ClientMessageSendable, ClientMessageReceivable } from "../types"
import type { Socket } from "../socket-manager"


export function registerUpdateHandlers(client: Socket<ClientMessageSendable, ClientMessageReceivable>): void {


    client.on("update-check-request", (_payload, ws) => {

        // TODO: Check for available updates and respond
        Logger.info("Update check requested")

    })


}
