/***
 *
 *
 *  BSP Script Execution
 *
 *  Functions for running BSP-defined build scripts with caching support.
 *
 */

import { join } from "path"
import { Settings } from "../../settings"
import { Runner } from "../../utils/run"
import { fileExists } from "../../utils/path"
import { Logger } from "../../utils/log"
import type { ScriptStep, BSPScript } from "../../types/bsp-yaml"
import {
    computeFileHash,
    getBspScriptCacheKey,
    getBspScriptCache,
    updateBspScriptCache,
    type BuildCacheManifest,
    type ScriptCacheEntry
} from "./cache"

/**
 * Resolves an artifact path to its absolute location.
 * - Paths starting with "cache/" are resolved to the BSP-specific cache (dist/cache/{bsp}/)
 * - Paths starting with "output/" are resolved to the BSP-specific output (dist/output/{bsp}/)
 * - Other paths are relative to dist/
 */
function resolveArtifactPath(artifact: string, bspName: string): string {
    // Handle BSP-specific cache paths (cache/xxx -> cache/{bsp}/xxx)
    if (artifact.startsWith("cache/")) {
        const subPath = artifact.slice("cache/".length)
        return join(Settings.projectPath, "dist", "cache", bspName, subPath)
    }

    // Handle BSP-specific output paths (output/xxx -> output/{bsp}/xxx)
    if (artifact.startsWith("output/")) {
        const subPath = artifact.slice("output/".length)
        return join(Settings.projectPath, "dist", "output", bspName, subPath)
    }

    // Other paths are relative to dist/
    return join(Settings.projectPath, "dist", artifact)
}

/**
 * Resolves a dependency path.
 * - Paths starting with "./" are relative to the BSP directory
 * - Other paths use the same resolution as artifacts (cache/{bsp}/, output/{bsp}/, etc.)
 */
function resolveDependencyPath(dep: string, bspDir: string): string {
    if (dep.startsWith("./")) {
        // Relative to BSP directory
        return join(bspDir, dep.slice(2))
    }

    // Use artifact path resolution for cache/output paths
    return resolveArtifactPath(dep, Settings.bspName!)
}

/**
 * Checks if a BSP script should be skipped based on caching conditions.
 * Uses SHA256 hashes for reliable cache invalidation.
 *
 * Returns true if the script can be skipped (all conditions met):
 * - All cached_generated_artifacts exist
 * - No depends_on file hashes have changed
 * - The script file itself hasn't changed
 */
async function shouldSkipBspScript(
    script: BSPScript,
    cacheKey: string,
    manifest: BuildCacheManifest
): Promise<boolean> {
    // Never skip if clean build is requested
    if (Settings.clean) return false

    const artifacts = script.cached_generated_artifacts ?? []

    // No artifacts declared = always run the script
    if (artifacts.length === 0) return false

    // Check if all artifacts exist
    const bspName = Settings.bspName!
    for (const artifact of artifacts) {
        const artifactPath = resolveArtifactPath(artifact, bspName)
        if (!fileExists(artifactPath)) {
            Logger.debug(`Artifact missing: ${artifact}`)
            return false
        }
    }

    // Get cached entry
    const cachedEntry = getBspScriptCache(manifest, cacheKey)
    if (!cachedEntry) {
        Logger.debug(`No cache entry found for: ${cacheKey}`)
        return false
    }

    // Check script file hash
    const bspDir = join(Settings.projectPath, "bsp", Settings.bspName!)
    const scriptPath = script.location.startsWith("./")
        ? join(bspDir, script.location.slice(2))
        : join(bspDir, script.location)

    const currentScriptHash = await computeFileHash(scriptPath)
    if (currentScriptHash !== cachedEntry.scriptHash) {
        Logger.log(`Script file changed: ${script.location}`)
        return false
    }

    // Check dependency hashes
    const dependencies = script.depends_on ?? []
    for (const dep of dependencies) {
        const depPath = resolveDependencyPath(dep, bspDir)
        const currentHash = await computeFileHash(depPath)

        if (currentHash === null) {
            // Dependency file not found - run the script to regenerate it
            Logger.debug(`Dependency file not found, will run script: ${depPath}`)
            return false
        }

        const cachedHash = cachedEntry.dependencyHashes[dep]
        if (cachedHash === undefined) {
            // No cached hash for this dependency - run the script
            Logger.debug(`No cached hash for dependency: ${dep}`)
            return false
        }

        if (currentHash !== cachedHash) {
            Logger.log(`Dependency changed: ${dep}`)
            return false
        }
    }

    // All checks passed - we can skip
    return true
}

/**
 * Updates the cache manifest after a BSP script has run.
 * Records the script hash, dependency hashes, and generated artifacts.
 */
async function updateBspScriptCacheAfterRun(
    script: BSPScript,
    cacheKey: string,
    manifest: BuildCacheManifest,
    bspName: string
): Promise<void> {
    // Compute script hash
    const bspDir = join(Settings.projectPath, "bsp", Settings.bspName!)
    const scriptPath = script.location.startsWith("./")
        ? join(bspDir, script.location.slice(2))
        : join(bspDir, script.location)

    const scriptHash = await computeFileHash(scriptPath) ?? ""

    // Compute dependency hashes
    const dependencyHashes: Record<string, string> = {}
    const dependencies = script.depends_on ?? []

    for (const dep of dependencies) {
        const depPath = resolveDependencyPath(dep, bspDir)
        const hash = await computeFileHash(depPath)
        if (hash !== null) {
            dependencyHashes[dep] = hash
        }
    }

    // Record the cache entry
    const entry: ScriptCacheEntry = {
        lastRun: new Date().toISOString(),
        dependencyHashes,
        generatedArtifacts: script.cached_generated_artifacts ?? [],
        scriptHash
    }

    await updateBspScriptCache(manifest, cacheKey, entry, bspName)
}

/**
 * Runs all BSP scripts registered for a given build step.
 * Uses SHA256 hash-based caching to skip scripts when their outputs exist
 * and no dependencies have changed.
 */
export async function runScriptsForStep(
    step: ScriptStep,
    manifest: BuildCacheManifest
): Promise<void> {
    // Get scripts for this step from the BSP configuration
    const scripts = Settings.bsp?.scripts?.filter(s => s.step === step) ?? []

    if (scripts.length === 0) return

    for (const script of scripts) {
        const scriptName = script.description ?? script.location
        const cacheKey = getBspScriptCacheKey(Settings.bspName!, step, script.location)

        // Check if we can skip this script using hash-based caching
        if (await shouldSkipBspScript(script, cacheKey, manifest)) {
            Logger.cached(`Skipping script: ${scriptName}`)
            continue
        }

        // Resolve the script path relative to the BSP directory
        const bspDir = join(Settings.projectPath, "bsp", Settings.bspName!)
        const scriptPath = script.location.startsWith("./")
            ? join(bspDir, script.location.slice(2))
            : join(bspDir, script.location)

        // Check if the script exists
        if (!fileExists(scriptPath)) {
            Logger.errorWithExit(`Script ${scriptPath} for "${Settings.bspName}" BSP and step "${step}" not found. Please create it first.`)
            return
        }

        // Read the script content
        const scriptContent = await Bun.file(scriptPath).text()

        const bspName = Settings.bspName!

        // Run the script in Docker
        await Runner.runScriptInDocker(scriptContent, {
            message: `Running BSP script: ${scriptName} (${step})...`,
            messageOnError: `Failed to run BSP script "${scriptName}" for step "${step}". Please check the build logs for more information.`,
            exitOnError: true,
            env: {
                BSP_NAME: bspName,
                PROJECT_FOLDER: "/project",
                PROJECT_DIST_FOLDER: "/project/dist",
                // BSP-specific cache and output directories
                PROJECT_DIST_CACHE_FOLDER: `/project/dist/cache/${bspName}`,
                PROJECT_DIST_OUTPUT_FOLDER: `/project/dist/output/${bspName}`,
                PROJECT_DIST_ARTIFACTS_FOLDER: "/project/dist/artifacts",
                // Also provide shared cache dir for cross-BSP artifacts like frontend
                SHARED_CACHE_DIR: "/project/dist/cache",
                BSP_CACHE_DIR: `/project/dist/cache/${bspName}`,
                HOST_ARCH: Settings.arch!,
                TARGET_ARCH: Settings.targetArch!,
                STEP: step,
                STRUX_VERSION: Settings.struxVersion!
            }
        })

        // Update the cache manifest with the new script execution
        await updateBspScriptCacheAfterRun(script, cacheKey, manifest, bspName)

        Logger.success(`Completed BSP script: ${scriptName}`)
    }
}

