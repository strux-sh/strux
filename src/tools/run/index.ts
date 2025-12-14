/***
 *
 *  Run Tool - QEMU Emulator
 *
 */

import { $ } from "bun"
import { join } from "path"
import { stat, readdir } from "fs/promises"
import { Socket } from "net"
import { validateConfig, type Config } from "../../types/config"
import { info, success, warning, error as logError, title } from "../../utils/colors"
import { fileExists } from "../../utils/path"

interface UsbRedirSession {
    port: number
    process: Bun.Subprocess
    key: string
    stdoutChunks: Uint8Array[]
    stderrChunks: Uint8Array[]
    exited: Promise<number | null>
    redirectBin: string
    redirectMode: "usbredir-host" | "usbredirect"
}

const decoder = new TextDecoder()

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
async function checkArtifacts(isDev = false): Promise<void> {
    const prefix = isDev ? "dev-" : ""
    const artifacts = [
        { path: `dist/${prefix}vmlinuz`, name: "kernel" },
        { path: `dist/${prefix}initrd.img`, name: "initrd" },
        { path: `dist/${prefix}rootfs.ext4`, name: "rootfs" },
    ]

    for (const artifact of artifacts) {
        if (!fileExists(artifact.path)) {
            const cmd = isDev ? "strux dev" : "strux build qemu"
            throw new Error(`${artifact.name} not found at ${artifact.path}. Run '${cmd}' first`)
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
    isDev?: boolean
    systemDebug?: boolean
}

function normalizeHex(id: string): string {
    return id.toLowerCase().replace(/^0x/, "").padStart(4, "0")
}

function normalizeUsbId(id: string): { primary: string } {
    const trimmed = id.trim()
    return { primary: normalizeHex(trimmed) }
}

function findUsbRedirectBinary(): { bin: string; mode: "usbredir-host" | "usbredirect" } | null {
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

function spawnUsbRedirSession(port: number, key: string, redirect: { bin: string; mode: "usbredir-host" | "usbredirect" }): UsbRedirSession {
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

function createUsbRedirSessionPorts(usbDevices: { vendor_id: string; product_id: string }[]): { port: number; key: string; vendor: string; product: string }[] {
    return usbDevices.map((usb, index) => {
        const port = 43000 + index
        const vendor = normalizeUsbId(usb.vendor_id)
        const product = normalizeUsbId(usb.product_id)
        const key = `${vendor.primary}:${product.primary}`
        return { port, key, vendor: usb.vendor_id, product: usb.product_id }
    })
}

function startUsbRedirSessions(sessionConfigs: { port: number; key: string; vendor: string; product: string }[]): UsbRedirSession[] {
    const sessions: UsbRedirSession[] = []
    const redirect = findUsbRedirectBinary()

    if (!redirect) {
        throw new Error("usbredir tool not found. Install with `brew install usbredir`.")
    }

    sessionConfigs.forEach((config) => {
        sessions.push(spawnUsbRedirSession(config.port, config.key, redirect))
    })

    return sessions
}

function stopUsbRedirSessions(sessions: UsbRedirSession[]): void {
    for (const session of sessions) {
        try {
            session.process.kill()
        } catch {
            // Ignore cleanup errors
        }
    }
}

function decodeChunks(chunks: Uint8Array[]): string {
    if (chunks.length === 0) return ""
    return chunks.map((chunk) => decoder.decode(chunk)).join("")
}

async function waitForPort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
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

function supportsUsbRedir(qemuBin: string): boolean {
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

/**
 * Run Strux OS in QEMU emulator
 */
export async function run(options: RunOptions = {}): Promise<void> {
    const isDev = options.isDev ?? false
    const systemDebug = options.systemDebug ?? false
    title(isDev ? "Running Strux OS (Dev Mode)" : "Running Strux OS")
    info("Starting QEMU emulator...")

    // Check for required artifacts
    await checkArtifacts(isDev)

    // Load configuration
    const config = await loadConfig()
    const cwd = process.cwd()

    const arch = config.arch
    const resolution = config.display?.resolution ?? "1920x1080"
    const { width: resWidth, height: resHeight } = parseResolution(resolution)
    const isX86 = arch === "x86_64"
    const qemuOverride = process.env.STRUX_QEMU_BIN

    let qemuBin: string
    let machineType: string
    let consoleArg: string
    let displayOpt: string
    let gpuDevice: string
    let accelArgs: string[]

    if (isX86) {
        qemuBin = qemuOverride ?? "qemu-system-x86_64"
        machineType = "q35"
        // Show systemd messages for debugging if systemDebug is enabled
        if (systemDebug) {
            consoleArg = `root=/dev/vda rw console=tty1 console=ttyS0 fbcon=map:0 vt.global_cursor_default=0 video=Virtual-1:${resolution}@60`
        } else {
            consoleArg = `root=/dev/vda rw quiet splash loglevel=0 logo.nologo vt.handoff=7 rd.plymouth.show-delay=0 plymouth.ignore-serial-consoles systemd.show_status=false console=tty1 console=ttyS0 fbcon=map:0 vt.global_cursor_default=0 video=Virtual-1:${resolution}@60`
        }

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
        qemuBin = qemuOverride ?? "qemu-system-aarch64"
        machineType = "virt"
        // Show systemd messages for debugging if systemDebug is enabled
        if (systemDebug) {
            consoleArg = `root=/dev/vda rw console=tty1 console=ttyAMA0 fbcon=map:0 vt.global_cursor_default=0 video=${resolution}`
        } else {
            consoleArg = `root=/dev/vda rw quiet splash loglevel=0 logo.nologo vt.handoff=7 rd.plymouth.show-delay=0 plymouth.ignore-serial-consoles systemd.show_status=false console=tty1 console=ttyAMA0 fbcon=map:0 vt.global_cursor_default=0 video=${resolution}`
        }

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
    const prefix = isDev ? "dev-" : ""
    const args: string[] = [
        "-machine", machineType,
        "-m", "2048",
        "-device", gpuDevice,
        "-display", displayOpt,
        "-device", "qemu-xhci",
        "-device", "usb-kbd",
        "-device", "usb-tablet",
        "-drive", `file=dist/${prefix}rootfs.ext4,format=raw,if=virtio`,
        "-kernel", `dist/${prefix}vmlinuz`,
        "-initrd", `dist/${prefix}initrd.img`,
        "-append", consoleArg,
        "-serial", "mon:stdio",
        ...accelArgs,
    ]

    // Add virtfs mount for dev mode
    if (isDev) {
        const struxDir = join(cwd, "dist", "strux")
        // Verify directory exists before starting QEMU
        try {
            await stat(struxDir)
            info(`Virtfs directory found: ${struxDir}`)
        } catch {
            warning(`Virtfs directory not found: ${struxDir}`)
            warning("Dev mode requires dist/strux directory. Make sure you've run 'strux dev' first.")
        }
        args.push(
            "-virtfs", `local,path=${struxDir},mount_tag=strux,security_model=mapped-xattr`,
            "-device", "virtio-9p-pci,fsdev=strux,mount_tag=strux"
        )
        info("Virtfs configured for dev mode")
    }

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
    const usbRedirSessions: UsbRedirSession[] = []
    let usbRedirSessionConfigs: { port: number; key: string; vendor: string; product: string }[] = []
    if (usbDevices.length > 0) {
        info(`USB passthrough: ${usbDevices.length} device(s)`)
        const isMac = process.platform === "darwin"
        if (isMac) {
            const forceUsbRedir = process.env.STRUX_USB_REDIR_FORCE === "1"
            const usbRedirSupported = supportsUsbRedir(qemuBin)
            if (!usbRedirSupported && !forceUsbRedir) {
                throw new Error("This QEMU build does not include usb-redir support. Install a build with usbredir enabled (e.g., build QEMU from source with usbredir, or use MacPorts 'sudo port install qemu +usbredir'), then set STRUX_QEMU_BIN to that binary. To override detection, set STRUX_USB_REDIR_FORCE=1.")
            }
            // Create session configs to get ports, but don't start usbredirect yet
            usbRedirSessionConfigs = createUsbRedirSessionPorts(usbDevices)
            // QEMU will be the server, so configure chardev sockets first
            usbRedirSessionConfigs.forEach((config, index) => {
                args.push(
                    "-chardev", `socket,host=127.0.0.1,port=${config.port},id=redir${index},server=on,wait=off`,
                    "-device", `usb-redir,chardev=redir${index},id=usbredir${index}`
                )
            })
            info("Using usbredir for USB passthrough on macOS (QEMU as server)")
        } else {
            for (const usb of usbDevices) {
                args.push(
                    "-device", `usb-host,vendorid=0x${usb.vendor_id},productid=0x${usb.product_id}`
                )
            }
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

    // If using usbredir with QEMU as server, start usbredirect clients after QEMU is listening
    if (usbRedirSessionConfigs.length > 0 && process.platform === "darwin") {
        // Wait a moment for QEMU to start listening on the sockets
        await new Promise((resolve) => setTimeout(resolve, 500))

        // Verify QEMU is listening on the ports before starting usbredirect clients
        for (const config of usbRedirSessionConfigs) {
            const listening = await waitForPort("127.0.0.1", config.port, 2000)
            if (!listening) {
                throw new Error(`QEMU did not start listening on port ${config.port} for ${config.key}`)
            }
        }

        // Now start usbredirect clients to connect to QEMU
        usbRedirSessions.push(...startUsbRedirSessions(usbRedirSessionConfigs))

        // Give usbredir a moment to fail fast if it cannot open the device
        await new Promise((resolve) => setTimeout(resolve, 300))

        const failed = usbRedirSessions.find((s) => s.process.exitCode !== null && s.process.exitCode !== undefined && s.process.exitCode !== 0)
        if (failed) {
            const stderr = decodeChunks(failed.stderrChunks)
            const stdout = decodeChunks(failed.stdoutChunks)
            const msg = stderr || stdout || "usbredir failed to open the device. Ensure it is connected and not claimed exclusively."
            throw new Error(`usbredir failed for ${failed.key}: ${msg}`)
        }
    }

    // Forward signals to QEMU process
    const signalHandler = (signal: NodeJS.Signals) => {
        proc.kill(signal === "SIGINT" ? 2 : 15)
    }

    process.on("SIGINT", () => signalHandler("SIGINT"))
    process.on("SIGTERM", () => signalHandler("SIGTERM"))

    // Monitor usbredirect processes for unexpected exits
    const usbRedirMonitors = usbRedirSessions.map(async (session) => {
        const code = await session.exited
        if (code !== null && code !== 0) {
            const stderr = decodeChunks(session.stderrChunks)
            const stdout = decodeChunks(session.stdoutChunks)
            const errorMsg = stderr || stdout || "usbredirect process exited unexpectedly"

            // Only log non-connection-reset errors, as connection resets are expected when QEMU shuts down
            if (!errorMsg.includes("Connection reset by peer") && !errorMsg.includes("Failed to read guest")) {
                logError(`usbredirect process for ${session.key} exited with code ${code}: ${errorMsg}`)
            }
        }
        return code
    })

    try {
        // Wait for QEMU or any usbredirect process to exit
        const results = await Promise.race([
            proc.exited.then((code) => ({ type: "qemu" as const, code })),
            Promise.any(usbRedirMonitors).then((code) => ({ type: "usbredir" as const, code })),
        ])

        if (results.type === "qemu") {
            const exitCode = results.code
            if (exitCode !== 0) {
                throw new Error(`QEMU exited with code ${exitCode}`)
            }
            success("QEMU emulator stopped")
        } else {
            // usbredirect exited - check if QEMU is still running
            const qemuStillRunning = proc.exitCode === null
            if (qemuStillRunning) {
                warning("usbredirect process exited unexpectedly. USB passthrough may not work correctly.")
            }
            // Continue waiting for QEMU to exit
            const exitCode = await proc.exited
            if (exitCode !== 0) {
                throw new Error(`QEMU exited with code ${exitCode}`)
            }
            success("QEMU emulator stopped")
        }
    } finally {
        // Clean up signal handlers
        process.removeAllListeners("SIGINT")
        process.removeAllListeners("SIGTERM")
        stopUsbRedirSessions(usbRedirSessions)
    }
}
