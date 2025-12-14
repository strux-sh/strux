/***
 *
 *
 *  USB Detection and Configuration Tool
 *
 */

import { join, resolve } from "path"
// @ts-expect-error - prompts doesn't have types
import prompts from "prompts"
import chalk from "chalk"
import { info, success, warning, debug } from "../../utils/colors"

export interface UsbDevice {
    vendorId: string
    productId: string
    description?: string
}

const decoder = new TextDecoder()

function decode(output?: Uint8Array | null): string {
    if (!output) {
        return ""
    }
    return decoder.decode(output)
}


function normalizeId(id: string | number | undefined | null): string | null {
    if (id === undefined || id === null) {
        return null
    }

    // Accept hex strings, decimal strings, and numbers; normalize to 4-digit lowercase hex
    let num: number

    if (typeof id === "number") {
        num = id
    } else if (typeof id === "string") {
        const lower = id.toLowerCase().trim()
        // If string starts with "0x", parse as hex
        if (lower.startsWith("0x")) {
            num = parseInt(id, 16)
        } else if (/^[0-9]{4}$/.test(lower)) {
            // 4-digit numeric string (no hex letters) - use threshold to decide
            // If decimal value >= 4096 (0x1000), it's more likely hex (USB IDs are typically hex)
            // Otherwise treat as decimal
            // This handles: "1008" (< 4096) -> decimal -> "03f0", "5705" (>= 4096) -> hex -> "5705"
            const asDecimal = parseInt(lower, 10)
            if (asDecimal >= 4096) {
                // Large value, likely hex
                num = parseInt(id, 16)
            } else {
                // Small value, treat as decimal
                num = parseInt(id, 10)
            }
        } else if (/^[0-9a-f]{4}$/.test(lower)) {
            // 4-digit string with hex letters - definitely hex
            num = parseInt(id, 16)
        } else if (/^[0-9a-f]+$/.test(lower)) {
            // String contains only hex digits but not exactly 4 digits
            if (/[a-f]/.test(lower)) {
                // Contains hex letters (a-f), definitely hex
                num = parseInt(id, 16)
            } else {
                // Contains only digits (0-9), parse as decimal
                num = parseInt(id, 10)
            }
        } else {
            // Contains non-hex characters, treat as decimal
            num = parseInt(id, 10)
        }
    } else {
        return null
    }

    if (isNaN(num)) {
        return null
    }

    // Convert to 4-digit lowercase hex string (toString(16) already returns lowercase)
    return num.toString(16).padStart(4, "0").slice(-4)
}

function runCommand(command: string, args: string[]): { stdout: string; stderr: string; exitCode: number; error?: Error } {
    try {
        const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" })
        return {
            stdout: decode(result.stdout),
            stderr: decode(result.stderr),
            exitCode: result.exitCode ?? 0,
        }
    } catch (err) {
        return {
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
            exitCode: 1,
            error: err instanceof Error ? err : new Error(String(err)),
        }
    }
}

export function parseLsusbOutput(output: string): UsbDevice[] {
    const devices: UsbDevice[] = []
    const lines = output.split(/\r?\n/)

    for (const rawLine of lines) {
        const line = rawLine.trim()
        if (line.length === 0) {
            continue
        }

        const match = /ID\s+([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\s*(.+)?$/.exec(line)
        if (!match) {
            continue
        }

        // lsusb outputs are always hex, so parse directly as hex
        const vendorId = normalizeId("0x" + match[1])
        const productId = normalizeId("0x" + match[2])
        if (!vendorId || !productId) {
            continue
        }

        const description = match[3]?.trim()
        devices.push({ vendorId, productId, description })
    }

    return devices
}

export function parseMacSystemProfiler(jsonOutput: string): UsbDevice[] {
    const devices: UsbDevice[] = []

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
                if (typeof item !== "object" || item === null) {
                    continue
                }

                const record = item as Record<string, unknown>
                const vendorId = normalizeId(getValue(record, "vendor_id", "idVendor", "vendor-id"))
                const productId = normalizeId(getValue(record, "product_id", "idProduct", "product-id"))
                const name = typeof record._name === "string" ? record._name : undefined

                if (vendorId && productId) {
                    devices.push({
                        vendorId,
                        productId,
                        description: name,
                    })
                }

                const children = record.items
                if (Array.isArray(children)) {
                    walk(children)
                }
            }
        }

        walk(root)
    } catch {
        return devices
    }

    return devices
}

export function parseIoregOutput(output: string): UsbDevice[] {
    const devices: UsbDevice[] = []
    const lines = output.split(/\r?\n/)

    let currentVendor: string | null = null
    let currentProduct: string | null = null
    let currentName: string | null = null

    const flush = (): void => {
        const vendorId = normalizeId(currentVendor)
        const productId = normalizeId(currentProduct)
        if (vendorId && productId) {
            devices.push({
                vendorId,
                productId,
                description: currentName ?? undefined,
            })
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

export function parseWindowsUsbJson(jsonOutput: string): UsbDevice[] {
    const devices: UsbDevice[] = []

    let parsed: unknown
    try {
        parsed = JSON.parse(jsonOutput)
    } catch {
        return devices
    }

    const entries = Array.isArray(parsed) ? parsed : [parsed]
    for (const entry of entries) {
        if (typeof entry !== "object" || entry === null) {
            continue
        }

        const record = entry as Record<string, unknown>
        const instanceId = typeof record.InstanceId === "string"
            ? record.InstanceId
            : typeof record.InstanceID === "string"
                ? record.InstanceID
                : typeof record.Instance === "string"
                    ? record.Instance
                    : null

        if (!instanceId) {
            continue
        }

        const match = /VID_([0-9A-F]{4}).*PID_([0-9A-F]{4})/i.exec(instanceId)
        if (!match) {
            continue
        }

        // Windows USB IDs are always hex
        const vendorId = normalizeId("0x" + match[1])
        const productId = normalizeId("0x" + match[2])
        if (!vendorId || !productId) {
            continue
        }

        const description = typeof record.FriendlyName === "string"
            ? record.FriendlyName
            : typeof record.Name === "string"
                ? record.Name
                : undefined

        devices.push({ vendorId, productId, description })
    }

    return devices
}

async function detectLinuxUsb(): Promise<UsbDevice[]> {
    const result = runCommand("lsusb", [])
    if (result.exitCode !== 0) {
        throw new Error(result.stderr || "Failed to run lsusb")
    }

    const devices = parseLsusbOutput(result.stdout)
    if (devices.length === 0) {
        warning("No USB devices detected via lsusb")
    }
    return devices
}

async function detectMacUsb(): Promise<UsbDevice[]> {
    const profiler = runCommand("system_profiler", ["SPUSBDataType", "-json"])
    if (profiler.exitCode === 0) {
        const parsed = parseMacSystemProfiler(profiler.stdout)
        if (parsed.length > 0) {
            return parsed
        }
        debug("system_profiler returned no parsable USB devices, falling back to ioreg")
    } else {
        debug(`system_profiler failed: ${profiler.stderr}`)
    }

    const fallback = runCommand("ioreg", ["-p", "IOUSB", "-l", "-w", "0"])
    if (fallback.exitCode !== 0) {
        throw new Error(fallback.stderr || "Failed to run ioreg for USB detection")
    }

    const parsed = parseIoregOutput(fallback.stdout)
    if (parsed.length === 0) {
        warning("No USB devices detected via ioreg")
    }
    return parsed
}

async function detectWindowsUsb(): Promise<UsbDevice[]> {
    const command = [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        "Get-PnpDevice -Class USB -PresentOnly | Select-Object InstanceId,FriendlyName | ConvertTo-Json -Compress",
    ]
    const result = runCommand("powershell.exe", command)

    if (result.exitCode !== 0) {
        throw new Error(result.stderr || "Failed to run PowerShell USB detection")
    }

    const devices = parseWindowsUsbJson(result.stdout)
    if (devices.length === 0) {
        warning("No USB devices detected via PowerShell")
    }
    return devices
}

async function detectUsbDevices(): Promise<UsbDevice[]> {
    const platform = process.platform
    if (platform === "linux") {
        return detectLinuxUsb()
    }
    if (platform === "darwin") {
        return detectMacUsb()
    }
    if (platform === "win32") {
        return detectWindowsUsb()
    }
    throw new Error(`Unsupported platform: ${platform}`)
}

function dedupeDevices(devices: UsbDevice[]): UsbDevice[] {
    const seen = new Set<string>()
    const unique: UsbDevice[] = []

    for (const device of devices) {
        const vendorId = normalizeId(device.vendorId)
        const productId = normalizeId(device.productId)
        if (!vendorId || !productId) {
            continue
        }

        const key = `${vendorId}:${productId}`
        if (seen.has(key)) {
            continue
        }
        seen.add(key)
        unique.push({
            vendorId,
            productId,
            description: device.description,
        })
    }

    return unique
}

async function readProjectConfig(projectDir: string): Promise<{ path: string; config: any }> {
    const configPath = join(projectDir, "strux.json")
    const configFile = Bun.file(configPath)

    if (!(await configFile.exists())) {
        throw new Error("strux.json not found. Run this command in a Strux project directory")
    }

    let config: any
    try {
        config = JSON.parse(await configFile.text())
    } catch (err) {
        throw new Error(`Failed to parse strux.json: ${err instanceof Error ? err.message : String(err)}`)
    }

    return { path: configPath, config }
}

async function writeProjectConfig(path: string, config: any): Promise<void> {
    await Bun.write(path, JSON.stringify(config, null, 2) + "\n")
}

export interface UsbCommandOptions {
    projectDir?: string
}

function getExistingUsbDevices(qemuConfig: any): { vendor_id: string; product_id: string }[] {
    if (!Array.isArray(qemuConfig?.usb)) {
        return []
    }

    return qemuConfig.usb.map((d: { vendor_id?: unknown; product_id?: unknown }) => ({
        vendor_id: normalizeId(typeof d.vendor_id === "string" || typeof d.vendor_id === "number" ? d.vendor_id : null) ?? "",
        product_id: normalizeId(typeof d.product_id === "string" || typeof d.product_id === "number" ? d.product_id : null) ?? "",
    })).filter((d: { vendor_id: string; product_id: string }) => d.vendor_id && d.product_id)
}

function deviceKey(vendorId: string, productId: string): string {
    return `${vendorId}:${productId}`
}

function formatKeyWithName(key: string, nameMap: Map<string, string>): string {
    const name = nameMap.get(key)
    return name ? `${key} (${name})` : key
}

function keyToDevice(key: string): { vendor_id: string; product_id: string } | null {
    const [vendorId, productId] = key.split(":")
    if (!vendorId || !productId) {
        return null
    }
    const normalizedVendor = normalizeId(vendorId)
    const normalizedProduct = normalizeId(productId)
    if (!normalizedVendor || !normalizedProduct) {
        return null
    }
    return { vendor_id: normalizedVendor, product_id: normalizedProduct }
}

function formatDeviceLabel(device: UsbDevice, suffix = ""): string {
    const label = device.description ?? "USB device"
    return `${label} (${device.vendorId}:${device.productId})${suffix}`
}

export async function usbAdd(options: UsbCommandOptions = {}): Promise<void> {
    const projectDir = resolve(options.projectDir ?? process.cwd())

    info("Detecting connected USB devices...")
    const devices = await detectUsbDevices()
    const unique = dedupeDevices(devices)

    if (unique.length === 0) {
        warning("No USB devices detected to add to strux.json")
        return
    }

    unique.forEach((device) => {
        const label = device.description ? `${device.description} ` : ""
        debug(`Found USB device ${label}(vendor=${device.vendorId}, product=${device.productId})`)
    })

    const { path, config } = await readProjectConfig(projectDir)
    const qemu = config.qemu ?? {}
    const existing = getExistingUsbDevices(qemu)
    const normalizedExisting = new Set(existing.map((d) => deviceKey(d.vendor_id, d.product_id)))

    const nameMap = new Map<string, string>()
    for (const device of unique) {
        if (device.description) {
            nameMap.set(deviceKey(device.vendorId, device.productId), device.description)
        }
    }

    const newDevices = unique.filter((device) => !normalizedExisting.has(deviceKey(device.vendorId, device.productId)))

    const choices = [
        ...existing.map((device) => ({
            title: formatDeviceLabel({
                vendorId: device.vendor_id,
                productId: device.product_id,
                description: nameMap.get(deviceKey(device.vendor_id, device.product_id)),
            }, " [configured]"),
            value: deviceKey(device.vendor_id, device.product_id),
            selected: true,
        })),
        ...newDevices.map((device) => ({
            title: formatDeviceLabel(device, " [new]"),
            value: deviceKey(device.vendorId, device.productId),
            selected: false,
        })),
    ]

    if (choices.length === 0) {
        warning("No USB devices available to select")
        return
    }

    const response = await prompts({
        type: "multiselect",
        name: "selected",
        message: "Select USB devices to keep in strux.json (toggle to add/remove)",
        instructions: chalk.cyan("↑↓ to move, space to toggle, enter to confirm"),
        choices,
    })

    const selectedKeys: string[] = Array.isArray(response.selected) ? response.selected : []

    const selectedDevices: { vendor_id: string; product_id: string }[] = []
    for (const key of selectedKeys) {
        const device = keyToDevice(key)
        if (device) {
            selectedDevices.push(device)
        }
    }

    const finalSet = new Set(selectedDevices.map((d) => deviceKey(d.vendor_id, d.product_id)))
    const addedKeys = Array.from(finalSet).filter((key) => !normalizedExisting.has(key))
    const removedKeys = Array.from(normalizedExisting).filter((key) => !finalSet.has(key))

    qemu.usb = selectedDevices
    config.qemu = qemu

    await writeProjectConfig(path, config)

    if (addedKeys.length > 0) {
        addedKeys.forEach((key) => info(`Added USB device ${formatKeyWithName(key, nameMap)}`))
    }
    if (removedKeys.length > 0) {
        removedKeys.forEach((key) => info(`Removed USB device ${formatKeyWithName(key, nameMap)}`))
    }

    success(`Updated strux.json (${selectedDevices.length} device${selectedDevices.length === 1 ? "" : "s"} selected)`)
}

export async function usbList(options: UsbCommandOptions = {}): Promise<void> {
    const projectDir = resolve(options.projectDir ?? process.cwd())
    const { path, config } = await readProjectConfig(projectDir)
    const qemu = config.qemu ?? {}
    const existing = getExistingUsbDevices(qemu)
    const nameMap = new Map<string, string>()

    try {
        const detected = dedupeDevices(await detectUsbDevices())
        for (const device of detected) {
            if (device.description) {
                nameMap.set(deviceKey(device.vendorId, device.productId), device.description)
            }
        }
    } catch (err) {
        debug(`USB name detection skipped: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (existing.length === 0) {
        info("No USB devices are configured in strux.json")
        return
    }

    info("Configured USB devices:")
    existing.forEach((device, index) => {
        console.log(`  [${index + 1}] ${device.vendor_id}:${device.product_id}`)
    })

    const { remove } = await prompts({
        type: "toggle",
        name: "remove",
        message: "Remove any devices?",
        initial: false,
        active: "yes",
        inactive: "no",
    })

    if (!remove) {
        return
    }

    const choices = existing.map((device) => ({
        title: formatKeyWithName(`${device.vendor_id}:${device.product_id}`, nameMap),
        value: `${device.vendor_id}:${device.product_id}`,
    }))

    const { selected } = await prompts({
        type: "multiselect",
        name: "selected",
        message: "Select USB devices to remove",
        instructions: chalk.cyan("↑↓ to move, space to toggle, enter to confirm"),
        choices,
    })

    const selectedSet = new Set<string>(Array.isArray(selected) ? selected : [])
    if (selectedSet.size === 0) {
        info("No devices selected for removal. strux.json was not modified.")
        return
    }

    const updated = existing.filter((device) => {
        const key = `${device.vendor_id}:${device.product_id}`
        return !selectedSet.has(key)
    })

    qemu.usb = updated
    config.qemu = qemu
    await writeProjectConfig(path, config)

    selectedSet.forEach((key) => info(`Removed USB device ${formatKeyWithName(key, nameMap)}`))
    info(`Removed ${selectedSet.size} USB device${selectedSet.size === 1 ? "" : "s"} from strux.json`)
    success("strux.json updated")
}

export async function usb(options: UsbCommandOptions = {}): Promise<void> {
    return usbAdd(options)
}
