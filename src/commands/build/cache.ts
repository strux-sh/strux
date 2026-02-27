/***
 *
 *
 *  Build Cache Management
 *
 *  Core caching logic for the smart build system. Handles:
 *  - Loading/saving cache manifests
 *  - Computing dependency hashes
 *  - Determining if steps need rebuilding
 *  - Updating cache after step completion
 *
 */

import { join } from "path"
import { readFileSync, readdirSync, statSync } from "fs"
import { Settings } from "../../settings"
import { fileExists, directoryExists } from "../../utils/path"
import { Logger } from "../../utils/log"
import { type BuildStep, STEP_DEPENDENCIES, resolvePlaceholders, type StepDependency } from "./cache-deps"
import { computeInternalAssetHashes, getDockerfileHash } from "./internal-hashes"

// =========================================================================
// CACHE MANIFEST TYPES
// =========================================================================

/**
 * Cache entry for a single build step
 */
export interface StepCacheEntry {
    lastRun: string                          // ISO timestamp
    dependencies: Record<string, string>     // dependency key -> hash
    artifacts: string[]                      // list of output artifacts (relative to dist/)
    artifactChecksum?: string                // combined hash of all artifacts
}

/**
 * Cache entry for BSP scripts (backwards compatible with existing system)
 */
export interface ScriptCacheEntry {
    lastRun: string
    dependencyHashes: Record<string, string>
    generatedArtifacts: string[]
    scriptHash: string
}

/**
 * Full build cache manifest structure
 */
export interface BuildCacheManifest {
    version: string
    dockerImageHash?: string
    struxVersion?: string
    steps: Record<string, StepCacheEntry>
    bspScripts: Record<string, ScriptCacheEntry>
}

const CACHE_MANIFEST_VERSION = "2.0"

// =========================================================================
// MANIFEST I/O
// =========================================================================

/**
 * Gets the path to the build cache manifest (per-BSP)
 */
function getCacheManifestPath(bspName: string): string {
    return join(Settings.projectPath, "dist", "cache", bspName, ".build-cache.json")
}

/**
 * Loads the build cache manifest from disk (per-BSP).
 * Returns an empty manifest if file doesn't exist or is invalid.
 * Also migrates from old .script-cache.json format if needed.
 */
export async function loadBuildCacheManifest(bspName: string): Promise<BuildCacheManifest> {
    const manifestPath = getCacheManifestPath(bspName)
    const oldManifestPath = join(Settings.projectPath, "dist", "cache", ".script-cache.json")

    // Try to load new manifest first
    if (fileExists(manifestPath)) {
        try {
            const content = await Bun.file(manifestPath).text()
            const manifest = JSON.parse(content) as BuildCacheManifest

            // Check version compatibility
            if (manifest.version !== CACHE_MANIFEST_VERSION) {
                Logger.debug("Cache manifest version mismatch, resetting cache")
                return createEmptyManifest()
            }

            return manifest
        } catch {
            Logger.debug("Failed to parse cache manifest, resetting cache")
            return createEmptyManifest()
        }
    }

    // Try to migrate from old format
    if (fileExists(oldManifestPath)) {
        try {
            const content = await Bun.file(oldManifestPath).text()
            const oldManifest = JSON.parse(content)

            // Migrate scripts to bspScripts
            const newManifest = createEmptyManifest()
            if (oldManifest.scripts) {
                newManifest.bspScripts = oldManifest.scripts
            }

            Logger.debug("Migrated from old .script-cache.json format")
            return newManifest
        } catch {
            Logger.debug("Failed to migrate old cache manifest")
        }
    }

    return createEmptyManifest()
}

/**
 * Creates an empty cache manifest
 */
function createEmptyManifest(): BuildCacheManifest {
    return {
        version: CACHE_MANIFEST_VERSION,
        steps: {},
        bspScripts: {}
    }
}

/**
 * Saves the build cache manifest to disk (per-BSP)
 */
export async function saveBuildCacheManifest(manifest: BuildCacheManifest, bspName: string): Promise<void> {
    const manifestPath = getCacheManifestPath(bspName)
    // Ensure the BSP cache directory exists
    const cacheDir = join(Settings.projectPath, "dist", "cache", bspName)
    const { mkdir } = await import("node:fs/promises")
    await mkdir(cacheDir, { recursive: true })
    await Bun.write(manifestPath, JSON.stringify(manifest, null, 2))
}

// =========================================================================
// HASH COMPUTATION
// =========================================================================

/**
 * Computes SHA256 hash of a file's contents.
 * Returns null if file doesn't exist.
 */
export async function computeFileHash(filePath: string): Promise<string | null> {
    if (!fileExists(filePath)) return null

    try {
        const file = Bun.file(filePath)
        const buffer = await file.arrayBuffer()
        return Bun.hash(buffer).toString(16)
    } catch {
        return null
    }
}

/**
 * Computes a file hash, returning a stable hash even if the file is missing.
 * This lets cache invalidation detect removals of tracked files.
 */
async function computeFileHashOrMissing(filePath: string): Promise<string> {
    const hash = await computeFileHash(filePath)
    if (hash) return hash
    return Bun.hash(`missing:${filePath}`).toString(16)
}

/**
 * Computes a combined hash of all files in a directory (recursively).
 * Ignores common patterns like node_modules, .git, etc.
 */
async function computeDirectoryHash(
    dirPath: string,
    ignorePatterns: string[] = []
): Promise<string | null> {
    if (!directoryExists(dirPath)) return null

    const defaultIgnore = [
        "node_modules",
        ".git",
        ".DS_Store",
        "*.log"
    ]
    const allIgnore = [...defaultIgnore, ...ignorePatterns]

    try {
        const files = collectFilesRecursively(dirPath, allIgnore)
        if (files.length === 0) return null

        // Sort for deterministic ordering
        files.sort()

        // Compute hash of all file contents
        const hashes: string[] = []
        for (const file of files) {
            const hash = await computeFileHash(file)
            if (hash) {
                hashes.push(`${file}:${hash}`)
            }
        }

        return Bun.hash(hashes.join("\n")).toString(16)
    } catch {
        return null
    }
}

/**
 * Recursively collects all files in a directory
 */
function collectFilesRecursively(dir: string, ignorePatterns: string[]): string[] {
    const files: string[] = []

    try {
        const entries = readdirSync(dir, { withFileTypes: true })

        for (const entry of entries) {
            const fullPath = join(dir, entry.name)

            // Check if should ignore
            if (shouldIgnore(entry.name, ignorePatterns)) continue

            if (entry.isDirectory()) {
                files.push(...collectFilesRecursively(fullPath, ignorePatterns))
            } else if (entry.isFile()) {
                files.push(fullPath)
            }
        }
    } catch {
        // Directory might not exist or be inaccessible
    }

    return files
}

/**
 * Checks if a filename should be ignored
 */
function shouldIgnore(name: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
        if (pattern.startsWith("*")) {
            // Glob pattern like *.log
            const ext = pattern.slice(1)
            if (name.endsWith(ext)) return true
        } else if (name === pattern) {
            return true
        }
    }
    return false
}

/**
 * Extracts a value from a YAML file at a given dot-notation path
 */
function extractYamlValue(filePath: string, keyPath: string): string | null {
    if (!fileExists(filePath)) return null

    try {
        const content = readFileSync(filePath, "utf-8")
        const parsed = Bun.YAML.parse(content)

        // Navigate the path
        const parts = keyPath.split(".")
        let current: unknown = parsed

        for (const part of parts) {
            if (current === null || current === undefined) return null
            if (typeof current !== "object") return null
            current = (current as Record<string, unknown>)[part]
        }

        // Convert to string for hashing
        if (current === null || current === undefined) return null
        return JSON.stringify(current)
    } catch {
        return null
    }
}

/**
 * Extracts a raw value from a YAML file at a given dot-notation path
 */
function extractYamlValueRaw(filePath: string, keyPath: string): unknown | null {
    if (!fileExists(filePath)) return null

    try {
        const content = readFileSync(filePath, "utf-8")
        const parsed = Bun.YAML.parse(content)

        const parts = keyPath.split(".")
        let current: unknown = parsed

        for (const part of parts) {
            if (current === null || current === undefined) return null
            if (typeof current !== "object") return null
            current = (current as Record<string, unknown>)[part]
        }

        if (current === null || current === undefined) return null
        return current
    } catch {
        return null
    }
}

function normalizeYamlString(value: string): string {
    return value.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "")
}

function looksLikePath(value: string): boolean {
    if (value.includes("\n")) return false
    if (value.startsWith("./") || value.startsWith("/")) return true
    if (value.includes("/")) return true
    return /\.(dts|dtsi|dtb|dtbo|config|cfg|patch|bin|img|itb)$/i.test(value)
}

function resolveYamlPath(rawPath: string, bspName: string): string {
    const trimmed = normalizeYamlString(rawPath)
    if (trimmed.startsWith("/")) return trimmed
    if (trimmed.startsWith("./")) {
        return join(Settings.projectPath, "bsp", bspName, trimmed.slice(2))
    }
    if (trimmed.startsWith("bsp/") || trimmed.startsWith("dist/") || trimmed.startsWith("overlay/") || trimmed.startsWith("src/")) {
        return join(Settings.projectPath, trimmed)
    }
    return join(Settings.projectPath, "bsp", bspName, trimmed)
}

async function addYamlFileHash(
    hashes: Record<string, string>,
    yamlFile: string,
    keyPath: string,
    resolvedPath: string
): Promise<void> {
    const keyPathSuffix = resolvedPath.startsWith(Settings.projectPath)
        ? resolvedPath.slice(Settings.projectPath.length + 1)
        : resolvedPath
    const hash = await computeFileHashOrMissing(resolvedPath)
    hashes[`yaml-file:${yamlFile}:${keyPath}:${keyPathSuffix}`] = hash
}

/**
 * Computes all dependency hashes for a step
 */
export async function computeDependencyHashes(
    step: BuildStep,
    bspName: string,
    ignorePatterns: string[] = []
): Promise<Record<string, string>> {
    const deps = STEP_DEPENDENCIES[step]
    const hashes: Record<string, string> = {}
    const internalAssets = computeInternalAssetHashes()

    // Track which directories were found (for fallback logic)
    let foundDirectories = 0
    const totalDirectories = deps.directories?.length ?? 0

    // Hash individual files
    if (deps.files) {
        for (const file of deps.files) {
            const resolvedPath = resolvePlaceholders(file, bspName)
            const fullPath = join(Settings.projectPath, resolvedPath)
            const hash = await computeFileHashOrMissing(fullPath)
            hashes[`file:${resolvedPath}`] = hash
        }
    }

    // Hash directories
    if (deps.directories) {
        // Merge global ignore patterns with step-specific exclude patterns
        const stepExcludePatterns = deps.excludePatterns ?? []
        const allIgnorePatterns = [...ignorePatterns, ...stepExcludePatterns]

        for (const dir of deps.directories) {
            const resolvedPath = resolvePlaceholders(dir, bspName)
            const fullPath = join(Settings.projectPath, resolvedPath)

            if (directoryExists(fullPath)) {
                const hash = await computeDirectoryHash(fullPath, allIgnorePatterns)
                if (hash) {
                    hashes[`dir:${resolvedPath}`] = hash
                    foundDirectories++
                }
            }
        }
    }

    // Hash YAML keys
    if (deps.yamlKeys) {
        for (const yamlKey of deps.yamlKeys) {
            const resolvedFile = resolvePlaceholders(yamlKey.file, bspName)
            const fullPath = join(Settings.projectPath, resolvedFile)
            const value = extractYamlValue(fullPath, yamlKey.keyPath)
            if (value) {
                const hash = Bun.hash(value).toString(16)
                hashes[`yaml:${resolvedFile}:${yamlKey.keyPath}`] = hash
            }
        }
    }

    // Hash YAML-referenced files
    if (deps.yamlFileDependencies) {
        for (const yamlDep of deps.yamlFileDependencies) {
            const resolvedFile = resolvePlaceholders(yamlDep.file, bspName)
            const fullPath = join(Settings.projectPath, resolvedFile)
            const value = extractYamlValueRaw(fullPath, yamlDep.keyPath)
            if (value === null || value === undefined) continue

            const values = Array.isArray(value) ? value : [value]

            switch (yamlDep.mode) {
                case "file": {
                    for (const entry of values) {
                        if (typeof entry !== "string") continue
                        const raw = normalizeYamlString(entry)
                        if (!looksLikePath(raw)) continue
                        const resolved = resolveYamlPath(raw, bspName)
                        await addYamlFileHash(hashes, resolvedFile, yamlDep.keyPath, resolved)
                    }
                    break
                }
                case "file-list": {
                    for (const entry of values) {
                        if (typeof entry !== "string") continue
                        const raw = normalizeYamlString(entry)
                        if (!looksLikePath(raw)) continue
                        const resolved = resolveYamlPath(raw, bspName)
                        await addYamlFileHash(hashes, resolvedFile, yamlDep.keyPath, resolved)
                    }
                    break
                }
                case "file-or-inline-list": {
                    let idx = 0
                    for (const entry of values) {
                        if (typeof entry !== "string") continue
                        const raw = normalizeYamlString(entry)
                        if (looksLikePath(raw)) {
                            const resolved = resolveYamlPath(raw, bspName)
                            await addYamlFileHash(hashes, resolvedFile, yamlDep.keyPath, resolved)
                        } else {
                            const inlineHash = Bun.hash(`inline:${raw}`).toString(16)
                            hashes[`yaml-inline:${resolvedFile}:${yamlDep.keyPath}:${idx}`] = inlineHash
                        }
                        idx++
                    }
                    break
                }
                case "file-list-in-objects": {
                    const itemPath = yamlDep.itemPath
                    if (!itemPath) break
                    for (const entry of values) {
                        if (!entry || typeof entry !== "object") continue
                        const rawValue = (entry as Record<string, unknown>)[itemPath]
                        if (typeof rawValue !== "string") continue
                        const raw = normalizeYamlString(rawValue)
                        if (!looksLikePath(raw)) continue
                        const resolved = resolveYamlPath(raw, bspName)
                        await addYamlFileHash(hashes, resolvedFile, yamlDep.keyPath, resolved)
                    }
                    break
                }
            }
        }
    }

    // Hash internal assets (always included)
    if (deps.internalAssets) {
        for (const asset of deps.internalAssets) {
            const hash = internalAssets[asset]
            if (hash) {
                hashes[`internal:${asset}`] = hash
            }
        }
    }

    // Use fallback internal assets if primary directories don't exist yet
    // This handles first-build scenarios where files haven't been copied to dist/artifacts/ yet
    if (deps.fallbackInternalAssets && foundDirectories < totalDirectories) {
        for (const asset of deps.fallbackInternalAssets) {
            const hash = internalAssets[asset]
            if (hash) {
                hashes[`internal-fallback:${asset}`] = hash
            }
        }
    }

    return hashes
}

// =========================================================================
// CACHE DECISION LOGIC
// =========================================================================

export interface RebuildDecision {
    rebuild: boolean
    reason?: string
}

/**
 * Determines if a build step should be rebuilt based on cache state
 */
export async function shouldRebuildStep(
    step: BuildStep,
    manifest: BuildCacheManifest,
    options: {
        forceRebuild?: string[]
        clean?: boolean
        bspName: string
        ignorePatterns?: string[]
        skippedSteps?: BuildStep[]
    }
): Promise<RebuildDecision> {
    const { forceRebuild = [], clean = false, bspName, ignorePatterns = [], skippedSteps = [] } = options

    // 1. Clean build requested
    if (clean) {
        return { rebuild: true, reason: "clean build requested" }
    }

    // 2. Force rebuild configured for this step
    if (forceRebuild.includes(step)) {
        return { rebuild: true, reason: "force_rebuild configured" }
    }

    // 3. No cached entry exists
    const cached = manifest.steps[step]
    if (!cached) {
        return { rebuild: true, reason: "no cache entry" }
    }

    // 4. Check if all artifacts exist
    const deps = STEP_DEPENDENCIES[step]
    for (const artifact of deps.artifacts) {
        const resolvedArtifact = resolvePlaceholders(artifact, bspName)
        const artifactPath = join(Settings.projectPath, "dist", resolvedArtifact)

        // Handle directories (ending with /)
        if (resolvedArtifact.endsWith("/")) {
            if (!directoryExists(artifactPath)) {
                return { rebuild: true, reason: `artifact directory missing: ${resolvedArtifact}` }
            }
        } else {
            if (!fileExists(artifactPath)) {
                return { rebuild: true, reason: `artifact missing: ${resolvedArtifact}` }
            }
        }
    }

    // 5. Check if dependencies changed
    const currentHashes = await computeDependencyHashes(step, bspName, ignorePatterns)

    for (const [key, hash] of Object.entries(currentHashes)) {
        if (cached.dependencies[key] !== hash) {
            return { rebuild: true, reason: `dependency changed: ${key}` }
        }
    }

    // Check for removed dependencies (in cache but not in current)
    for (const key of Object.keys(cached.dependencies)) {
        if (!(key in currentHashes)) {
            return { rebuild: true, reason: `dependency removed: ${key}` }
        }
    }

    // 6. Check upstream steps (transitive invalidation)
    if (deps.dependsOnSteps) {
        for (const upstreamStep of deps.dependsOnSteps) {
            // Skip dependency check for conditionally disabled steps
            if (skippedSteps.includes(upstreamStep)) continue

            const upstreamCached = manifest.steps[upstreamStep]

            // If upstream has no cache, we can't determine if it changed
            if (!upstreamCached) {
                return { rebuild: true, reason: `upstream step not cached: ${upstreamStep}` }
            }

            // If upstream ran after this step, we need to rebuild
            if (new Date(upstreamCached.lastRun) > new Date(cached.lastRun)) {
                return { rebuild: true, reason: `upstream step rebuilt: ${upstreamStep}` }
            }
        }
    }

    // All checks passed - no rebuild needed
    return { rebuild: false }
}

/**
 * Updates the cache manifest after a step has run
 */
export async function updateStepCache(
    step: BuildStep,
    manifest: BuildCacheManifest,
    options: {
        bspName: string
        ignorePatterns?: string[]
    }
): Promise<void> {
    const { bspName, ignorePatterns = [] } = options
    const deps = STEP_DEPENDENCIES[step]

    // Compute current dependency hashes
    const currentHashes = await computeDependencyHashes(step, bspName, ignorePatterns)

    // Resolve artifact paths
    const artifacts = deps.artifacts.map(a => resolvePlaceholders(a, bspName))

    // Record the cache entry
    manifest.steps[step] = {
        lastRun: new Date().toISOString(),
        dependencies: currentHashes,
        artifacts
    }

    // Save the updated manifest
    await saveBuildCacheManifest(manifest, bspName)
}

// =========================================================================
// DOCKER IMAGE CACHE
// =========================================================================

/**
 * Checks if Docker image needs rebuilding based on Dockerfile hash
 */
export function shouldRebuildDockerImage(manifest: BuildCacheManifest): boolean {
    const currentHash = getDockerfileHash()
    return manifest.dockerImageHash !== currentHash
}

/**
 * Updates Docker image hash in manifest and invalidates all steps
 */
export async function handleDockerImageRebuild(
    manifest: BuildCacheManifest,
    wasRebuilt: boolean,
    bspName: string
): Promise<void> {
    const currentHash = getDockerfileHash()

    if (wasRebuilt) {
        // Clear all step caches (BSP scripts keep their own deps)
        manifest.steps = {}
        Logger.log("Docker image rebuilt, invalidating all cached steps...")
    }

    manifest.dockerImageHash = currentHash
    manifest.struxVersion = Settings.struxVersion
    await saveBuildCacheManifest(manifest, bspName)
}

// =========================================================================
// BSP SCRIPT CACHE (backwards compatible)
// =========================================================================

/**
 * Gets the cache key for a BSP script
 */
export function getBspScriptCacheKey(bspName: string, step: string, location: string): string {
    return `${bspName}/${step}/${location}`
}

/**
 * Gets a BSP script cache entry
 */
export function getBspScriptCache(
    manifest: BuildCacheManifest,
    cacheKey: string
): ScriptCacheEntry | undefined {
    return manifest.bspScripts[cacheKey]
}

/**
 * Updates a BSP script cache entry
 */
export async function updateBspScriptCache(
    manifest: BuildCacheManifest,
    cacheKey: string,
    entry: ScriptCacheEntry,
    bspName: string
): Promise<void> {
    manifest.bspScripts[cacheKey] = entry
    await saveBuildCacheManifest(manifest, bspName)
}
