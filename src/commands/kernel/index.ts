/***
 *
 *
 *  Kernel Command
 *
 *  Provides commands for kernel configuration and management.
 *
 */

import { join } from "path"
import { Settings } from "../../settings"
import { Runner } from "../../utils/run"
import { Logger } from "../../utils/log"
import { fileExists } from "../../utils/path"
import { BSPYamlValidator } from "../../types/bsp-yaml"
import { MainYAMLValidator } from "../../types/main-yaml"

// Kernel Scripts
// @ts-ignore
import scriptKernelFetch from "../../assets/scripts-base/strux-kernel-fetch.sh" with { type: "text" }
// @ts-ignore
import scriptKernelMenuconfig from "../../assets/scripts-base/strux-kernel-menuconfig.sh" with { type: "text" }
// @ts-ignore
import scriptKernelClean from "../../assets/scripts-base/strux-kernel-clean.sh" with { type: "text" }

/**
 * Opens an interactive menuconfig session for kernel configuration.
 * Ensures kernel source is downloaded and runs menuconfig in Docker.
 */
export async function kernelMenuconfig(options: { save?: boolean } = {}): Promise<void> {
    const bspName = Settings.bspName!

    // Validate configuration files
    if (!fileExists(join(Settings.projectPath, "strux.yaml"))) {
        return Logger.errorWithExit("strux.yaml file not found. Please create it first.")
    }

    MainYAMLValidator.validateAndLoad()

    const bspYamlPath = join(Settings.projectPath, "bsp", bspName, "bsp.yaml")
    if (!fileExists(bspYamlPath)) {
        return Logger.errorWithExit(`BSP ${bspName} not found. Please create it first.`)
    }

    BSPYamlValidator.validateAndLoad(bspYamlPath, bspName)

    // Check if custom kernel is enabled
    if (!Settings.bsp?.boot?.kernel?.custom_kernel) {
        return Logger.errorWithExit("Custom kernel is not enabled in bsp.yaml. Set boot.kernel.custom_kernel to true.")
    }

    const kernelSource = Settings.bsp?.boot?.kernel?.source
    if (!kernelSource) {
        return Logger.errorWithExit("Kernel source not specified in bsp.yaml")
    }

    Logger.info("Preparing kernel source for menuconfig...")

    // Fetch kernel source if needed
    await Runner.runScriptInDocker(scriptKernelFetch, {
        message: "Ensuring kernel source is available...",
        exitOnError: true,
        env: {
            PRESELECTED_BSP: bspName,
            BSP_CACHE_DIR: `/project/dist/cache/${bspName}`,
            KERNEL_SOURCE: kernelSource
        }
    })

    Logger.info("Opening menuconfig in Docker...")
    Logger.info("Use arrow keys to navigate, Space to toggle, Enter to select, / to search")

    // Run menuconfig with TTY support using Runner
    await Runner.runInteractiveScriptInDocker(scriptKernelMenuconfig, {
        message: "Running kernel menuconfig...",
        exitOnError: true,
        env: {
            PRESELECTED_BSP: bspName,
            BSP_CACHE_DIR: `/project/dist/cache/${bspName}`,
            SAVE_CONFIG: options.save ? "true" : "false"
        }
    })

    Logger.success(`Kernel configuration saved to bsp/${bspName}/configs/kernel.config`)
    Logger.info("This config will be used automatically on the next kernel build.")

    if (options.save) {
        Logger.success(`Minimal config fragment also saved to bsp/${bspName}/configs/kernel.fragment`)
        Logger.info("You can add this fragment to your bsp.yaml if you prefer:")
        Logger.info("  fragments:")
        Logger.info("    - \"./configs/kernel.fragment\"")
    }
}

/**
 * Cleans the kernel build artifacts.
 * Supports different clean modes: mrproper, clean, full
 */
export async function kernelClean(options: { mode?: "mrproper" | "clean" | "full" } = {}): Promise<void> {
    const bspName = Settings.bspName!
    const cleanMode = options.mode ?? "mrproper"

    Logger.info(`Cleaning kernel build artifacts (mode: ${cleanMode})...`)

    await Runner.runScriptInDocker(scriptKernelClean, {
        message: `Cleaning kernel (${cleanMode})...`,
        exitOnError: true,
        env: {
            PRESELECTED_BSP: bspName,
            BSP_CACHE_DIR: `/project/dist/cache/${bspName}`,
            CLEAN_MODE: cleanMode
        }
    })

    Logger.success("Kernel clean completed")
}
