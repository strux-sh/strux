/***
 *
 *
 * mDNS Discovery
 *
 *
 */
import { Logger } from "../../utils/log"


export class MDNSPublisher {

    private bonjour: any = null
    private service: any = null


    async start(port: number): Promise<void> {

        const { Bonjour } = await import("bonjour-service")

        this.bonjour = new Bonjour()

        this.service = this.bonjour.publish({
            name: "Strux Dev Server",
            type: "strux-dev",
            protocol: "tcp",
            port,
            txt: { version: "1.0" },
        })

        Logger.info(`mDNS published: _strux-dev._tcp on port ${port}`)

    }


    stop(): void {

        this.service?.stop?.()
        this.bonjour?.destroy?.()
        this.service = null
        this.bonjour = null

    }

}
