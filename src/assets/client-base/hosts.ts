/**
 *
 *
 *  Strux Hosts Discovery Service
 *
 */
import { Bonjour } from "bonjour-service"
import type { DevClientConfig } from "./config"
import { Logger } from "./logger"

export class HostsServiceClass {


    private instance: Bonjour

    services: { host: string, port: number }[] = []


    constructor() {

        this.instance = new Bonjour()

    }

    async discover(devEnv: DevClientConfig) {

        // To satisfy type checker, if the devenv is not found it won't work anyway
        if (!devEnv) return

        Logger.info("HostsService", "Starting host discovery...")

        // Add Fallback Hosts
        if (devEnv.fallbackHosts.length > 0) {
            Logger.info("HostsService", `Adding ${devEnv.fallbackHosts.length} fallback host(s)`)
            devEnv.fallbackHosts.forEach(host => {
                this.services.push({ host: host.host, port: host.port })
                Logger.debug("HostsService", `Added fallback host: ${host.host}:${host.port}`)
            })
        }

        if (!devEnv.useMDNS) {
            Logger.info("HostsService", "mDNS discovery disabled, using fallback hosts only")
            Logger.info("HostsService", `Discovery complete: ${this.services.length} host(s) found`)
            return
        }

        Logger.info("HostsService", "Starting mDNS discovery for 'strux-dev' service...")
        this.instance.find({ type: "strux-dev" }, service => {
            this.services.push({ host: service.host, port: service.port })
            Logger.info("HostsService", `Found mDNS service: ${service.host}:${service.port}`)
        })

        // Wait 5 seconds for mDNS discovery to find services
        Logger.info("HostsService", "Waiting 5 seconds for mDNS discovery...")
        await Bun.sleep(5000)

        Logger.info("HostsService", `Discovery complete: ${this.services.length} host(s) found`)

    }


}

export const HostsService = new HostsServiceClass()