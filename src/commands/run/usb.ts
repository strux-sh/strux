/***
 *
 *
 *  Runner USB Redirect Component
 *
 */

import { normalizeUSBID } from "../../utils/hex"
import { Logger } from "../../utils/log"

interface USBRedirSession {
    port: number
    process: Bun.Subprocess
    key: string
    stdoutChunks: Uint8Array[]
    stderrChunks: Uint8Array[]
    exited: Promise<number | null>
    redirectBin: string
    redirectMode: "usbredir-host" | "usbredirect"
}

export class USBRedirectClass {

    sessions: USBRedirSession[] = []

    findUSBRedirectBinary(): { bin: string; mode: "usbredir-host" | "usbredirect" } | null {
        const candidates: { bin: string; mode: "usbredir-host" | "usbredirect" }[] = [
            { bin: "usbredir-host", mode: "usbredir-host" },
            { bin: "usbredirect", mode: "usbredirect" },
        ]

        for (const candidate of candidates) {
            try {
                const result = Bun.spawnSync(["which", candidate.bin], { stdout: "pipe", stderr: "pipe" })
                if (result.exitCode === 0) {
                    return candidate
                }
            } catch {
                continue
            }
        }

        return null
    }

    spawnUsbRedirSession(port: number, key: string, redirect: { bin: string; mode: "usbredir-host" | "usbredirect" }): USBRedirSession {
        // Connect as client to QEMU server (QEMU listens, usbredirect connects)
        // Bind explicitly to IPv4 loopback to avoid ::1/localhost resolution mismatches
        const args = redirect.mode === "usbredir-host"
            ? ["--device", key, "--tcp", `127.0.0.1:${port}`]
            : ["--device", key, "--to", `127.0.0.1:${port}`]

        const stdoutChunks: Uint8Array[] = []
        const stderrChunks: Uint8Array[] = []
        const proc = Bun.spawn([redirect.bin, ...args], {
            stdout: "pipe",
            stderr: "pipe",
        })

        // Capture stdout and stderr asynchronously
        if (proc.stdout) {
            (async () => {
                for await (const chunk of proc.stdout) {
                    stdoutChunks.push(chunk)
                }
            })().catch(() => {
                // Ignore stream errors
            })
        }

        if (proc.stderr) {
            (async () => {
                for await (const chunk of proc.stderr) {
                    stderrChunks.push(chunk)
                    // Forward all errors to stderr for debugging
                    process.stderr.write(chunk)
                }
            })().catch(() => {
                // Ignore stream errors
            })
        }

        const exited = proc.exited.then((code) => code)

        return {
            port,
            process: proc,
            key,
            stdoutChunks,
            stderrChunks,
            exited,
            redirectBin: redirect.bin,
            redirectMode: redirect.mode,
        }
    }

    createUSBRedirSessionPorts(usbDevices: { vendor_id: string; product_id: string }[]): { port: number; key: string; vendor: string; product: string }[] {
        return usbDevices.map((usb, index) => {
            const port = 43000 + index
            const vendor = normalizeUSBID(usb.vendor_id)
            const product = normalizeUSBID(usb.product_id)
            const key = `${vendor.primary}:${product.primary}`
            return { port, key, vendor: usb.vendor_id, product: usb.product_id }
        })
    }

    async start(sessionConfigs: { port: number; key: string; vendor: string; product: string }[]) {
        const redirect = this.findUSBRedirectBinary()
        if (!redirect && process.platform === "darwin") Logger.errorWithExit("usbredir tool not found. Please install it using 'brew install usbredir'")


        sessionConfigs.forEach(config => {
            this.sessions.push(this.spawnUsbRedirSession(config.port, config.key, redirect!))
        })

        return this.sessions
    }

    qemuSupportsUSBRedir(qemuBin: string): boolean {
        try {
            const helpResult = Bun.spawnSync([qemuBin, "-device", "help"], { stdout: "pipe", stderr: "pipe" })
            if ((helpResult.exitCode ?? 1) === 0) {
                const output = new TextDecoder().decode(helpResult.stdout ?? new Uint8Array())
                if (output.includes("usb-redir")) {
                    return true
                }
            }

            const probe = Bun.spawnSync([qemuBin, "-device", "usb-redir,help"], { stdout: "pipe", stderr: "pipe" })
            return (probe.exitCode ?? 1) === 0
        } catch {
            return false
        }
    }

    async stop() {
        for (const session of this.sessions) {
            try {
                session.process.kill()
            } catch {
                // Ignore errors
            }
        }
    }

}

export const USBRedirect = new USBRedirectClass()