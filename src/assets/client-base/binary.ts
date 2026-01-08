/***
 *
 *
 *  Strux Dev Client Binary Handler
 *
 */

import { createHash } from "crypto"
import { Logger } from "./logger"

export class BinaryHandlerClass {

    private readonly binaryPath = "/strux/main"

    /**
     * Calculates SHA-256 checksum of a buffer
     */
    calculateChecksum(buffer: Buffer): string {
        const hash = createHash("sha256")
        hash.update(buffer)
        return hash.digest("hex")
    }

    /**
     * Gets the checksum of the current binary at /strux/main
     */
    async getCurrentBinaryChecksum(): Promise<string | null> {
        try {
            const file = Bun.file(this.binaryPath)
            if (!await file.exists()) {
                Logger.info("BinaryHandler", `No existing binary at ${this.binaryPath}`)
                return null
            }

            const buffer = await file.arrayBuffer()
            return this.calculateChecksum(Buffer.from(buffer))
        } catch (error) {
            Logger.error("BinaryHandler", "Error reading current binary:", error)
            return null
        }
    }

    /**
     * Handles binary update with checksum verification
     */
    async handleBinaryUpdate(binaryData: Buffer): Promise<void> {
        try {
            Logger.info("BinaryHandler", "Received binary update")

            // Calculate checksum of received binary
            const receivedChecksum = this.calculateChecksum(binaryData)
            Logger.info("BinaryHandler", `Received binary checksum: ${receivedChecksum}`)

            // Check if binary is different from current
            const currentChecksum = await this.getCurrentBinaryChecksum()
            if (currentChecksum === receivedChecksum) {
                Logger.info("BinaryHandler", "Binary is identical to current version, skipping update")
                return
            }

            // Write the binary to /strux/main
            Logger.info("BinaryHandler", `Writing binary to ${this.binaryPath}...`)
            await Bun.write(this.binaryPath, binaryData)

            // Verify the written file
            const writtenChecksum = await this.getCurrentBinaryChecksum()
            if (writtenChecksum !== receivedChecksum) {
                Logger.error("BinaryHandler", `Written file checksum mismatch! Expected: ${receivedChecksum}, Got: ${writtenChecksum}`)
                return
            }

            Logger.info("BinaryHandler", "Binary updated successfully, rebooting system...")

            // Reboot the system
            await this.reboot()
        } catch (error) {
            Logger.error("BinaryHandler", "Error handling binary update:", error)
        }
    }

    /**
     * Reboots the system
     */
    private async reboot(): Promise<void> {
        try {
            Logger.info("BinaryHandler", "Initiating system reboot...")

            // Use systemctl reboot if available, otherwise fall back to reboot command
            const rebootProcess = Bun.spawn(["systemctl", "reboot"], {
                stdout: "inherit",
                stderr: "inherit",
            })

            // If systemctl fails, try reboot command
            await rebootProcess.exited
            if (rebootProcess.exitCode !== 0) {
                Logger.warn("BinaryHandler", "systemctl reboot failed, trying reboot command...")
                const rebootCmd = Bun.spawn(["reboot"], {
                    stdout: "inherit",
                    stderr: "inherit",
                })
                await rebootCmd.exited
            }
        } catch (error) {
            Logger.error("BinaryHandler", "Error rebooting system:", error)
            // Try one more time with reboot command directly
            try {
                Bun.spawn(["reboot"], {
                    stdout: "inherit",
                    stderr: "inherit",
                })
            } catch (rebootError) {
                Logger.error("BinaryHandler", "Failed to reboot:", rebootError)
            }
        }
    }

}

export const BinaryHandler = new BinaryHandlerClass()
