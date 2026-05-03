/***
 *
 *
 * QEMU Manager
 *
 *
 */
import { Logger } from "../../utils/log"
import { run as runQEMU } from "../run"
import type { Subprocess } from "bun"


export class QEMUManager {

    private process: Subprocess | null = null

    onOutput: ((line: string) => void) | null = null


    async start(): Promise<void> {

        Logger.info("Starting QEMU...")

        const proc = await runQEMU({
            devMode: true,
            returnProcess: true,
            stdio: ["inherit", "pipe", "pipe"],
        })

        this.process = proc as Subprocess

        // Stream stdout/stderr
        this.streamOutput()

    }


    stop(): void {

        if (this.process) {

            this.process.kill()
            this.process = null
            Logger.info("QEMU stopped")

        }

    }


    restart(): void {

        this.stop()
        this.start()

    }


    private emit(line: string): void {

        if (this.onOutput) {
            this.onOutput(line)
        } else {
            Logger.info(`[qemu] ${line}`)
        }

    }


    private streamOutput(): void {

        if (!this.process) return

        for (const stream of [this.process.stdout, this.process.stderr]) {

            if (!stream || typeof stream === "number") continue

            const reader = (stream as ReadableStream<Uint8Array>).getReader()
            const decoder = new TextDecoder()
            let buffer = ""

            const read = async () => {

                while (true) {

                    const { done, value } = await reader.read()
                    if (done) break

                    buffer += decoder.decode(value, { stream: true })
                    const lines = buffer.split("\n")
                    buffer = lines.pop() ?? ""

                    for (const line of lines) {

                        if (line.trim()) this.emit(line)

                    }

                }

                if (buffer.trim()) this.emit(buffer)

            }

            read()

        }

    }

}
