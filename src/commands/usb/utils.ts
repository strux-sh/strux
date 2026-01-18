/**
 * USB Device Detection Utilities
 *
 * Cross-platform USB device enumeration supporting Linux, macOS, and Windows.
 * Uses platform-native tools (lsusb, system_profiler, PowerShell) to detect
 * connected USB devices.
 */

import { join } from "path"
import { readFileSync, writeFileSync } from "fs"
import { parseDocument } from "yaml"
import { Runner } from "../../utils/run"
import { Logger } from "../../utils/log"
import { MainYAMLValidator, type StruxYaml } from "../../types/main-yaml"

/**
 * Represents a USB device with vendor/product identification
 */
export interface USBDevice {
    vendorID: string
    productID: string
    description: string
}

/**
 * Normalizes a USB ID (vendor or product) to a 4-digit lowercase hex string.
 *
 * Accepts hex strings (with or without 0x prefix), decimal strings, and numbers.
 * Returns null for invalid inputs.
 */
export function normalizeID(id: string | number | undefined | null): string | null {
    if (id === undefined || id === null) {
        return null
    }

    let num: number

    if (typeof id === "number") {
        num = id
    } else if (typeof id === "string") {
        const lower = id.toLowerCase().trim()
        // Strip optional 0x prefix and parse as hex (USB IDs are always hex)
        const hexValue = lower.startsWith("0x") ? lower.slice(2) : lower
        num = parseInt(hexValue, 16)
    } else {
        return null
    }

    if (isNaN(num)) {
        return null
    }

    return num.toString(16).padStart(4, "0").slice(-4)
}

/**
 * Parses Linux lsusb command output into USB device list
 */
export function parseLSUSBOutput(output: string): USBDevice[] {
    const devices: USBDevice[] = []
    const lines = output.split(/\r?\n/)

    for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue

        const match = /ID\s+([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\s*(.+)?$/.exec(line)
        if (!match) continue

        const vendorID = normalizeID("0x" + match[1])
        const productID = normalizeID("0x" + match[2])
        if (!vendorID || !productID) continue

        devices.push({
            vendorID,
            productID,
            description: match[3]?.trim() ?? ""
        })
    }

    return devices
}

/**
 * Parses macOS system_profiler JSON output into USB device list
 */
export function parseMacSystemProfiler(jsonOutput: string): USBDevice[] {
    const devices: USBDevice[] = []

    try {
        const parsed = JSON.parse(jsonOutput)
        const root = parsed?.SPUSBDataType
        if (!Array.isArray(root)) {
            return devices
        }

        const getValue = (record: Record<string, unknown>, ...keys: string[]): string | number | null => {
            for (const key of keys) {
                const value = record[key]
                if (typeof value === "string" || typeof value === "number") {
                    return value
                }
            }
            return null
        }

        const walk = (items: unknown[]): void => {
            for (const item of items) {
                if (typeof item !== "object" || item === null) continue

                const record = item as Record<string, unknown>
                const vendorID = normalizeID(getValue(record, "vendor_id", "idVendor", "vendor-id"))
                const productID = normalizeID(getValue(record, "product_id", "idProduct", "product-id"))
                const name = typeof record._name === "string" ? record._name : undefined

                if (vendorID && productID) {
                    devices.push({ vendorID, productID, description: name ?? "" })
                }

                const children = record.items
                if (Array.isArray(children)) {
                    walk(children)
                }
            }
        }

        walk(root)
    } catch {
        // JSON parse failed - return empty list
    }

    return devices
}

/**
 * Parses macOS ioreg command output into USB device list
 */
export function parseIoregOutput(output: string): USBDevice[] {
    const devices: USBDevice[] = []
    const lines = output.split(/\r?\n/)

    let currentVendor: string | null = null
    let currentProduct: string | null = null
    let currentName: string | null = null

    const flush = (): void => {
        const vendorID = normalizeID(currentVendor)
        const productID = normalizeID(currentProduct)
        if (vendorID && productID) {
            devices.push({ vendorID, productID, description: currentName ?? "" })
        }
        currentVendor = null
        currentProduct = null
        currentName = null
    }

    for (const rawLine of lines) {
        const line = rawLine.trim()

        if (line.startsWith("+-o") || line.startsWith("| +-o") || line.startsWith("| | +-o")) {
            flush()
            const nameMatch = /\\-o\s+(.+?)@/.exec(line)
            if (nameMatch?.[1]) {
                currentName = nameMatch[1].trim()
            }
            continue
        }

        const vendorMatch = /"idVendor"\s*=\s*(0x[0-9a-fA-F]+|\d+)/.exec(line)
        if (vendorMatch?.[1]) {
            currentVendor = vendorMatch[1]
        }

        const productMatch = /"idProduct"\s*=\s*(0x[0-9a-fA-F]+|\d+)/.exec(line)
        if (productMatch?.[1]) {
            currentProduct = productMatch[1]
        }

        const nameMatch = /"USB Product Name"\s*=\s*"(.+?)"/.exec(line)
        if (nameMatch?.[1]) {
            currentName = nameMatch[1]
        }

        if (line === "}") {
            flush()
        }
    }

    flush()
    return devices
}

/**
 * Parses Windows PowerShell Get-PnpDevice JSON output into USB device list
 */
export function parseWindowsUsbJson(jsonOutput: string): USBDevice[] {
    const devices: USBDevice[] = []

    let parsed: unknown
    try {
        parsed = JSON.parse(jsonOutput)
    } catch {
        return devices
    }

    const entries = Array.isArray(parsed) ? parsed : [parsed]

    for (const entry of entries) {
        if (typeof entry !== "object" || entry === null) continue

        const record = entry as Record<string, unknown>
        const instanceId =
                typeof record.InstanceId === "string" ? record.InstanceId :
                    typeof record.InstanceID === "string" ? record.InstanceID :
                        typeof record.Instance === "string" ? record.Instance : null

        if (!instanceId) continue

        const match = /VID_([0-9A-F]{4}).*PID_([0-9A-F]{4})/i.exec(instanceId)
        if (!match) continue

        const vendorID = normalizeID("0x" + match[1])
        const productID = normalizeID("0x" + match[2])
        if (!vendorID || !productID) continue

        const description =
                typeof record.FriendlyName === "string" ? record.FriendlyName :
                    typeof record.Name === "string" ? record.Name : ""

        devices.push({ vendorID, productID, description })
    }

    return devices
}

/**
 * Detects USB devices on Linux using lsusb
 */
async function detectLinuxUsb(): Promise<USBDevice[]> {
    const result = await Runner.runCommand("lsusb", {
        message: "Detecting USB devices...",
        messageOnSuccess: "USB detection complete"
    })

    if (result.exitCode !== 0) {
        throw new Error(result.stderr || "Failed to run lsusb")
    }

    const devices = parseLSUSBOutput(result.stdout)
    if (devices.length === 0) {
        Logger.warning("No USB devices detected via lsusb")
    }
    return devices
}

/**
 * Detects USB devices on macOS using system_profiler with ioreg fallback
 */
async function detectMacUsb(): Promise<USBDevice[]> {
    const profilerResult = await Runner.runCommand("system_profiler SPUSBDataType -json", {
        message: "Detecting USB devices...",
        messageOnSuccess: "USB detection complete"
    })

    if (profilerResult.exitCode === 0) {
        const parsed = parseMacSystemProfiler(profilerResult.stdout)
        if (parsed.length > 0) {
            return parsed
        }
        Logger.debug("system_profiler returned no parsable USB devices, falling back to ioreg")
    } else {
        Logger.debug(`system_profiler failed: ${profilerResult.stderr}`)
    }

    const ioregResult = await Runner.runCommand("ioreg -p IOUSB -l -w 0", {
        message: "Detecting USB devices via ioreg...",
        messageOnSuccess: "USB detection complete"
    })

    if (ioregResult.exitCode !== 0) {
        throw new Error(ioregResult.stderr || "Failed to run ioreg for USB detection")
    }

    const parsed = parseIoregOutput(ioregResult.stdout)
    if (parsed.length === 0) {
        Logger.warning("No USB devices detected via ioreg")
    }
    return parsed
}

/**
 * Detects USB devices on Windows using PowerShell Get-PnpDevice
 */
async function detectWindowsUsb(): Promise<USBDevice[]> {
    const psCommand = [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-Command",
        "Get-PnpDevice -Class USB -PresentOnly | Select-Object InstanceId,FriendlyName | ConvertTo-Json -Compress"
    ].join(" ")

    const result = await Runner.runCommand(psCommand, {
        message: "Detecting USB devices...",
        messageOnSuccess: "USB detection complete"
    })

    if (result.exitCode !== 0) {
        throw new Error(result.stderr || "Failed to run PowerShell USB detection")
    }

    const devices = parseWindowsUsbJson(result.stdout)
    if (devices.length === 0) {
        Logger.warning("No USB devices detected via PowerShell")
    }
    return devices
}

/**
 * Detects connected USB devices on the current platform
 */
export async function detectUsbDevices(): Promise<USBDevice[]> {
    const platform = process.platform

    switch (platform) {
        case "linux":
            return detectLinuxUsb()
        case "darwin":
            return detectMacUsb()
        case "win32":
            return detectWindowsUsb()
        default:
            throw new Error(`Unsupported platform: ${platform}`)
    }
}

/**
 * Removes duplicate USB devices based on vendor:product ID
 */
export function dedupeDevices(devices: USBDevice[]): USBDevice[] {
    const seen = new Set<string>()
    const unique: USBDevice[] = []

    for (const device of devices) {
        const vendorID = normalizeID(device.vendorID)
        const productID = normalizeID(device.productID)
        if (!vendorID || !productID) continue

        const key = `${vendorID}:${productID}`
        if (seen.has(key)) continue

        seen.add(key)
        unique.push({ vendorID, productID, description: device.description })
    }

    return unique
}

/**
 * Creates a unique key string from vendor and product IDs
 */
export function deviceKey(vendorId: string, productId: string): string {
    return `${vendorId}:${productId}`
}

/**
 * Formats a device key with optional name for display
 */
export function formatKeyWithName(key: string, nameMap: Map<string, string>): string {
    const name = nameMap.get(key)
    return name ? `${key} (${name})` : key
}

/**
 * Converts a "vendor:product" key string back to a device object
 */
export function keyToDevice(key: string): { vendor_id: string; product_id: string } | null {
    const [vendorId, productId] = key.split(":")
    if (!vendorId || !productId) return null

    const normalizedVendor = normalizeID(vendorId)
    const normalizedProduct = normalizeID(productId)
    if (!normalizedVendor || !normalizedProduct) return null

    return { vendor_id: normalizedVendor, product_id: normalizedProduct }
}

/**
 * Formats a USB device for display with optional suffix
 */
export function formatDeviceLabel(device: USBDevice, suffix = ""): string {
    const label = device.description || "USB device"
    return `${label} (${device.vendorID}:${device.productID})${suffix}`
}

/**
 * Re-export StruxYaml type for convenience
 */
export type { StruxYaml }

/**
 * Reads and validates the strux.yaml project configuration file
 */
export function readProjectConfig(projectDir: string): { path: string; config: StruxYaml } {
    const configPath = join(projectDir, "strux.yaml")
    const result = MainYAMLValidator.safeValidate(configPath)

    if (!result.success) {
        const message = result.error instanceof Error
            ? result.error.message
            : "Failed to parse strux.yaml"
        throw new Error(message)
    }

    return { path: configPath, config: result.data! }
}

/**
 * Writes the project configuration back to strux.yaml
 */
export function writeProjectConfig(path: string, config: StruxYaml): void {
    const content = readFileSync(path, "utf-8")
    const doc = parseDocument(content)

    // Ensure qemu section exists
    if (!doc.has("qemu")) {
        doc.set("qemu", {})
    }

    // Update just the usb array, preserving other qemu settings and comments
    doc.setIn(["qemu", "usb"], config.qemu?.usb ?? [])

    writeFileSync(path, doc.toString())
}

/**
 * Extracts and normalizes USB devices from QEMU configuration
 */
export function getExistingUsbDevices(qemuConfig: StruxYaml["qemu"]): { vendor_id: string; product_id: string }[] {
    if (!Array.isArray(qemuConfig?.usb)) {
        return []
    }

    return qemuConfig.usb
        .map((d) => ({
            vendor_id: normalizeID(d.vendor_id) ?? "",
            product_id: normalizeID(d.product_id) ?? ""
        }))
        .filter((d): d is { vendor_id: string; product_id: string } => Boolean(d.vendor_id && d.product_id))
}
