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
import { copyClientBaseFiles, copyAllInitialArtifacts } from "./artifacts"

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
 */
export async function compileApplication(): Promise<void> {
    const bspName = Settings.bspName!
    await Runner.runScriptInDocker(scriptBuildApp, {
        message: "Compiling Application...",
        messageOnError: "Failed to compile Application. Please check the build logs for more information.",
        exitOnError: true,
        env: {
            PRESELECTED_BSP: bspName,
            BSP_CACHE_DIR: `/project/dist/cache/${bspName}`
        }
    })
}

/**
 * Compiles the Cage Wayland compositor for the target architecture.
 */
export async function compileCage(): Promise<void> {
    const bspName = Settings.bspName!
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
        const devEnvJSON = {
            clientKey: Settings.main?.dev?.server?.client_key ?? "",
            useMDNS: Settings.main?.dev?.server?.use_mdns_on_client ?? true,
            fallbackHosts: Settings.main?.dev?.server?.fallback_hosts ?? [],
        }
        await Bun.write(devEnvPath, JSON.stringify(devEnvJSON, null, 2))
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

