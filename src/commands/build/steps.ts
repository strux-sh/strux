/***
 *
 *
 *  Build Step Functions
 *
 *  Individual build step implementations for the Strux build pipeline.
 *
 */

import { join } from "path"
import { mkdir } from "node:fs/promises"
import { Settings } from "../../settings"
import { Runner } from "../../utils/run"
import { fileExists, directoryExists } from "../../utils/path"
import { Logger } from "../../utils/log"
import { copyClientBaseFiles, copyAllInitialArtifacts, copyCageSourceFiles, copyWPEExtensionSourceFiles } from "./artifacts"

// Build Scripts
// @ts-ignore
import scriptBuildFrontend from "../../assets/scripts-base/strux-build-frontend.sh" with { type: "text" }
// @ts-ignore
import scriptBuildApp from "../../assets/scripts-base/strux-build-app.sh" with { type: "text" }
// @ts-ignore
import scriptBuildCage from "../../assets/scripts-base/strux-build-cage.sh" with { type: "text" }
// @ts-ignore
import scriptBuildWPE from "../../assets/scripts-base/strux-build-wpe.sh" with { type: "text" }
// @ts-ignore
import scriptBuildBase from "../../assets/scripts-base/strux-build-base.sh" with { type: "text" }
// @ts-ignore
import scriptBuildPost from "../../assets/scripts-base/strux-build-post.sh" with { type: "text" }
// @ts-ignore
import scriptBuildClient from "../../assets/scripts-base/strux-build-client.sh" with { type: "text" }
// @ts-ignore
import scriptBuildKernel from "../../assets/scripts-base/strux-build-kernel.sh" with { type: "text" }
// @ts-ignore
import scriptBuildBootloader from "../../assets/scripts-base/strux-build-bootloader.sh" with { type: "text" }

/**
 * Compiles the frontend application (Vue/React/vanilla JS).
 * Also regenerates TypeScript types before compilation.
 */
export async function compileFrontend(): Promise<void> {
    // Use the strux types command to refresh the strux.d.ts file
    await Runner.runCommand("strux types", {
        message: "Generating TypeScript types...",
        messageOnError: "Failed to generate TypeScript types. Please generate them manually.",
        exitOnError: true,
        cwd: Settings.projectPath
    })

    await Runner.runScriptInDocker(scriptBuildFrontend, {
        message: "Compiling Frontend...",
        messageOnError: "Failed to compile Frontend. Please check the build logs for more information.",
        exitOnError: true,
        env: {
            // Frontend uses shared cache (architecture-agnostic)
            SHARED_CACHE_DIR: "/project/dist/cache"
        }
    })
}

/**
 * Compiles the main.go application for the target architecture.
 * When --local-runtime is set, passes USE_LOCAL_RUNTIME=1 to the build script
 * which injects a go.mod replace directive inside the container (never touches host files).
 */
export async function compileApplication(): Promise<void> {
    const bspName = Settings.bspName!
    const env: Record<string, string> = {
        PRESELECTED_BSP: bspName,
        BSP_CACHE_DIR: `/project/dist/cache/${bspName}`
    }

    if (Settings.localRuntime) {
        env.USE_LOCAL_RUNTIME = "1"
        Logger.info("Using local runtime from: " + Settings.localRuntime)
    }

    await Runner.runScriptInDocker(scriptBuildApp, {
        message: "Compiling Application...",
        messageOnError: "Failed to compile Application. Please check the build logs for more information.",
        exitOnError: true,
        env
    })
}

/**
 * Compiles the Cage Wayland compositor for the target architecture.
 */
export async function compileCage(): Promise<void> {
    const bspName = Settings.bspName!

    // Cage source directory in artifacts
    const cageSrcPath = join(Settings.projectPath, "dist", "artifacts", "cage")

    // Create directory if it doesn't exist
    if (!directoryExists(cageSrcPath)) await mkdir(cageSrcPath, { recursive: true })

    // Copy Cage source files if they don't exist (first build)
    await copyCageSourceFiles(cageSrcPath)

    await Runner.runScriptInDocker(scriptBuildCage, {
        message: "Compiling Cage...",
        messageOnError: "Failed to compile Cage. Please check the build logs for more information.",
        exitOnError: true,
        env: {
            PRESELECTED_BSP: bspName,
            BSP_CACHE_DIR: `/project/dist/cache/${bspName}`
        }
    })
}

/**
 * Compiles the WPE WebKit extension for the target architecture.
 */
export async function compileWPE(): Promise<void> {
    const bspName = Settings.bspName!

    // WPE extension source directory in artifacts
    const wpeExtSrcPath = join(Settings.projectPath, "dist", "artifacts", "wpe-extension")

    // Create directory if it doesn't exist
    if (!directoryExists(wpeExtSrcPath)) await mkdir(wpeExtSrcPath, { recursive: true })

    // Copy WPE extension source files if they don't exist (first build)
    await copyWPEExtensionSourceFiles(wpeExtSrcPath)

    await Runner.runScriptInDocker(scriptBuildWPE, {
        message: "Compiling WPE Extension...",
        messageOnError: "Failed to compile WPE Extension. Please check the build logs for more information.",
        exitOnError: true,
        env: {
            PRESELECTED_BSP: bspName,
            BSP_CACHE_DIR: `/project/dist/cache/${bspName}`
        }
    })
}

/**
 * Builds the base root filesystem using debootstrap.
 * Note: YAML validation is now done at the start of the build process in index.ts
 */
export async function buildRootFS(): Promise<void> {
    const bspName = Settings.bspName!

    // Build the root filesystem using the base script
    await Runner.runScriptInDocker(scriptBuildBase, {
        message: "Building root filesystem...",
        messageOnError: "Failed to build root filesystem. Please check the build logs for more information.",
        exitOnError: true,
        env: {
            PRESELECTED_BSP: bspName,
            BSP_CACHE_DIR: `/project/dist/cache/${bspName}`
        }
    })

    Logger.success("Root filesystem built successfully")
}

/**
 * Writes the display configuration JSON to the BSP cache directory.
 * This is copied to /strux/.display-config.json on the rootfs by strux-build-post.sh.
 */
export async function writeDisplayConfig(bspName: string): Promise<void> {
    const bspCacheDir = join(Settings.projectPath, "dist", "cache", bspName)
    const displayConfigPath = join(bspCacheDir, ".display-config.json")

    const display = Settings.main?.display
    if (display?.monitors && display.monitors.length > 0) {
        // Use the display config from strux.yaml
        const config = {
            monitors: display.monitors.map(m => ({
                path: m.path,
                ...(m.resolution ? { resolution: m.resolution } : {}),
                ...(m.names && m.names.length > 0 ? { names: m.names } : {}),
            }))
        }
        await Bun.write(displayConfigPath, JSON.stringify(config))
        Logger.info(`Display config: ${display.monitors.length} monitor(s)`)
    } else {
        // Default single-monitor config using BSP display resolution
        const width = Settings.bsp?.display?.width ?? 1920
        const height = Settings.bsp?.display?.height ?? 1080
        const config = {
            monitors: [{ path: "/", resolution: `${width}x${height}` }]
        }
        await Bun.write(displayConfigPath, JSON.stringify(config))
    }

    // Write input device mapping file (device_substring:output_name per line)
    // Cage reads this to map touch/pointer devices to the correct output
    const inputMapPath = join(bspCacheDir, ".input-map")
    const lines: string[] = []
    if (display?.monitors) {
        for (const monitor of display.monitors) {
            if (monitor.input_devices && monitor.names && monitor.names.length > 0) {
                const outputName = monitor.names[0]
                for (const device of monitor.input_devices) {
                    lines.push(`${device}:${outputName}`)
                }
            }
        }
    }
    if (lines.length > 0) {
        await Bun.write(inputMapPath, lines.join("\n") + "\n")
        Logger.info(`Input map: ${lines.length} device mapping(s)`)
    }
}

/**
 * Updates the .dev-env.json file with current configuration from strux.yaml.
 * This is called separately to ensure dev config is always up-to-date even when client step is cached.
 */
export async function updateDevEnvConfig(bspName: string): Promise<void> {
    const bspCacheDir = join(Settings.projectPath, "dist", "cache", bspName)
    const devEnvPath = join(bspCacheDir, ".dev-env.json")

    const devEnvJSON = {
        clientKey: Settings.main?.dev?.server?.client_key ?? "",
        useMDNS: Settings.main?.dev?.server?.use_mdns_on_client ?? true,
        fallbackHosts: Settings.main?.dev?.server?.fallback_hosts ?? [],
        inspector: {
            // Default to disabled - user must explicitly enable in strux.yaml
            enabled: Settings.main?.dev?.inspector?.enabled ?? false,
            port: Settings.main?.dev?.inspector?.port ?? 9223,
        },
    }
    await Bun.write(devEnvPath, JSON.stringify(devEnvJSON, null, 2))
}

/**
 * Builds the Strux client binary for the target architecture.
 * Also handles dev mode configuration.
 */
export async function buildStruxClient(addDevMode = false): Promise<void> {
    const bspName = Settings.bspName!

    // This is a folder - contains the Go source files
    const clientSrcPath = join(Settings.projectPath, "dist", "artifacts", "client")

    // BSP-specific cache directory
    const bspCacheDir = join(Settings.projectPath, "dist", "cache", bspName)

    // This is a file (dev environment config) - now in BSP-specific cache
    const devEnvPath = join(bspCacheDir, ".dev-env.json")

    // If it doesn't exist, create the client folder
    if (!directoryExists(clientSrcPath)) await mkdir(clientSrcPath, { recursive: true })

    // Copy Go client-base files if they don't exist (first build)
    await copyClientBaseFiles(clientSrcPath)

    // Handle dev mode configuration
    if (addDevMode) {
        await updateDevEnvConfig(bspName)
    } else {
        // Remove the dev environment config file if it exists
        if (fileExists(devEnvPath)) await Bun.file(devEnvPath).delete()
    }

    // Compile the client
    await Runner.runScriptInDocker(scriptBuildClient, {
        message: "Compiling Strux Client...",
        messageOnError: "Failed to compile Strux Client. Please check the build logs for more information.",
        exitOnError: true,
        env: {
            PRESELECTED_BSP: bspName,
            BSP_CACHE_DIR: `/project/dist/cache/${bspName}`
        }
    })

    Logger.success("Strux Client built successfully")
}

/**
 * Extracts (fetches) and patches the Linux kernel source.
 * This is the first phase of the kernel build, separated so that
 * BSP scripts can modify the kernel source tree (e.g., install boot logos)
 * via the after_kernel_extract hook before configuration and compilation.
 */
export async function extractKernel(): Promise<void> {
    const bspName = Settings.bspName!

    await Runner.runScriptInDocker(scriptBuildKernel, {
        message: "Fetching and patching kernel source...",
        messageOnError: "Failed to fetch/patch kernel source. Please check the build logs for more information.",
        exitOnError: true,
        env: {
            PRESELECTED_BSP: bspName,
            BSP_CACHE_DIR: `/project/dist/cache/${bspName}`,
            KERNEL_PHASE: "extract"
        }
    })

    Logger.success("Kernel source extracted and patched")
}

/**
 * Builds the Linux kernel for the target architecture.
 * This is the second phase: configuration, compilation, and artifact installation.
 * Assumes source has already been fetched and patched by extractKernel().
 */
export async function buildKernel(): Promise<void> {
    const bspName = Settings.bspName!

    await Runner.runScriptInDocker(scriptBuildKernel, {
        message: "Building Linux Kernel...",
        messageOnError: "Failed to build Linux Kernel. Please check the build logs for more information.",
        exitOnError: true,
        env: {
            PRESELECTED_BSP: bspName,
            BSP_CACHE_DIR: `/project/dist/cache/${bspName}`,
            KERNEL_PHASE: "build"
        }
    })

    Logger.success("Linux Kernel built successfully")
}

/**
 * Builds the bootloader (U-Boot, GRUB, etc.) for the target architecture.
 * Skips if bootloader type is 'custom' or 'none'.
 */
export async function buildBootloader(): Promise<void> {
    const bspName = Settings.bspName!

    await Runner.runScriptInDocker(scriptBuildBootloader, {
        message: "Building Bootloader...",
        messageOnError: "Failed to build Bootloader. Please check the build logs for more information.",
        exitOnError: true,
        env: {
            PRESELECTED_BSP: bspName,
            BSP_CACHE_DIR: `/project/dist/cache/${bspName}`
        }
    })

    Logger.success("Bootloader built successfully")
}

/**
 * Post-processes the root filesystem.
 * Copies init scripts, systemd services, plymouth theme, and runs the post-processing script.
 */
export async function postProcessRootFS(): Promise<void> {
    const bspName = Settings.bspName!

    // Copy all initial artifacts (init scripts, systemd, plymouth, logo)
    await copyAllInitialArtifacts()

    // Run post process script
    await Runner.runScriptInDocker(scriptBuildPost, {
        message: "Post processing rootfs...",
        messageOnError: "Failed to post process rootfs. Please check the build logs for more information.",
        exitOnError: true,
        env: {
            PRESELECTED_BSP: bspName,
            BSP_CACHE_DIR: `/project/dist/cache/${bspName}`,
            SHARED_CACHE_DIR: "/project/dist/cache"
        }
    })

    Logger.success("RootFS post processing completed successfully")
}

