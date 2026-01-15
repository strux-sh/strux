/***
 *
 *
 *  Run Tool - QEMU Emulator
 *
 */


import { Settings } from "../../settings"
import { Logger } from "../../utils/log"
import { stat, readdir } from "fs/promises"
import { join } from "path"
import { fileExists } from "../../utils/path"
import { MainYAMLValidator } from "../../types/main-yaml"
import { BSPYamlValidator } from "../../types/bsp-yaml"
import { USBRedirect } from "./usb"
import { waitForPort } from "../../utils/network"

const decoder = new TextDecoder()

export async function run() {

    // Validate the Strux YAML
    MainYAMLValidator.validateAndLoad()

    // Validate the BSP YAML, This auto selects the QEMU BSP
    BSPYamlValidator.validateAndLoad()

    await verifyArtifactsExist()

    let qemuBin: string | null = null
    const baseQemuArgs: string[] = []
    let machineType = ""
    const consoleArgs: string[] = []
    let displayOpt = ""
    const displayArgs: string[] = []
    let gpuDevice = ""
    const accelArgs: string[] = []

    if (Settings.targetArch === "x86_64") { qemuBin = "qemu-system-x86_64"; machineType = "q35" }
    if (Settings.targetArch === "arm64") { qemuBin = "qemu-system-aarch64"; machineType = "virt" }
    if (Settings.targetArch === "armhf") { qemuBin = "qemu-system-arm"; machineType = "virt" }


    if (!qemuBin) Logger.errorWithExit("Unsupported architecture. Please use a supported architecture.")

    if (Settings.targetArch === "x86_64") consoleArgs.push("root=/dev/vda", "rw", ...(Settings.qemuSystemDebug ? ["console=tty1", "console=ttyS0"] : ["quiet", "splash", "loglevel=0", "logo.nologo", "vt.handoff=7", "rd.plymouth.show-delay=0", "plymouth.ignore-serial-consoles", "systemd.show_status=false", "console=tty1", "console=ttyS0"]), "fbcon=map:0", "vt.global_cursor_default=0", `video=Virtual-1:${Settings.bsp!.display!.height}x${Settings.bsp!.display!.width}@60`)
    if (Settings.targetArch === "arm64") consoleArgs.push("root=/dev/vda", "rw", ...(Settings.qemuSystemDebug ? ["console=ttyAMA0", "console=ttyS0"] : ["quiet", "splash", "loglevel=0", "logo.nologo", "vt.handoff=7", "rd.plymouth.show-delay=0", "plymouth.ignore-serial-consoles", "systemd.show_status=false", "console=tty1", "console=ttyAMA0"]), "fbcon=map:0", "vt.global_cursor_default=0", `video=${Settings.bsp!.display!.height}x${Settings.bsp!.display!.width}`)
    if (Settings.targetArch === "armhf") consoleArgs.push("root=/dev/vda", "rw", ...(Settings.qemuSystemDebug ? ["console=ttyAMA0", "console=ttyS0"] : ["quiet", "splash", "loglevel=0", "logo.nologo", "vt.handoff=7", "rd.plymouth.show-delay=0", "plymouth.ignore-serial-consoles", "systemd.show_status=false", "console=tty1", "console=ttyAMA0"]), "fbcon=map:0", "vt.global_cursor_default=0", `video=${Settings.bsp!.display!.height}x${Settings.bsp!.display!.width}`)


    if (Settings.targetArch === "x86_64" && process.platform === "darwin") {
        displayOpt = "cocoa"
        gpuDevice = `virtio-gpu-pci,xres=${Settings.bsp!.display!.width},yres=${Settings.bsp!.display!.height}`
        accelArgs.push("-accel", "hvf", "-cpu", "host")
    }
    if (Settings.targetArch === "x86_64" && process.platform !== "darwin") {

        // Auto-detect GPU and enable GL for Intel/AMD
        if (await shouldUseGL()) {
            // Use virtio-vga-gl with SDL (more reliable GL context than GTK)
            displayOpt = "sdl,gl=on"
            gpuDevice = "virtio-vga-gl"
        } else {
            // QXL for NVIDIA/unknown (software rendering but correct resolution)
            displayOpt = "gtk"
            gpuDevice = `qxl-vga,xres=${Settings.bsp!.display!.width},yres=${Settings.bsp!.display!.height}`

        }

        accelArgs.push("-accel", "kvm", "-cpu", "host")

    }
    if (Settings.targetArch === "arm64" && process.platform === "darwin") {
        displayOpt = "cocoa"
        gpuDevice = `virtio-gpu-pci,xres=${Settings.bsp!.display!.width},yres=${Settings.bsp!.display!.height}`
        accelArgs.push("-accel", "hvf", "-cpu", "host")
    }
    if (Settings.targetArch === "arm64" && process.platform !== "darwin") {

        // Auto-detect GPU for ARM64 emulation as well
        if (await shouldUseGL()) {
            displayOpt = "gtk,gl=on"
            gpuDevice = `virtio-gpu-gl-pci,xres=${Settings.bsp!.display!.width},yres=${Settings.bsp!.display!.height}`
        } else {
            displayOpt = "gtk"
            gpuDevice = `virtio-gpu-pci,xres=${Settings.bsp!.display!.width},yres=${Settings.bsp!.display!.height}`
        }
        accelArgs.push("-cpu", "cortex-a57")
    }

    // ARMHF (ARMv7) configuration
    if (Settings.targetArch === "armhf" && process.platform === "darwin") {
        displayOpt = "cocoa"
        gpuDevice = `virtio-gpu-pci,xres=${Settings.bsp!.display!.width},yres=${Settings.bsp!.display!.height}`
        // No HVF acceleration on macOS for 32-bit ARM, use TCG emulation
        accelArgs.push("-cpu", "cortex-a15")
    }
    if (Settings.targetArch === "armhf" && process.platform !== "darwin") {

        // Auto-detect GPU for ARMHF emulation
        if (await shouldUseGL()) {
            displayOpt = "gtk,gl=on"
            gpuDevice = `virtio-gpu-gl-pci,xres=${Settings.bsp!.display!.width},yres=${Settings.bsp!.display!.height}`
        } else {
            displayOpt = "gtk"
            gpuDevice = `virtio-gpu-pci,xres=${Settings.bsp!.display!.width},yres=${Settings.bsp!.display!.height}`
        }
        accelArgs.push("-cpu", "cortex-a15")
    }


    // Build the QEMU Arguments
    const args: string[] = [
        "-machine", machineType,
        "-m", "2048",
        "-device", gpuDevice,
        "-display", displayOpt,
        "-device", "qemu-xhci",
        "-device", "usb-kbd",
        "-device", "usb-tablet",
        "-drive", "file=dist/output/qemu/rootfs.ext4,format=raw,if=virtio",
        "-kernel", "dist/cache/qemu/vmlinuz",
        "-initrd", "dist/cache/qemu/initrd.img",
        "-append", consoleArgs.join(" "),
        "-serial", "mon:stdio",
        ...accelArgs,

        // Network
        "-netdev", "user,id=net0",
        "-device", "virtio-net-pci,netdev=net0"
    ]


    const usbDevices = Settings.main!.qemu!.usb! ?? []
    let sessionConfigs: { port: number; key: string; vendor: string; product: string }[] = []

    if (usbDevices.length > 0 && process.platform === "darwin") {
        Logger.info(`USB passthrough: ${usbDevices.length} device(s)`)

        // Verify usb redir supported
        if (!USBRedirect.qemuSupportsUSBRedir(qemuBin!)) Logger.errorWithExit("USB passthrough requires QEMU built with usbredir support. Please rebuild QEMU with usbredir support.")

        // Start USB Redir Sessions
        sessionConfigs = USBRedirect.createUSBRedirSessionPorts(usbDevices)

        sessionConfigs.forEach((config, index) => {

            args.push(
                "-chardev", `socket,host=127.0.0.1,port=${config.port},id=redir${index},server=on,wait=off`,
                "-device", `usb-redir,chardev=redir${index},id=usbredir${index}`
            )

            Logger.info("Using usbredir for USB passthrough on macOS (QEMU as server)")

        })
    }

    if (usbDevices.length > 0 && process.platform !== "darwin") {

        for (const usb of usbDevices) {
            args.push(
                "-device", `usb-host,vendorid=0x${usb.vendor_id},productid=0x${usb.product_id}`
            )
        }

        Logger.info(`USB passthrough: ${usbDevices.length} device(s)`)

    }

    const customFlags = Settings.main!.qemu!.flags! ?? []
    args.push(...customFlags)

    const fullCommand = `${qemuBin} ${args.join(" ")}`
    Logger.info(`Running QEMU: ${fullCommand}`)


    const proc = Bun.spawn([qemuBin!, ...args], {
        stdio: ["inherit", "inherit", "inherit"],
        env: process.env
    })

    if (sessionConfigs.length > 0 && process.platform === "darwin") {

        await Bun.sleep(5000)

        for (const config of sessionConfigs) {

            if (!await waitForPort("127.0.0.1", config.port, 2000)) Logger.errorWithExit(`QEMU did not start listening on port ${config.port} for ${config.key}`)
        }

        USBRedirect.start(sessionConfigs)

        await Bun.sleep(300)

        const failed = USBRedirect.sessions.find((s) => s.process.exitCode !== null && s.process.exitCode !== undefined && s.process.exitCode !== 0)
        if (failed) {
            const stderr = decodeChunks(failed.stderrChunks)
            const stdout = decodeChunks(failed.stdoutChunks)
            const msg = stderr ?? stdout ?? "usbredir failed to open the device. Ensure it is connected and not claimed exclusively."
            throw new Error(`usbredir failed for ${failed.key}: ${msg}`)
        }

    }


    // Forward signals to QEMU process
    const signalHandler = (signal: NodeJS.Signals) => {
        proc.kill(signal === "SIGINT" ? 2 : 15)
    }

    // Monitor USB Redir Processes
    const USBRedirMonitors = USBRedirect.sessions.map(async (session) => {

        const code = await session.exited
        if (code !== null && code !== 0) {
            const stderr = decodeChunks(session.stderrChunks)
            const stdout = decodeChunks(session.stdoutChunks)
            const errorMsg = stderr ?? stdout ?? "usbredirect process exited unexpectedly"

            // Only log non-connection-reset errors, as connection resets are expected when QEMU shuts down
            if (!errorMsg.includes("Connection reset by peer") && !errorMsg.includes("Failed to read guest")) {
                Logger.error(`usbredirect process for ${session.key} exited with code ${code}: ${errorMsg}`)
            }
        }
        return code

    })

    try {
        // Wait for QEMU or any usbredirect process to exit
        const results = await Promise.race([
            proc.exited.then((code) => ({ type: "qemu" as const, code })),
            Promise.any(USBRedirMonitors).then((code) => ({ type: "usbredir" as const, code })),
        ])

        if (results.type === "qemu") {
            const exitCode = results.code
            if (exitCode !== 0) {
                throw new Error(`QEMU exited with code ${exitCode}`)
            }
            Logger.success("QEMU emulator stopped")
        } else {
            // usbredirect exited - check if QEMU is still running
            const qemuStillRunning = proc.exitCode === null
            if (qemuStillRunning) {
                Logger.warning("usbredirect process exited unexpectedly. USB passthrough may not work correctly.")
            }
            // Continue waiting for QEMU to exit
            const exitCode = await proc.exited
            if (exitCode !== 0) {
                throw new Error(`QEMU exited with code ${exitCode}`)
            }
            Logger.success("QEMU emulator stopped")
        }
    } finally {
        // Clean up signal handlers
        process.removeAllListeners("SIGINT")
        process.removeAllListeners("SIGTERM")
        USBRedirect.stop()
    }
}

function decodeChunks(chunks: Uint8Array[]): string {
    if (chunks.length === 0) return ""
    return chunks.map((chunk) => decoder.decode(chunk)).join("")
}


// Detects the GPU vendor on Linux systems
async function detectGPUVendor(): Promise<"amd" | "intel" | "nvidia" | "unknown"> {


    if (process.platform !== "linux") return "unknown"

    try {

        const drmDirectory = "/sys/class/drm"
        const cards = await readdir(drmDirectory)

        // Check through all the entries in the DRM Directory
        for (const card of cards) {

            if (!card.startsWith("card")) continue

            const vendorPath = join(drmDirectory, card, "device", "vendor")

            try {
                const vendorFile = Bun.file(vendorPath)
                if (await vendorFile.exists()) {
                    const vendor = (await vendorFile.text()).trim()
                    switch (vendor) {
                        case "0x8086":
                            return "intel"
                        case "0x1002":
                            return "amd"
                        case "0x10de":
                            return "nvidia"
                    }
                }
            } catch {
                continue
            }


        }

    } catch {


        return "unknown"

    }

    return "unknown"


}

async function shouldUseGL() : Promise<boolean> {


    const env = process.env.STRUX_GL
    if (env !== undefined) {
        return env === "1"
    }

    // Auto-detect based on GPU vendor
    const vendor = await detectGPUVendor()
    switch (vendor) {
        case "intel":
        case "amd":
            Logger.info(`Detected ${vendor.toUpperCase()} GPU, enabling GL acceleration`)
            return true
        case "nvidia":
            Logger.info("Detected NVIDIA GPU, using software rendering (set STRUX_GL=1 to override)")
            return false
        default:
            Logger.info("Unknown GPU vendor, using software rendering (set STRUX_GL=1 to override)")
            return false
    }
}

async function verifyArtifactsExist(): Promise<void> {

    const artifacts = [
        { path: "dist/cache/qemu/vmlinuz", name: "Kernel" },
        { path: "dist/cache/qemu/initrd.img", name: "Initramfs" },
        { path: "dist/output/qemu/rootfs.ext4", name: "Root Filesystem EXT4" }
    ]

    for (const artifact of artifacts) {
        if (!fileExists(join(Settings.projectPath, artifact.path))) return Logger.errorWithExit(`${artifact.name} not found. Please build the project first.`)
    }

}


