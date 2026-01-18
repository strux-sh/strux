/**
 * USB Device Detection and Configuration Commands
 *
 * Provides commands for detecting, adding, and managing USB device
 * passthrough configuration in Strux projects.
 */

import { resolve } from "path"
import prompts from "prompts"
import chalk from "chalk"
import { Logger } from "../../utils/log"
import {
    detectUsbDevices,
    dedupeDevices,
    deviceKey,
    formatDeviceLabel,
    formatKeyWithName,
    keyToDevice,
    readProjectConfig,
    writeProjectConfig,
    getExistingUsbDevices
} from "./utils"

export interface USBCommandOptions {
    projectDir?: string
}

/**
 * Adds USB devices to the project configuration.
 * Detects connected USB devices and allows the user to select which ones
 * to include in the QEMU USB passthrough configuration.
 */
export async function usbAdd(options: USBCommandOptions = {}): Promise<void> {
    const projectDir = resolve(options.projectDir ?? process.cwd())

    Logger.info("Detecting connected USB devices...")
    const devices = await detectUsbDevices()
    const unique = dedupeDevices(devices)

    if (unique.length === 0) {
        Logger.warning("No USB devices detected to add to strux.yaml")
        return
    }

    for (const device of unique) {
        const label = device.description ? `${device.description} ` : ""
        Logger.debug(`Found USB device ${label}(vendor=${device.vendorID}, product=${device.productID})`)
    }

    const { path, config } = readProjectConfig(projectDir)
    const existing = getExistingUsbDevices(config.qemu)
    const normalizedExisting = new Set(existing.map((d) => deviceKey(d.vendor_id, d.product_id)))

    const nameMap = new Map<string, string>()
    for (const device of unique) {
        if (device.description) {
            nameMap.set(deviceKey(device.vendorID, device.productID), device.description)
        }
    }

    const newDevices = unique.filter((device) =>
        !normalizedExisting.has(deviceKey(device.vendorID, device.productID))
    )

    const choices = [
        ...existing.map((device) => ({
            title: formatDeviceLabel(
                {
                    vendorID: device.vendor_id,
                    productID: device.product_id,
                    description: nameMap.get(deviceKey(device.vendor_id, device.product_id)) ?? ""
                },
                " [configured]"
            ),
            value: deviceKey(device.vendor_id, device.product_id),
            selected: true
        })),
        ...newDevices.map((device) => ({
            title: formatDeviceLabel(device, " [new]"),
            value: deviceKey(device.vendorID, device.productID),
            selected: false
        }))
    ]

    if (choices.length === 0) {
        Logger.warning("No USB devices available to select")
        return
    }

    const response = await prompts({
        type: "multiselect",
        name: "selected",
        message: "Select USB devices to keep in strux.yaml (toggle to add/remove)",
        instructions: chalk.cyan("↑↓ to move, space to toggle, enter to confirm"),
        choices
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

    const updatedConfig = {
        ...config,
        qemu: {
            ...config.qemu,
            enabled: config.qemu?.enabled ?? false,
            network: config.qemu?.network ?? false,
            usb: selectedDevices
        }
    }

    writeProjectConfig(path, updatedConfig)

    for (const key of addedKeys) {
        Logger.info(`Added USB device ${formatKeyWithName(key, nameMap)}`)
    }
    for (const key of removedKeys) {
        Logger.info(`Removed USB device ${formatKeyWithName(key, nameMap)}`)
    }

    const deviceCount = selectedDevices.length
    Logger.success(`Updated strux.yaml (${deviceCount} device${deviceCount === 1 ? "" : "s"} selected)`)
}

/**
 * Lists configured USB devices and optionally allows removal.
 * Shows all USB devices currently configured in the project and provides
 * an interactive interface to remove selected devices.
 */
export async function usbList(options: USBCommandOptions = {}): Promise<void> {
    const projectDir = resolve(options.projectDir ?? process.cwd())
    const { path, config } = readProjectConfig(projectDir)
    const existing = getExistingUsbDevices(config.qemu)
    const nameMap = new Map<string, string>()

    try {
        const detected = dedupeDevices(await detectUsbDevices())
        for (const device of detected) {
            if (device.description) {
                nameMap.set(deviceKey(device.vendorID, device.productID), device.description)
            }
        }
    } catch (err) {
        Logger.debug(`USB name detection skipped: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (existing.length === 0) {
        Logger.info("No USB devices are configured in strux.yaml")
        return
    }

    Logger.info("Configured USB devices:")
    existing.forEach((device, index) => {
        console.log(`  [${index + 1}] ${device.vendor_id}:${device.product_id}`)
    })

    const { remove } = await prompts({
        type: "toggle",
        name: "remove",
        message: "Remove any devices?",
        initial: false,
        active: "yes",
        inactive: "no"
    })

    if (!remove) {
        return
    }

    const choices = existing.map((device) => ({
        title: formatKeyWithName(`${device.vendor_id}:${device.product_id}`, nameMap),
        value: `${device.vendor_id}:${device.product_id}`
    }))

    const { selected } = await prompts({
        type: "multiselect",
        name: "selected",
        message: "Select USB devices to remove",
        instructions: chalk.cyan("↑↓ to move, space to toggle, enter to confirm"),
        choices
    })

    const selectedSet = new Set<string>(Array.isArray(selected) ? selected : [])
    if (selectedSet.size === 0) {
        Logger.info("No devices selected for removal. strux.yaml was not modified.")
        return
    }

    const updated = existing.filter((device) => {
        const key = `${device.vendor_id}:${device.product_id}`
        return !selectedSet.has(key)
    })

    const updatedConfig = {
        ...config,
        qemu: {
            ...config.qemu,
            enabled: config.qemu?.enabled ?? false,
            network: config.qemu?.network ?? false,
            usb: updated
        }
    }

    writeProjectConfig(path, updatedConfig)

    for (const key of selectedSet) {
        Logger.info(`Removed USB device ${formatKeyWithName(key, nameMap)}`)
    }
    Logger.info(`Removed ${selectedSet.size} USB device${selectedSet.size === 1 ? "" : "s"} from strux.yaml`)
    Logger.success("strux.yaml updated")
}

/**
 * Default USB command - runs usbAdd
 */
export async function usb(options: USBCommandOptions = {}): Promise<void> {
    return usbAdd(options)
}
