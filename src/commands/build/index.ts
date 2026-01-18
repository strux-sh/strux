/***
 *
 *
 *  Build Command
 *
 *  Main entry point for the Strux build pipeline.
 *  Orchestrates the build process with smart caching support.
 *
 */

import { join } from "path"
import { mkdir, rm } from "node:fs/promises"
import { Settings } from "../../settings"
import { Runner } from "../../utils/run"
import { fileExists, directoryExists } from "../../utils/path"
import { Logger } from "../../utils/log"
import { MainYAMLValidator } from "../../types/main-yaml"
import { BSPYamlValidator } from "../../types/bsp-yaml"

// Build Caching System
import {
    loadBuildCacheManifest,
    saveBuildCacheManifest,
    shouldRebuildStep,
    updateStepCache
} from "./cache"
import { type BuildStep } from "./cache-deps"

// Build Steps
import {
    compileFrontend,
    compileApplication,
    compileCage,
    compileWPE,
    buildRootFS,
    buildStruxClient,
    postProcessRootFS
} from "./steps"

// BSP Script Execution
import { runScriptsForStep } from "./bsp-scripts"

/**
 * Main build function - orchestrates the entire build pipeline.
 */
export async function build(): Promise<void> {
    const isDevMode = Settings.isDevMode
    const bspName = Settings.bspName!

    // ========================================
    // VALIDATE CONFIGURATION FILES
    // ========================================
    // Ensure the strux.yaml file exists
    if (!fileExists(join(Settings.projectPath, "strux.yaml"))) {
        return Logger.errorWithExit("strux.yaml file not found. Please create it first.")
    }

    // Load and validate the main Strux YAML configuration
    MainYAMLValidator.validateAndLoad()

    // Check if the BSP exists
    const bspYamlPath = join(Settings.projectPath, "bsp", bspName, "bsp.yaml")
    if (!fileExists(bspYamlPath)) {
        return Logger.errorWithExit(`BSP ${bspName} not found. Please create it first.`)
    }

    // Load and validate the BSP YAML configuration
    // This must be done early so that BSP scripts are available for all build steps
    BSPYamlValidator.validateAndLoad(bspYamlPath, bspName)

    // ========================================
    // PREPARE BUILD DIRECTORIES
    // ========================================
    await prepareBuildDirectories()

    // ========================================
    // SMART BUILD CACHING SYSTEM
    // ========================================
    const manifest = await loadBuildCacheManifest(bspName)
    const cacheConfig = Settings.main?.build?.cache ?? { enabled: true }
    const cacheEnabled = cacheConfig.enabled !== false
    const forceRebuild = cacheConfig.force_rebuild ?? []
    const ignorePatterns = cacheConfig.ignore_patterns ?? []

    // Prepare Docker image with cache hash tracking
    const { imageHash, rebuilt: dockerRebuilt } = await Runner.prepareDockerImage(manifest.dockerImageHash)

    // If Docker image was rebuilt, invalidate all cached steps
    if (dockerRebuilt) {
        Logger.log("Docker image rebuilt, invalidating all cached steps...")
        manifest.steps = {}
    }

    // Update Docker image hash in manifest
    manifest.dockerImageHash = imageHash
    manifest.struxVersion = Settings.struxVersion
    await saveBuildCacheManifest(manifest, bspName)

    // Helper function to check if a step should be rebuilt
    async function checkStepCache(step: BuildStep): Promise<boolean> {
        if (!cacheEnabled) return true
        const result = await shouldRebuildStep(step, manifest, {
            forceRebuild,
            clean: Settings.clean,
            bspName,
            ignorePatterns
        })
        if (!result.rebuild) {
            Logger.cached(`${step} (no changes detected)`)
        } else if (result.reason) {
            Logger.debug(`Rebuilding ${step}: ${result.reason}`)
        }
        return result.rebuild
    }

    // Helper to update cache after step completion
    async function cacheStep(step: BuildStep): Promise<void> {
        if (!cacheEnabled) return
        await updateStepCache(step, manifest, { bspName, ignorePatterns })
    }

    // ========================================
    // BUILD LIFECYCLE: before_build
    // ========================================
    await runScriptsForStep("before_build", manifest)

    // ========================================
    // FRONTEND COMPILATION
    // ========================================
    await runScriptsForStep("before_frontend", manifest)
    if (await checkStepCache("frontend")) {
        await compileFrontend()
        await cacheStep("frontend")
    }
    await runScriptsForStep("after_frontend", manifest)

    // ========================================
    // APPLICATION COMPILATION (main.go)
    // ========================================
    await runScriptsForStep("before_application", manifest)
    if (await checkStepCache("application")) {
        await compileApplication()
        await cacheStep("application")
    }
    await runScriptsForStep("after_application", manifest)

    // ========================================
    // CAGE COMPOSITOR
    // ========================================
    await runScriptsForStep("before_cage", manifest)
    if (await checkStepCache("cage")) {
        await compileCage()
        await cacheStep("cage")
    }
    await runScriptsForStep("after_cage", manifest)

    // ========================================
    // WPE WEBKIT EXTENSION
    // ========================================
    await runScriptsForStep("before_wpe", manifest)
    if (await checkStepCache("wpe")) {
        await compileWPE()
        await cacheStep("wpe")
    }
    await runScriptsForStep("after_wpe", manifest)

    // ========================================
    // STRUX CLIENT BINARY
    // ========================================
    await runScriptsForStep("before_client", manifest)
    if (await checkStepCache("client")) {
        await buildStruxClient(isDevMode)
        await cacheStep("client")
    } else {
        // Even if cached, copy the binary over
        await copyClientBinaryIfExists(bspName)
    }
    await runScriptsForStep("after_client", manifest)

    // ========================================
    // KERNEL (Conditional: only if custom_kernel is enabled)
    // ========================================
    if (Settings.bsp?.boot?.kernel?.custom_kernel) {
        await runScriptsForStep("before_kernel", manifest)
        // TODO: Implement buildKernel() when custom kernel support is added
        await runScriptsForStep("after_kernel", manifest)
    }

    // ========================================
    // BOOTLOADER (Conditional: only if bootloader is enabled)
    // ========================================
    if (Settings.bsp?.boot?.bootloader?.enabled) {
        await runScriptsForStep("before_bootloader", manifest)
        // TODO: Implement buildBootloader() when bootloader support is added
        await runScriptsForStep("after_bootloader", manifest)
    }

    // ========================================
    // ROOT FILESYSTEM
    // ========================================
    await runScriptsForStep("before_rootfs", manifest)
    if (await checkStepCache("rootfs-base")) {
        await buildRootFS()
        await cacheStep("rootfs-base")
    }
    await runScriptsForStep("after_rootfs", manifest)

    // ========================================
    // ROOT FILESYSTEM POST-PROCESSING
    // ========================================
    if (await checkStepCache("rootfs-post")) {
        await postProcessRootFS()
        await cacheStep("rootfs-post")
    }

    // ========================================
    // FINAL IMAGE BUNDLING
    // ========================================
    await runScriptsForStep("before_bundle", manifest)
    await runScriptsForStep("make_image", manifest)

    // ========================================
    // BUILD LIFECYCLE: after_build
    // ========================================
    await runScriptsForStep("after_build", manifest)

    // ========================================
    // SAVE BUILD METADATA
    // ========================================
    const buildMetadata = {
        buildMode: isDevMode ? "dev" : "production",
        buildTime: new Date().toISOString(),
        bspName,
        struxVersion: Settings.struxVersion
    }
    await Bun.write(
        join(Settings.projectPath, "dist", "output", bspName, ".build-info.json"),
        JSON.stringify(buildMetadata, null, 2)
    )

    Logger.success("Build completed successfully!")
}

/**
 * Prepares the build directories with BSP-specific cache and output folders.
 * Also handles the --clean flag (cleans only the current BSP's cache).
 */
async function prepareBuildDirectories(): Promise<void> {
    const bspName = Settings.bspName!

    // If the clean flag is set, delete only this BSP's cache folder (preserves other BSPs)
    if (Settings.clean) {
        await rm(join(Settings.projectPath, "dist", "cache", bspName), { recursive: true, force: true })
    }

    // Create directories if they don't exist
    // - dist/cache/ is the shared cache root
    // - dist/cache/{bsp}/ is the BSP-specific cache
    // - dist/output/{bsp}/ is the BSP-specific output
    const dirs = [
        "dist",
        "dist/artifacts",
        "dist/cache",
        `dist/cache/${bspName}`,
        `dist/cache/${bspName}/app`,
        "dist/output",
        `dist/output/${bspName}`
    ]
    for (const dir of dirs) {
        const path = join(Settings.projectPath, dir)
        if (!directoryExists(path)) {
            await mkdir(path, { recursive: true })
        }
    }
}

/**
 * Copies the cached client binary to the standard location.
 * Used when the client step is cached but we still need the binary in the right place.
 */
async function copyClientBinaryIfExists(bspName: string): Promise<void> {
    // Client binary is now in BSP-specific cache folder
    const clientSrcPath = join(Settings.projectPath, "dist", "cache", bspName, "client")
    if (fileExists(clientSrcPath)) {
        // No need to copy since it's already in the correct location
        // This function now just validates the binary exists
        Logger.debug(`Client binary exists at ${clientSrcPath}`)
    }
}
