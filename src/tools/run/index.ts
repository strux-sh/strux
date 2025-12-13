/***
 *
 *  Run Tool - QEMU Emulator
 *
 */

import { $ } from "bun"
import { join } from "path"
import { stat, readdir } from "fs/promises"
import { validateConfig, type Config } from "../../types/config"
import { info, success, warning, error as logError, title } from "../../utils/colors"
import { fileExists } from "../../utils/path"

/**
 * Detect GPU vendor on Linux by checking /sys/class/drm/cardN/device/vendor
 * Returns "intel", "amd", "nvidia", or "unknown"
 */
async function detectGPUVendor(): Promise<string> {
    if (process.platform !== "linux") {
        return "unknown"
    }

    try {
        const drmDir = "/sys/class/drm"
        const entries = await readdir(drmDir)

        for (const entry of entries) {
            if (!entry.startsWith("card")) continue

            const vendorPath = join(drmDir, entry, "device", "vendor")
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
        // Directory doesn't exist or not readable
    }

    return "unknown"
}

/**
 * Determine if GL acceleration should be enabled
 * Auto-enables for Intel/AMD, disabled for NVIDIA (needs software rendering)
 * Can be overridden with STRUX_GL=0 or STRUX_GL=1
 */
async function shouldUseGL(): Promise<boolean> {
    // Allow explicit override via environment variable
    const env = process.env.STRUX_GL
    if (env !== undefined) {
        return env === "1"
    }

    // Auto-detect based on GPU vendor
    const vendor = await detectGPUVendor()
    switch (vendor) {
        case "intel":
        case "amd":
            info(`Detected ${vendor.toUpperCase()} GPU, enabling GL acceleration`)
            return true
        case "nvidia":
            info("Detected NVIDIA GPU, using software rendering (set STRUX_GL=1 to override)")
            return false
        default:
            info("Unknown GPU vendor, using software rendering (set STRUX_GL=1 to override)")
            return false
    }
}

/**
 * Load project configuration from strux.json
 */
async function loadConfig(): Promise<Config> {
    const cwd = process.cwd()
    const configFile = Bun.file(join(cwd, "strux.json"))

    if (!(await configFile.exists())) {
        throw new Error("strux.json not found. Run this command in a Strux project directory")
    }

    const data = await configFile.json()
    const { validateConfigWithUrlCheck } = await import("../../types/config")
    const result = await validateConfigWithUrlCheck(data)

    if (!result.success) {
        throw result.error
    }

    return result.data
}

/**
 * Check if required build artifacts exist
 */
async function checkArtifacts(): Promise<void> {
    const artifacts = [
        { path: "dist/vmlinuz", name: "kernel" },
        { path: "dist/initrd.img", name: "initrd" },
        { path: "dist/rootfs.ext4", name: "rootfs" },
    ]

    for (const artifact of artifacts) {
        if (!fileExists(artifact.path)) {
            throw new Error(`${artifact.name} not found at ${artifact.path}. Run 'strux build qemu' first`)
        }
    }
}

/**
 * Parse resolution string into width and height
 */
function parseResolution(resolution: string): { width: string; height: string } {
    const parts = resolution.split("x")
    if (parts.length === 2 && parts[0] && parts[1]) {
        return { width: parts[0], height: parts[1] }
    }
    return { width: "1920", height: "1080" }
}

export interface RunOptions {
    // Future options can be added here
}

/**
 * Run Strux OS in QEMU emulator
 */
export async function run(options: RunOptions = {}): Promise<void> {
    title("Running Strux OS")
    info("Starting QEMU emulator...")

    // Check for required artifacts
    await checkArtifacts()

    // Load configuration
    const config = await loadConfig()

    const arch = config.arch
    const resolution = config.display?.resolution ?? "1920x1080"
    const { width: resWidth, height: resHeight } = parseResolution(resolution)
    const isX86 = arch === "x86_64"

    let qemuBin: string
    let machineType: string
    let consoleArg: string
    let displayOpt: string
    let gpuDevice: string
    let accelArgs: string[]

    if (isX86) {
        qemuBin = "qemu-system-x86_64"
        machineType = "q35"
        consoleArg = `root=/dev/vda rw quiet splash loglevel=0 logo.nologo vt.handoff=7 rd.plymouth.show-delay=0 plymouth.ignore-serial-consoles systemd.show_status=false console=tty1 console=ttyS0 fbcon=map:0 vt.global_cursor_default=0 video=Virtual-1:${resolution}@60`

        if (process.platform === "darwin") {
            displayOpt = "cocoa"
            gpuDevice = `virtio-gpu-pci,xres=${resWidth},yres=${resHeight}`
            accelArgs = ["-accel", "hvf", "-cpu", "host"]
        } else {
            // Linux x86_64: use KVM if available
            // Auto-detect GPU and enable GL for Intel/AMD
            if (await shouldUseGL()) {
                // Use virtio-vga-gl with SDL (more reliable GL context than GTK)
                displayOpt = "sdl,gl=on"
                gpuDevice = "virtio-vga-gl"
            } else {
                // QXL for NVIDIA/unknown (software rendering but correct resolution)
                displayOpt = "gtk"
                gpuDevice = `qxl-vga,xres=${resWidth},yres=${resHeight}`
            }
            accelArgs = ["-accel", "kvm", "-cpu", "host"]
        }
    } else {
        // ARM64
        qemuBin = "qemu-system-aarch64"
        machineType = "virt"
        consoleArg = `root=/dev/vda rw quiet splash loglevel=0 logo.nologo vt.handoff=7 rd.plymouth.show-delay=0 plymouth.ignore-serial-consoles systemd.show_status=false console=tty1 console=ttyAMA0 fbcon=map:0 vt.global_cursor_default=0 video=${resolution}`

        if (process.platform === "darwin") {
            displayOpt = "cocoa"
            gpuDevice = `virtio-gpu-pci,xres=${resWidth},yres=${resHeight}`
            accelArgs = ["-accel", "hvf", "-cpu", "host"]
        } else {
            // Auto-detect GPU for ARM64 emulation as well
            if (await shouldUseGL()) {
                displayOpt = "gtk,gl=on"
                gpuDevice = `virtio-gpu-gl-pci,xres=${resWidth},yres=${resHeight}`
            } else {
                displayOpt = "gtk"
                gpuDevice = `virtio-gpu-pci,xres=${resWidth},yres=${resHeight}`
            }
            accelArgs = ["-cpu", "cortex-a57"]
        }
    }

    // Build QEMU arguments
    const args: string[] = [
        "-machine", machineType,
        "-m", "2048",
        "-device", gpuDevice,
        "-display", displayOpt,
        "-device", "qemu-xhci",
        "-device", "usb-kbd",
        "-device", "usb-tablet",
        "-drive", "file=dist/rootfs.ext4,format=raw,if=virtio",
        "-kernel", "dist/vmlinuz",
        "-initrd", "dist/initrd.img",
        "-append", consoleArg,
        "-serial", "mon:stdio",
        ...accelArgs,
    ]

    // Add network if enabled (user-mode NAT networking)
    if (config.qemu?.network !== false) {
        info("Network enabled: user-mode NAT (guest can access host network)")
        args.push(
            "-netdev", "user,id=net0",
            "-device", "virtio-net-pci,netdev=net0"
        )
    }

    // Add USB passthrough devices
    const usbDevices = config.qemu?.usb ?? []
    if (usbDevices.length > 0) {
        info(`USB passthrough: ${usbDevices.length} device(s)`)
        for (const usb of usbDevices) {
            args.push(
                "-device", `usb-host,vendorid=0x${usb.vendor_id},productid=0x${usb.product_id}`
            )
        }
    }

    // Append custom QEMU flags from config
    const customFlags = config.qemu?.flags ?? []
    if (customFlags.length > 0) {
        args.push(...customFlags)
    }

    const fullCommand = `${qemuBin} ${args.join(" ")}`
    info(`Executing: ${fullCommand}`)

    // Execute QEMU using Bun's shell
    // We use spawn for proper signal handling and stdio passthrough
    const proc = Bun.spawn([qemuBin, ...args], {
        stdio: ["inherit", "inherit", "inherit"],
        env: process.env,
    })

    // Forward signals to QEMU process
    const signalHandler = (signal: NodeJS.Signals) => {
        proc.kill(signal === "SIGINT" ? 2 : 15)
    }

    process.on("SIGINT", () => signalHandler("SIGINT"))
    process.on("SIGTERM", () => signalHandler("SIGTERM"))

    // Wait for process to exit
    const exitCode = await proc.exited

    // Clean up signal handlers
    process.removeAllListeners("SIGINT")
    process.removeAllListeners("SIGTERM")

    if (exitCode !== 0) {
        throw new Error(`QEMU exited with code ${exitCode}`)
    }

    success("QEMU emulator stopped")
}
