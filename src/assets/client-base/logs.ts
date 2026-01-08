/***
 *
 *
 *  Strux Dev Client Log Streamer
 *
 */

import { Logger } from "./logger"

type LogStreamType = "journalctl" | "service"

interface LogStream {
    type: LogStreamType
    service?: string
    process: ReturnType<typeof Bun.spawn> | null
}

export class LogStreamerClass {

    private streams = new Map<string, LogStream>()

    /**
     * Starts streaming journalctl logs
     */
    async startJournalctlStream(streamId: string, onLog: (line: string) => void): Promise<void> {
        if (this.streams.has(streamId)) {
            Logger.warn("LogStreamer", `Stream ${streamId} already exists`)
            return
        }

        try {
            Logger.info("LogStreamer", `Starting journalctl stream: ${streamId}`)

            const process = Bun.spawn(["journalctl", "-f", "--no-pager", "-o", "short-precise"], {
                stdout: "pipe",
                stderr: "pipe",
            })

            const stream: LogStream = {
                type: "journalctl",
                process,
            }

            this.streams.set(streamId, stream)

            // Stream stdout
            const reader = process.stdout.getReader()
            const decoder = new TextDecoder()
            let buffer = ""

            const readChunk = async () => {
                try {
                    while (true) {
                        const { done, value } = await reader.read()
                        if (done) break

                        buffer += decoder.decode(value, { stream: true })
                        const lines = buffer.split("\n")
                        buffer = lines.pop() ?? ""

                        for (const line of lines) {
                            if (line.trim()) {
                                onLog(line)
                            }
                        }
                    }
                } catch (error) {
                    Logger.error("LogStreamer", "Error reading journalctl stream:", streamId, error)
                } finally {
                    this.stopStream(streamId)
                }
            }

            readChunk()

            // Handle stderr
            const stderrReader = process.stderr.getReader()
            const stderrDecoder = new TextDecoder()

            const readStderr = async () => {
                try {
                    while (true) {
                        const { done, value } = await stderrReader.read()
                        if (done) break

                        const error = stderrDecoder.decode(value)
                        Logger.warn("LogStreamer", "journalctl stderr:", error)
                    }
                } catch (error) {
                    Logger.error("LogStreamer", "Error reading journalctl stderr:", error)
                }
            }

            readStderr()

        } catch (error) {
            Logger.error("LogStreamer", "Failed to start journalctl stream:", error)
            throw error
        }
    }

    /**
     * Starts streaming logs for a specific systemd service
     */
    async startServiceStream(streamId: string, serviceName: string, onLog: (line: string) => void): Promise<void> {
        if (this.streams.has(streamId)) {
            Logger.warn("LogStreamer", `Stream ${streamId} already exists`)
            return
        }

        try {
            Logger.info("LogStreamer", `Starting service stream: ${streamId} for ${serviceName}`)

            const process = Bun.spawn(["journalctl", "-f", "--no-pager", "-u", serviceName, "-o", "short-precise"], {
                stdout: "pipe",
                stderr: "pipe",
            })

            const stream: LogStream = {
                type: "service",
                service: serviceName,
                process,
            }

            this.streams.set(streamId, stream)

            // Stream stdout (same pattern as journalctl)
            const reader = process.stdout.getReader()
            const decoder = new TextDecoder()
            let buffer = ""

            const readChunk = async () => {
                try {
                    while (true) {
                        const { done, value } = await reader.read()
                        if (done) break

                        buffer += decoder.decode(value, { stream: true })
                        const lines = buffer.split("\n")
                        buffer = lines.pop() ?? ""

                        for (const line of lines) {
                            if (line.trim()) {
                                onLog(line)
                            }
                        }
                    }
                } catch (error) {
                    Logger.error("LogStreamer", "Error reading service stream:", streamId, error)
                } finally {
                    this.stopStream(streamId)
                }
            }

            readChunk()

        } catch (error) {
            Logger.error("LogStreamer", "Failed to start service stream:", error)
            throw error
        }
    }

    /**
     * Stops a log stream
     */
    stopStream(streamId: string): void {
        const stream = this.streams.get(streamId)
        if (!stream) {
            Logger.warn("LogStreamer", "Stream not found:", streamId)
            return
        }

        Logger.info("LogStreamer", "Stopping stream:", streamId)

        if (stream.process) {
            try {
                stream.process.kill()
            } catch (error) {
                Logger.error("LogStreamer", "Error killing stream process:", error)
            }
        }

        this.streams.delete(streamId)
    }

    /**
     * Stops all streams
     */
    stopAllStreams(): void {
        Logger.info("LogStreamer", "Stopping all streams")
        for (const streamId of this.streams.keys()) {
            this.stopStream(streamId)
        }
    }

    /**
     * Gets list of active streams
     */
    getActiveStreams(): string[] {
        return Array.from(this.streams.keys())
    }

}

export const LogStreamer = new LogStreamerClass()

