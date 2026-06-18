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
import { type ScriptStep } from "../../types/bsp-yaml"

// Build Caching System
import {
    loadBuildCacheManifest,
    saveBuildCacheManifest,
    shouldRebuildStep,
    updateStepCache,
    type BuildCacheManifest
} from "./cache"
import { type BuildStep } from "./cache-deps"

// Build Steps
import {
    compileFrontend,
    compileApplication,
    compileCage,
    compileWPE,
    compileScreen,
    buildRootFS,
    buildStruxClient,
    extractKernel,
    buildKernel,
    buildBootloader,
    postProcessRootFS,
    updateDevEnvConfig,
    writeDisplayConfig
} from "./steps"

// BSP Script Execution
import { runScriptsForStep } from "./bsp-scripts"

export interface BuildMetadata {
    buildMode: "dev" | "production"
    buildTime: string
    bspName: string
    struxVersion: string
}

export interface BuildLogger {
    log(message: string): void
    success(message: string): void
    debug(message: string): void
    cached(message: string): void
    errorWithExit(message: string): never
}

export interface BuildValidators {
    validateMainYAML(filePath?: string): unknown
    validateBSPYAML(filePath: string, bspName: string): unknown
}

export interface BuildFiles {
    fileExists(path: string): boolean
    prepareBuildDirectories(): Promise<void>
    writeBuildMetadata(bspName: string, metadata: BuildMetadata): Promise<void>
}

export interface BuildCache {
    loadBuildCacheManifest(bspName: string): Promise<BuildCacheManifest>
    saveBuildCacheManifest(manifest: BuildCacheManifest, bspName: string): Promise<void>
    shouldRebuildStep(
        step: BuildStep,
        manifest: BuildCacheManifest,
        options: {
            forceRebuild?: string[]
            clean?: boolean
            bspName: string
            ignorePatterns?: string[]
            skippedSteps?: BuildStep[]
        }
    ): ReturnType<typeof shouldRebuildStep>
    updateStepCache(
        step: BuildStep,
        manifest: BuildCacheManifest,
        options: {
            bspName: string
            ignorePatterns?: string[]
        }
    ): Promise<void>
}

export interface BuildSteps {
    compileFrontend(): Promise<void>
    compileApplication(): Promise<void>
    compileCage(): Promise<void>
    compileWPE(): Promise<void>
    compileScreen(): Promise<void>
    buildStruxClient(isDevMode: boolean): Promise<void>
    copyClientBinaryIfExists(bspName: string): Promise<void>
    extractKernel(): Promise<void>
    buildKernel(): Promise<void>
    buildBootloader(): Promise<void>
    buildRootFS(): Promise<void>
    writeDisplayConfig(bspName: string): Promise<void>
    postProcessRootFS(): Promise<void>
    updateDevEnvConfig(bspName: string): Promise<void>
}

export interface BuildScripts {
    runScriptsForStep(step: ScriptStep, manifest: BuildCacheManifest): Promise<boolean>
}

export interface BuildRunner {
    skipChown: boolean
    prepareDockerImage(cachedDockerHash?: string): Promise<{ imageHash: string; rebuilt: boolean }>
    chownProjectFiles(): Promise<void>
}

export interface BuildDeps {
    logger: BuildLogger
    validators: BuildValidators
    files: BuildFiles
    cache: BuildCache
    steps: BuildSteps
    scripts: BuildScripts
    runner: BuildRunner
    now(): Date
}

export const realBuildDeps: BuildDeps = {
    logger: Logger,
    validators: {
        validateMainYAML: (filePath?: string) => MainYAMLValidator.validateAndLoad(filePath),
        validateBSPYAML: (filePath: string, bspName: string) => BSPYamlValidator.validateAndLoad(filePath, bspName)
    },
    files: {
        fileExists,
        prepareBuildDirectories,
        writeBuildMetadata,
    },
    cache: {
        loadBuildCacheManifest,
        saveBuildCacheManifest,
        shouldRebuildStep,
        updateStepCache,
    },
    steps: {
        compileFrontend,
        compileApplication,
        compileCage,
        compileWPE,
        compileScreen,
        buildStruxClient,
        copyClientBinaryIfExists,
        extractKernel,
        buildKernel,
        buildBootloader,
        buildRootFS,
        writeDisplayConfig,
        postProcessRootFS,
        updateDevEnvConfig,
    },
    scripts: {
        runScriptsForStep,
    },
    runner: Runner,
    now: () => new Date(),
}

/**
 * Main build function - orchestrates the entire build pipeline.
 */
export async function build(): Promise<void> {
    await buildWithDeps(realBuildDeps)
}

/**
 * Build orchestration with injectable boundaries for tests.
 */
export async function buildWithDeps(deps: BuildDeps): Promise<void> {
    const isDevMode = Settings.isDevMode
    const bspName = Settings.bspName!

    // ========================================
    // VALIDATE CONFIGURATION FILES
    // ========================================
    // Ensure the strux.yaml file exists
    if (!deps.files.fileExists(join(Settings.projectPath, "strux.yaml"))) {
        return deps.logger.errorWithExit("strux.yaml file not found. Please create it first.")
    }

    // Load and validate the main Strux YAML configuration
    deps.validators.validateMainYAML()

    // Check if the BSP exists
    const bspYamlPath = join(Settings.projectPath, "bsp", bspName, "bsp.yaml")
    if (!deps.files.fileExists(bspYamlPath)) {
        return deps.logger.errorWithExit(`BSP ${bspName} not found. Please create it first.`)
    }

    // Load and validate the BSP YAML configuration
    // This must be done early so that BSP scripts are available for all build steps
    deps.validators.validateBSPYAML(bspYamlPath, bspName)

    // ========================================
    // PREPARE BUILD DIRECTORIES
    // ========================================
    await deps.files.prepareBuildDirectories()

    // ========================================
    // SMART BUILD CACHING SYSTEM
    // ========================================
    const manifest = await deps.cache.loadBuildCacheManifest(bspName)
    const cacheConfig = Settings.main?.build?.cache ?? { enabled: true }
    const cacheEnabled = cacheConfig.enabled !== false
    const forceRebuild = cacheConfig.force_rebuild ?? []
    const ignorePatterns = cacheConfig.ignore_patterns ?? []

    // Determine which steps are conditionally disabled
    const skippedSteps: BuildStep[] = []
    if (!Settings.bsp?.boot?.kernel?.custom_kernel) {
        skippedSteps.push("kernel")
    }
    if (!Settings.bsp?.boot?.bootloader?.enabled) {
        skippedSteps.push("bootloader")
    }

    // Prepare Docker image with cache hash tracking
    const { imageHash, rebuilt: dockerRebuilt } = await deps.runner.prepareDockerImage(manifest.dockerImageHash)

    // If Docker image was rebuilt, invalidate all cached steps
    if (dockerRebuilt) {
        deps.logger.log("Docker image rebuilt, invalidating all cached steps...")
        manifest.steps = {}
    }

    // Update Docker image hash in manifest
    manifest.dockerImageHash = imageHash
    manifest.struxVersion = Settings.struxVersion
    await deps.cache.saveBuildCacheManifest(manifest, bspName)

    // Helper function to check if a step should be rebuilt
    async function checkStepCache(step: BuildStep): Promise<boolean> {
        if (!cacheEnabled) return true
        const result = await deps.cache.shouldRebuildStep(step, manifest, {
            forceRebuild,
            clean: Settings.clean,
            bspName,
            ignorePatterns,
            skippedSteps
        })
        if (!result.rebuild) {
            deps.logger.cached(`${step} (no changes detected)`)
        } else if (result.reason) {
            deps.logger.debug(`Rebuilding ${step}: ${result.reason}`)
        }
        return result.rebuild
    }

    // Helper to update cache after step completion
    async function cacheStep(step: BuildStep): Promise<void> {
        if (!cacheEnabled) return
        await deps.cache.updateStepCache(step, manifest, { bspName, ignorePatterns })
    }

    // Skip per-step chown — we'll do a single chown at the end of the build
    deps.runner.skipChown = true

    // Track whether any build step actually ran (vs all cached)
    let anyStepRan = false

    // Wrapper that tracks whether any BSP script ran
    async function runBspScripts(step: ScriptStep) {
        if (await deps.scripts.runScriptsForStep(step, manifest)) {
            anyStepRan = true
        }
    }

    try {
        // ========================================
        // BUILD LIFECYCLE: before_build
        // ========================================
        await runBspScripts("before_build")

        // ========================================
        // FRONTEND COMPILATION
        // ========================================
        await runBspScripts("before_frontend")
        if (await checkStepCache("frontend")) {
            anyStepRan = true
            await deps.steps.compileFrontend()
            await cacheStep("frontend")
        }
        await runBspScripts("after_frontend")

        // ========================================
        // APPLICATION COMPILATION (main.go)
        // ========================================
        await runBspScripts("before_application")
        if (await checkStepCache("application")) {
            anyStepRan = true
            await deps.steps.compileApplication()
            await cacheStep("application")
        }
        await runBspScripts("after_application")

        // ========================================
        // CAGE COMPOSITOR
        // ========================================
        await runBspScripts("before_cage")
        if (await checkStepCache("cage")) {
            anyStepRan = true
            await deps.steps.compileCage()
            await cacheStep("cage")
        }
        await runBspScripts("after_cage")

        // ========================================
        // WPE WEBKIT EXTENSION AND COG
        // ========================================
        await runBspScripts("before_wpe")
        if (await checkStepCache("wpe")) {
            anyStepRan = true
            await deps.steps.compileWPE()
            await cacheStep("wpe")
        }
        await runBspScripts("after_wpe")

        // ========================================
        // SCREEN CAPTURE DAEMON
        // ========================================
        if (await checkStepCache("screen")) {
            anyStepRan = true
            await deps.steps.compileScreen()
            await cacheStep("screen")
        }

        // ========================================
        // STRUX CLIENT BINARY
        // ========================================
        await runBspScripts("before_client")
        if (await checkStepCache("client")) {
            anyStepRan = true
            await deps.steps.buildStruxClient(isDevMode)
            await cacheStep("client")
        } else {
            // Even if cached, copy the binary over
            await deps.steps.copyClientBinaryIfExists(bspName)
            // In dev mode, always update .dev-env.json even if client step is cached
            // This ensures inspector and other dev config changes are reflected immediately
            if (isDevMode) {
                await deps.steps.updateDevEnvConfig(bspName)
            }
        }
        await runBspScripts("after_client")

        // ========================================
        // KERNEL (Conditional: only if custom_kernel is enabled)
        // ========================================
        if (Settings.bsp?.boot?.kernel?.custom_kernel) {
            const hasCustomKernelScript = Settings.bsp?.scripts?.some(s => s.step === "custom_kernel") ?? false

            await runBspScripts("before_kernel")

            if (hasCustomKernelScript) {
                anyStepRan = true
                // Use BSP-provided custom kernel script instead of built-in
                await runBspScripts("custom_kernel")
            } else if (await checkStepCache("kernel")) {
                anyStepRan = true
                // Phase 1: Fetch source and apply patches
                await deps.steps.extractKernel()
                // Run after_kernel_extract hooks (e.g., install kernel boot logo)
                await runBspScripts("after_kernel_extract")
                // Phase 2: Configure, compile, and install
                await deps.steps.buildKernel()
                await cacheStep("kernel")
            }

            await runBspScripts("after_kernel")
        }

        // ========================================
        // BOOTLOADER (Conditional: only if bootloader is enabled)
        // ========================================
        if (Settings.bsp?.boot?.bootloader?.enabled) {
            const hasCustomBootloaderScript = Settings.bsp?.scripts?.some(s => s.step === "custom_bootloader") ?? false

            await runBspScripts("before_bootloader")

            if (hasCustomBootloaderScript) {
                anyStepRan = true
                // Use BSP-provided custom bootloader script instead of built-in
                await runBspScripts("custom_bootloader")
            } else {
                const bootloaderType = Settings.bsp?.boot?.bootloader?.type
                // Only run built-in build for u-boot and grub; custom/none skip
                if (bootloaderType && bootloaderType !== "custom" && bootloaderType !== "none") {
                    if (await checkStepCache("bootloader")) {
                        anyStepRan = true
                        await deps.steps.buildBootloader()
                        await cacheStep("bootloader")
                    }
                }
            }

            await runBspScripts("after_bootloader")
        }

        // ========================================
        // ROOT FILESYSTEM
        // ========================================
        await runBspScripts("before_rootfs")
        if (await checkStepCache("rootfs-base")) {
            anyStepRan = true
            await deps.steps.buildRootFS()
            await cacheStep("rootfs-base")
        }
        await runBspScripts("after_rootfs")

        // ========================================
        // ROOT FILESYSTEM POST-PROCESSING
        // ========================================
        // Always write display config before rootfs-post (like dev-env.json)
        await deps.steps.writeDisplayConfig(bspName)

        if (await checkStepCache("rootfs-post")) {
            anyStepRan = true
            await deps.steps.postProcessRootFS()
            await cacheStep("rootfs-post")
        }

        // ========================================
        // FINAL IMAGE BUNDLING
        // ========================================
        await runBspScripts("before_bundle")

        // Run BSP's make_image script(s)
        await runBspScripts("make_image")

        // ========================================
        // BUILD LIFECYCLE: after_build
        // ========================================
        await runBspScripts("after_build")

        // ========================================
        // SAVE BUILD METADATA
        // ========================================
        const buildMetadata = {
            buildMode: isDevMode ? "dev" : "production",
            buildTime: deps.now().toISOString(),
            bspName,
            struxVersion: Settings.struxVersion
        } satisfies BuildMetadata
        await deps.files.writeBuildMetadata(bspName, buildMetadata)

        deps.logger.success("Build completed successfully!")
    } finally {
        // Fix file permissions at the end if any build step ran.
        // Docker runs as root so all created files are root-owned on the host.
        // Skip if everything was cached — no Docker commands ran, so no files changed ownership.
        deps.runner.skipChown = false
        if (anyStepRan && !Settings.noChown) {
            await deps.runner.chownProjectFiles()
        }
    }
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

async function writeBuildMetadata(bspName: string, metadata: BuildMetadata): Promise<void> {
    await Bun.write(
        join(Settings.projectPath, "dist", "output", bspName, ".build-info.json"),
        JSON.stringify(metadata, null, 2)
    )
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
