/***
 *
 *
 * Network Utilities
 *
 */
import { Socket } from "net"

export async function waitForPort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
    return await new Promise((resolve) => {
        const socket = new Socket()
        const timer = setTimeout(() => {
            socket.destroy()
            resolve(false)
        }, timeoutMs)

        socket.once("connect", () => {
            clearTimeout(timer)
            socket.destroy()
            resolve(true)
        })
        socket.once("error", () => {
            clearTimeout(timer)
            socket.destroy()
            resolve(false)
        })

        socket.connect(port, host)
    })
}