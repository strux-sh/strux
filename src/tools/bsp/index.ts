/***
 *
 *  BSP Command - Board Support Package management
 *
 */

import { join, basename, resolve } from "path"
import { mkdir, rm, readdir, cp } from "fs/promises"
import { success, info, warning, error, newSpinner } from "../../utils/colors"
import { loadBSP, listBSPs, type LoadedBSP, type BSP } from "../../types/bsp"
import { isValidGitSource } from "../../utils/url"

/**
 * Add a BSP from a git repository or local path
 */
export async function bspAdd(source: string, options: { set?: boolean }): Promise<void> {
    const cwd = process.cwd()
    const bspDir = join(cwd, "bsp")

    // Ensure bsp directory exists
    await mkdir(bspDir, { recursive: true })

    let bspName: string
    let targetDir: string

    if (isValidGitSource(source)) {
        // Clone from git
        bspName = extractBspNameFromGit(source)
        targetDir = join(bspDir, bspName)

        // Check if already exists
        if (await directoryExists(targetDir)) {
            throw new Error(`BSP "${bspName}" already exists. Remove it first with 'strux bsp remove ${bspName}'`)
        }

        const spinner = newSpinner(`Cloning BSP from ${source}...`)
        spinner.start()

        try {
            const proc = Bun.spawn(["git", "clone", "--depth", "1", source, targetDir], {
                stdout: "pipe",
                stderr: "pipe",
            })

            const exitCode = await proc.exited

            if (exitCode !== 0) {
                const stderr = await new Response(proc.stderr).text()
                throw new Error(`Git clone failed: ${stderr}`)
            }

            // Remove .git directory
            await rm(join(targetDir, ".git"), { recursive: true, force: true })

            spinner.stopWithSuccess(`Cloned BSP "${bspName}"`)
        } catch (err) {
            spinner.stopWithError("Failed to clone BSP")
            // Clean up partial clone
            await rm(targetDir, { recursive: true, force: true })
            throw err
        }
    } else {
        // Copy from local path
        const sourcePath = resolve(source)

        if (!(await directoryExists(sourcePath))) {
            throw new Error(`Source path does not exist: ${sourcePath}`)
        }

        bspName = basename(sourcePath)
        targetDir = join(bspDir, bspName)

        // Check if already exists
        if (await directoryExists(targetDir)) {
            throw new Error(`BSP "${bspName}" already exists. Remove it first with 'strux bsp remove ${bspName}'`)
        }

        const spinner = newSpinner(`Copying BSP from ${sourcePath}...`)
        spinner.start()

        try {
            await cp(sourcePath, targetDir, { recursive: true })
            spinner.stopWithSuccess(`Copied BSP "${bspName}"`)
        } catch (err) {
            spinner.stopWithError("Failed to copy BSP")
            throw err
        }
    }

    // Validate the BSP
    try {
        await loadBSP(targetDir)
        success("BSP validated successfully")
    } catch (err) {
        warning(`BSP validation warning: ${err instanceof Error ? err.message : String(err)}`)
        warning("The BSP may not be fully configured")
    }

    // Set as active BSP if requested
    if (options.set) {
        await setActiveBSP(cwd, `./bsp/${bspName}`)
        success(`Set "${bspName}" as active BSP`)
    }

    info(`BSP "${bspName}" added to ./bsp/${bspName}`)
}

/**
 * List all available BSPs
 */
export async function bspList(): Promise<void> {
    const cwd = process.cwd()
    const bspDir = join(cwd, "bsp")

    // Get active BSP from config
    const activeBsp = await getActiveBSP(cwd)

    const bspNames = await listBSPs(bspDir)

    if (bspNames.length === 0) {
        info("No BSPs found in ./bsp/")
        info("Add a BSP with: strux bsp add <source>")
        info("Or create a new one with: strux bsp init <name>")
        return
    }

    console.log("\nAvailable BSPs:\n")

    for (const name of bspNames) {
        try {
            const bsp = await loadBSP(join(bspDir, name))
            const isActive = activeBsp === `./bsp/${name}` || activeBsp === name

            const marker = isActive ? "*" : " "
            const arch = bsp.arch.padEnd(6)
            const soc = (bsp.soc || "N/A").padEnd(15)
            const artifacts = bsp.artifacts?.source || "none"

            console.log(`  ${marker} ${name.padEnd(20)} ${arch} ${soc} (${artifacts})`)
        } catch {
            console.log(`  ? ${name.padEnd(20)} (invalid configuration)`)
        }
    }

    console.log("")
    info("* = active BSP")
}

/**
 * Remove a BSP
 */
export async function bspRemove(name: string): Promise<void> {
    const cwd = process.cwd()
    const bspDir = join(cwd, "bsp", name)

    if (!(await directoryExists(bspDir))) {
        throw new Error(`BSP "${name}" not found`)
    }

    // Check if it's the active BSP
    const activeBsp = await getActiveBSP(cwd)
    if (activeBsp === `./bsp/${name}` || activeBsp === name) {
        warning(`"${name}" is the currently active BSP`)
    }

    await rm(bspDir, { recursive: true })
    success(`Removed BSP "${name}"`)
}

/**
 * Show detailed information about a BSP
 */
export async function bspInfo(name: string): Promise<void> {
    const cwd = process.cwd()
    const bspDir = join(cwd, "bsp", name)

    if (!(await directoryExists(bspDir))) {
        throw new Error(`BSP "${name}" not found`)
    }

    const bsp = await loadBSP(bspDir)

    console.log("")
    console.log(`BSP: ${bsp.name}`)
    console.log("─".repeat(40))

    if (bsp.description) {
        console.log(`Description: ${bsp.description}`)
    }

    console.log(`Architecture: ${bsp.arch}`)

    if (bsp.soc) {
        console.log(`SoC: ${bsp.soc}`)
    }

    // Artifacts
    if (bsp.artifacts) {
        console.log("")
        console.log("Artifacts:")
        console.log(`  Source: ${bsp.artifacts.source || "none"}`)
        if (bsp.artifacts.script) {
            console.log(`  Script: ${bsp.artifacts.script}`)
        }
        if (bsp.artifacts.urls) {
            console.log("  URLs:")
            for (const [key, url] of Object.entries(bsp.artifacts.urls)) {
                console.log(`    ${key}: ${url}`)
            }
        }
    }

    // Partitions
    if (bsp.partitions && bsp.partitions.layout && bsp.partitions.layout.length > 0) {
        console.log("")
        console.log("Partition Layout:")
        console.log(`  Table Type: ${bsp.partitions.table || "gpt"}`)
        for (const part of bsp.partitions.layout) {
            const name = part.name || "(unnamed)"
            const size = part.size || "auto"
            console.log(`  - ${name}: ${part.source} (${size})`)
        }
    }

    // Kernel
    if (bsp.kernel?.enabled) {
        console.log("")
        console.log("Kernel:")
        console.log(`  Source: ${bsp.kernel.source || "default"}`)
        if (bsp.kernel.version) {
            console.log(`  Version: ${bsp.kernel.version}`)
        }
        if (bsp.kernel.defconfig) {
            console.log(`  Defconfig: ${bsp.kernel.defconfig}`)
        }
        if (bsp.kernel.fragments && bsp.kernel.fragments.length > 0) {
            console.log(`  Fragments: ${bsp.kernel.fragments.join(", ")}`)
        }
    }

    // U-Boot
    if (bsp.uboot?.enabled) {
        console.log("")
        console.log("U-Boot:")
        console.log(`  Source: ${bsp.uboot.source || "default"}`)
        if (bsp.uboot.version) {
            console.log(`  Version: ${bsp.uboot.version}`)
        }
        if (bsp.uboot.defconfig) {
            console.log(`  Defconfig: ${bsp.uboot.defconfig}`)
        }
    }

    // Flash
    if (bsp.flash) {
        console.log("")
        console.log("Flash:")
        if (bsp.flash.script) {
            console.log(`  Script: ${bsp.flash.script}`)
        }
        if (bsp.flash.instructions) {
            console.log(`  Instructions: ${bsp.flash.instructions}`)
        }
    }

    // Packages
    if (bsp.packages && bsp.packages.length > 0) {
        console.log("")
        console.log("Packages:")
        for (const pkg of bsp.packages) {
            console.log(`  - ${pkg}`)
        }
    }

    console.log("")
}

/**
 * Initialize a new BSP skeleton
 */
export async function bspInit(name: string, options: { arch?: string }): Promise<void> {
    const cwd = process.cwd()
    const bspDir = join(cwd, "bsp", name)

    // Check if already exists
    if (await directoryExists(bspDir)) {
        throw new Error(`BSP "${name}" already exists`)
    }

    // Detect architecture if not specified
    const arch = options.arch || (process.arch === "arm64" ? "arm64" : "amd64")

    info(`Creating BSP skeleton: ${name}`)
    info(`Architecture: ${arch}`)

    // Create directory structure
    await mkdir(bspDir, { recursive: true })
    await mkdir(join(bspDir, "scripts"), { recursive: true })
    await mkdir(join(bspDir, "artifacts"), { recursive: true })
    await mkdir(join(bspDir, "kernel"), { recursive: true })
    await mkdir(join(bspDir, "dts"), { recursive: true })
    await mkdir(join(bspDir, "patches", "kernel"), { recursive: true })
    await mkdir(join(bspDir, "patches", "uboot"), { recursive: true })
    await mkdir(join(bspDir, "overlay"), { recursive: true })

    // Create bsp.json
    const bspConfig: BSP = {
        name: name,
        description: `Board Support Package for ${name}`,
        arch: arch as "arm64" | "amd64",
        soc: "",
        artifacts: {
            source: "script",
            script: "./scripts/fetch-artifacts.sh",
        },
        partitions: {
            table: "gpt",
            layout: [
                {
                    name: "boot",
                    source: "fat",
                    size: "256M",
                },
                {
                    name: "rootfs",
                    source: "rootfs",
                },
            ],
        },
        kernel: {
            enabled: false,
            fragments: [],
            patches: [],
            external_dts: [],
            overlays: [],
            extra_make_args: [],
        },
        uboot: {
            enabled: false,
            patches: [],
            extra_make_args: [],
        },
        flash: {
            script: "./scripts/flash.sh",
            instructions: "Run the flash script to write the image to the device",
        },
        packages: [],
    }

    await Bun.write(join(bspDir, "bsp.json"), JSON.stringify(bspConfig, null, 2))

    // Create fetch-artifacts.sh template
    const fetchScript = `#!/bin/bash
# Fetch artifacts script for ${name}
# This script downloads or builds the boot artifacts

set -e

ARTIFACTS_DIR="$(dirname "$0")/../artifacts"
mkdir -p "$ARTIFACTS_DIR"

echo "STRUX_PROGRESS: Fetching artifacts for ${name}..."

# Example: Download kernel and dtb
# wget -O "$ARTIFACTS_DIR/Image" "https://example.com/Image"
# wget -O "$ARTIFACTS_DIR/board.dtb" "https://example.com/board.dtb"

# Example: Build from source
# git clone https://github.com/example/firmware "$ARTIFACTS_DIR/firmware-src"
# cd "$ARTIFACTS_DIR/firmware-src"
# make

echo "STRUX_PROGRESS: Artifacts ready"
`

    await Bun.write(join(bspDir, "scripts", "fetch-artifacts.sh"), fetchScript)

    // Create flash.sh template
    const flashScript = `#!/bin/bash
# Flash script for ${name}
# This script writes the OS image to the target device

set -e

IMAGE="$1"
DEVICE="$2"

if [ -z "$IMAGE" ] || [ -z "$DEVICE" ]; then
    echo "Usage: $0 <image> <device>"
    echo "Example: $0 ./dist/strux.img /dev/sdX"
    exit 1
fi

echo "WARNING: This will erase all data on $DEVICE"
read -p "Continue? [y/N] " confirm

if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "Aborted"
    exit 1
fi

echo "Writing image to $DEVICE..."
sudo dd if="$IMAGE" of="$DEVICE" bs=4M status=progress conv=fsync

echo "Syncing..."
sync

echo "Done! You can now boot from $DEVICE"
`

    await Bun.write(join(bspDir, "scripts", "flash.sh"), flashScript)

    // Make scripts executable
    await Bun.spawn(["chmod", "+x", join(bspDir, "scripts", "fetch-artifacts.sh")]).exited
    await Bun.spawn(["chmod", "+x", join(bspDir, "scripts", "flash.sh")]).exited

    success(`Created BSP skeleton at ./bsp/${name}`)
    info("")
    info("Next steps:")
    info(`1. Edit ./bsp/${name}/bsp.json to configure your board`)
    info(`2. Update ./bsp/${name}/scripts/fetch-artifacts.sh to get boot files`)
    info(`3. Set as active: Add "bsp": "./bsp/${name}" to strux.json`)
}

/**
 * Helper: Extract BSP name from git URL
 */
function extractBspNameFromGit(url: string): string {
    // Handle various git URL formats
    // https://github.com/user/repo.git -> repo
    // git@github.com:user/repo.git -> repo
    // https://github.com/user/repo -> repo

    let name = url

    // Remove trailing .git
    if (name.endsWith(".git")) {
        name = name.slice(0, -4)
    }

    // Get the last path segment
    const parts = name.split(/[/:]/)
    name = parts[parts.length - 1] ?? name

    // Remove any query strings
    const queryIdx = name.indexOf("?")
    if (queryIdx !== -1) {
        name = name.substring(0, queryIdx)
    }

    return name
}

/**
 * Helper: Check if directory exists
 */
async function directoryExists(path: string): Promise<boolean> {
    try {
        const entries = await readdir(path)
        return true
    } catch {
        return false
    }
}

/**
 * Helper: Get active BSP from strux.json
 */
async function getActiveBSP(projectDir: string): Promise<string | null> {
    const configPath = join(projectDir, "strux.json")
    const file = Bun.file(configPath)

    if (!(await file.exists())) {
        return null
    }

    try {
        const config = await file.json()
        return config.bsp || null
    } catch {
        return null
    }
}

/**
 * Helper: Set active BSP in strux.json
 */
async function setActiveBSP(projectDir: string, bspPath: string): Promise<void> {
    const configPath = join(projectDir, "strux.json")
    const file = Bun.file(configPath)

    if (!(await file.exists())) {
        throw new Error("strux.json not found. Are you in a Strux project directory?")
    }

    const config = await file.json()
    config.bsp = bspPath

    await Bun.write(configPath, JSON.stringify(config, null, 2))
}
