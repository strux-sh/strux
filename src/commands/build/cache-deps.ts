/***
 *
 *
 *  Build Step Dependency Definitions
 *
 *  This file defines what files, directories, and configuration keys
 *  each build step depends on for cache invalidation purposes.
 *
 */

/**
 * All cacheable build steps
 */
export type BuildStep =
    | "frontend"
    | "application"
    | "cage"
    | "wpe"
    | "client"
    | "rootfs-base"
    | "rootfs-post"

/**
 * YAML key extraction configuration
 */
export interface YamlKeyDependency {
    /** Path to YAML file (supports {bsp} placeholder) */
    file: string
    /** Dot-notation path to the key (e.g., "dev.server" or "bsp.rootfs.packages") */
    keyPath: string
}

/**
 * Dependency specification for a build step
 */
export interface StepDependency {
    /** Individual files relative to project root */
    files?: string[]
    /** Directories to hash recursively (supports {bsp} placeholder) */
    directories?: string[]
    /**
     * Patterns to exclude when hashing directories for this step.
     * These are in addition to the global ignore patterns from cache config.
     */
    excludePatterns?: string[]
    /** YAML key paths to extract and hash */
    yamlKeys?: YamlKeyDependency[]
    /** Internal bundled assets (hashed from embedded content) */
    internalAssets?: string[]
    /**
     * Fallback internal assets - used only if the primary directories don't exist yet.
     * This handles first-build scenarios where files haven't been copied to dist/artifacts/ yet.
     */
    fallbackInternalAssets?: string[]
    /** Other steps this depends on (for ordering and transitive invalidation) */
    dependsOnSteps?: BuildStep[]
    /** Output artifacts relative to dist/ */
    artifacts: string[]
}

/**
 * Canonical source of truth for what each build step depends on.
 * The {bsp} placeholder is replaced with the actual BSP name at runtime.
 */
export const STEP_DEPENDENCIES: Record<BuildStep, StepDependency> = {
    frontend: {
        // Watch the entire frontend directory
        directories: ["frontend/"],
        excludePatterns: ["node_modules", "dist"],
        yamlKeys: [
            { file: "strux.yaml", keyPath: "dev" }
        ],
        internalAssets: ["@build-frontend-script"],
        // Frontend is architecture-agnostic, so it stays in shared cache (no {bsp} prefix)
        artifacts: ["cache/frontend/"]
    },

    application: {
        // Track the entire project folder for Go files
        directories: ["./"],
        // Exclude non-Go directories
        excludePatterns: [
            "frontend",
            "dist",
            "overlay",
            "bsp",
            "node_modules",
            "test",
            "strux.yaml"
        ],
        yamlKeys: [
            { file: "bsp/{bsp}/bsp.yaml", keyPath: "bsp.name" }
        ],
        internalAssets: ["@build-app-script"],
        // BSP-specific cache (architecture-dependent binary)
        artifacts: ["cache/{bsp}/app/main"]
    },

    cage: {
        // Cage sources are copied to dist/cage/ - track that directory
        directories: ["dist/cage/"],
        yamlKeys: [
            { file: "bsp/{bsp}/bsp.yaml", keyPath: "bsp.arch" }
        ],
        // Build script is internal, cage sources come from dist/cage/
        internalAssets: ["@build-cage-script"],
        // Fallback to internal assets if dist/cage/ doesn't exist yet (first build)
        fallbackInternalAssets: ["@cage-sources"],
        // BSP-specific cache (architecture-dependent binary)
        artifacts: ["cache/{bsp}/cage"]
    },

    wpe: {
        // WPE extension sources are copied to dist/extension/ - track that directory
        directories: ["dist/extension/"],
        yamlKeys: [
            { file: "bsp/{bsp}/bsp.yaml", keyPath: "bsp.arch" }
        ],
        // Build script is internal, extension sources come from dist/extension/
        internalAssets: ["@build-wpe-script"],
        // Fallback to internal assets if dist/extension/ doesn't exist yet (first build)
        fallbackInternalAssets: ["@wpe-extension-sources"],
        // BSP-specific cache (architecture-dependent .so)
        artifacts: ["cache/{bsp}/libstrux-extension.so"]
    },

    client: {
        // Client Go sources are copied to dist/artifacts/client/ on first build
        // After that, use those files (user can modify them)
        directories: ["dist/artifacts/client/"],
        yamlKeys: [
            { file: "strux.yaml", keyPath: "dev.server" },
            { file: "bsp/{bsp}/bsp.yaml", keyPath: "bsp.arch" }
        ],
        // Build script is internal, but client sources come from dist/artifacts/client/
        internalAssets: ["@build-client-script"],
        // Fallback to internal assets if dist/artifacts/client/ doesn't exist yet
        fallbackInternalAssets: ["@client-base"],
        // BSP-specific cache (architecture-dependent binary)
        artifacts: ["cache/{bsp}/client"]
    },

    "rootfs-base": {
        yamlKeys: [
            { file: "bsp/{bsp}/bsp.yaml", keyPath: "bsp.arch" },
            { file: "bsp/{bsp}/bsp.yaml", keyPath: "bsp.rootfs.packages" },
            { file: "strux.yaml", keyPath: "rootfs.packages" }
        ],
        internalAssets: ["@build-base-script"],
        // BSP-specific cache (arch + packages specific)
        artifacts: ["cache/{bsp}/rootfs-base.tar.gz"]
    },

    "rootfs-post": {
        files: ["dist/artifacts/logo.png"],
        directories: [
            // User project overlays
            "overlay/",
            "bsp/{bsp}/overlay/",
            // User-modifiable artifacts (written once, then user can customize)
            "dist/artifacts/plymouth/",
            "dist/artifacts/scripts/",
            "dist/artifacts/systemd/"
        ],
        yamlKeys: [
            { file: "strux.yaml", keyPath: "hostname" },
            { file: "strux.yaml", keyPath: "rootfs.overlay" },
            { file: "strux.yaml", keyPath: "boot.splash" },
            { file: "bsp/{bsp}/bsp.yaml", keyPath: "bsp.rootfs.overlay" },
            { file: "bsp/{bsp}/bsp.yaml", keyPath: "bsp.hostname" }
        ],
        dependsOnSteps: ["frontend", "application", "cage", "wpe", "client", "rootfs-base"],
        // Only the build script is internal - plymouth/systemd/init are user-modifiable in dist/artifacts/
        internalAssets: ["@build-post-script"],
        // Fallback to internal assets if dist/artifacts/ directories don't exist yet (first build)
        fallbackInternalAssets: ["@plymouth-assets", "@systemd-assets", "@init-scripts"],
        // BSP-specific cache
        artifacts: ["cache/{bsp}/rootfs-post.tar.gz", "cache/{bsp}/initrd.img", "cache/{bsp}/vmlinuz"]
    }
}

/**
 * Returns the list of artifacts for a step, with placeholders resolved
 */
export function getStepArtifacts(step: BuildStep, bspName: string): string[] {
    return STEP_DEPENDENCIES[step].artifacts.map(a => a.replace("{bsp}", bspName))
}

/**
 * Resolves placeholders in a path
 */
export function resolvePlaceholders(path: string, bspName: string): string {
    return path.replace(/\{bsp\}/g, bspName)
}

