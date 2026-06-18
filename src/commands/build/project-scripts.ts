/***
 *
 *
 *  Project Script Execution
 *
 *  Runs project-defined (strux.yaml `scripts:`) build scripts.
 *
 *  Unlike BSP scripts, project scripts run with a *managed* rootfs context:
 *  the harness extracts the assembled rootfs, mounts it for chroot, exposes a
 *  `run_in_chroot` helper plus the full build environment, runs the user
 *  script, and repacks rootfs-post.tar.gz in place. Script authors therefore
 *  only write the interesting part (drop a file in, chroot a command, etc.).
 *
 *  Currently the only supported step is `rootfs_post`, which runs after the
 *  built-in rootfs post-processing and before the BSP's bundle/make_image
 *  scripts — so downstream stages transparently pick up the changes.
 *
 *  NOTE: rootfs_post scripts must be idempotent (overwrite, don't append).
 *  When the rootfs-post cache is warm the script may run against a rootfs that
 *  already contains its own previous output.
 *
 */

import { join } from "path"
import { Settings } from "../../settings"
import { Runner } from "../../utils/run"
import { fileExists } from "../../utils/path"
import { Logger } from "../../utils/log"
import type { ProjectScript, ProjectScriptStep } from "../../types/main-yaml"
import {
    computeFileHash,
    getBspScriptCacheKey,
    getBspScriptCache,
    updateBspScriptCache,
    type BuildCacheManifest,
    type ScriptCacheEntry,
} from "./cache"

// Namespace used for project scripts in the (shared) script cache map so their
// keys never collide with a BSP that happens to use the same step/location.
const PROJECT_NS = "__project__"

/**
 * Resolves an artifact path (relative to dist/) to its absolute location.
 * Mirrors the BSP-script resolution: cache/ and output/ are BSP-specific.
 */
function resolveArtifactPath(artifact: string, bspName: string): string {
    if (artifact.startsWith("cache/")) {
        return join(Settings.projectPath, "dist", "cache", bspName, artifact.slice("cache/".length))
    }
    if (artifact.startsWith("output/")) {
        return join(Settings.projectPath, "dist", "output", bspName, artifact.slice("output/".length))
    }
    return join(Settings.projectPath, "dist", artifact)
}

/**
 * Resolves a dependency path.
 * - "./"-prefixed paths are relative to the project root.
 * - Other paths use artifact resolution (cache/{bsp}, output/{bsp}, dist/).
 */
function resolveDependencyPath(dep: string): string {
    if (dep.startsWith("./")) {
        return join(Settings.projectPath, dep.slice(2))
    }
    return resolveArtifactPath(dep, Settings.bspName!)
}

/**
 * Absolute host path of the project script file.
 */
function scriptHostPath(script: ProjectScript): string {
    return join(Settings.projectPath, script.location.replace(/^\.\//, ""))
}

/**
 * Checks whether a project script can be skipped via hash-based caching.
 * Same rules as BSP scripts: no declared artifacts => always run.
 */
async function shouldSkipProjectScript(
    script: ProjectScript,
    cacheKey: string,
    manifest: BuildCacheManifest
): Promise<boolean> {
    if (Settings.clean) return false

    const artifacts = script.cached_generated_artifacts ?? []
    if (artifacts.length === 0) return false

    const bspName = Settings.bspName!
    for (const artifact of artifacts) {
        if (!fileExists(resolveArtifactPath(artifact, bspName))) {
            Logger.debug(`Artifact missing: ${artifact}`)
            return false
        }
    }

    const cachedEntry = getBspScriptCache(manifest, cacheKey)
    if (!cachedEntry) {
        Logger.debug(`No cache entry found for: ${cacheKey}`)
        return false
    }

    const currentScriptHash = await computeFileHash(scriptHostPath(script))
    if (currentScriptHash !== cachedEntry.scriptHash) {
        Logger.log(`Script file changed: ${script.location}`)
        return false
    }

    for (const dep of script.depends_on ?? []) {
        const currentHash = await computeFileHash(resolveDependencyPath(dep))
        if (currentHash === null) {
            Logger.debug(`Dependency file not found, will run script: ${dep}`)
            return false
        }
        const cachedHash = cachedEntry.dependencyHashes[dep]
        if (cachedHash === undefined || currentHash !== cachedHash) {
            Logger.log(`Dependency changed: ${dep}`)
            return false
        }
    }

    return true
}

/**
 * Records the cache entry after a project script runs.
 */
async function updateProjectScriptCacheAfterRun(
    script: ProjectScript,
    cacheKey: string,
    manifest: BuildCacheManifest,
    bspName: string
): Promise<void> {
    const scriptHash = await computeFileHash(scriptHostPath(script)) ?? ""

    const dependencyHashes: Record<string, string> = {}
    for (const dep of script.depends_on ?? []) {
        const hash = await computeFileHash(resolveDependencyPath(dep))
        if (hash !== null) dependencyHashes[dep] = hash
    }

    const entry: ScriptCacheEntry = {
        lastRun: new Date().toISOString(),
        dependencyHashes,
        generatedArtifacts: script.cached_generated_artifacts ?? [],
        scriptHash,
    }

    await updateBspScriptCache(manifest, cacheKey, entry, bspName)
}

/**
 * Builds the full environment exposed to a project script. This mirrors the
 * BSP-script environment so project scripts get the complete variable set
 * (the path variables PROJECT_DIR/BSP_CACHE_DIR/etc. are added by the runner).
 */
function buildProjectScriptEnv(bspName: string, step: ProjectScriptStep): Record<string, string> {
    const env: Record<string, string> = {
        BSP_NAME: bspName,
        PRESELECTED_BSP: bspName,
        HOST_ARCH: Settings.arch!,
        TARGET_ARCH: Settings.targetArch!,
        STEP: step,
        STRUX_VERSION: Settings.struxVersion!,
        PROJECT_NAME: Settings.projectName,
        PROJECT_VERSION: Settings.projectVersion,
        STRUX_UPDATE_ENABLED: Settings.main?.update?.enabled ? "true" : "false",
    }

    const splash = Settings.main?.boot?.splash
    if (splash) {
        env.SPLASH_ENABLED = splash.enabled ? "true" : "false"
        if (splash.logo) env.SPLASH_LOGO = splash.logo
        if (splash.color) env.SPLASH_COLOR = splash.color
    }

    const display = Settings.bsp?.display
    if (display) {
        env.DISPLAY_WIDTH = String(display.width)
        env.DISPLAY_HEIGHT = String(display.height)
    }

    return env
}

/**
 * Generates the managed wrapper that runs a `rootfs_post` project script.
 *
 * It extracts rootfs-post.tar.gz, mounts it for chroot, exposes ROOTFS_DIR +
 * run_in_chroot, executes the user script as a child process (so its own
 * `exit` cannot skip the repack), unmounts, and — only on success — repacks
 * rootfs-post.tar.gz in place.
 *
 * `relLocation` is the project-root-relative path and is validated as a safe
 * relative path by the strux.yaml schema before reaching here.
 */
function buildRootfsPostWrapper(relLocation: string): string {
    return `
set -eo pipefail

ROOTFS_DIR="/tmp/rootfs"
BSP_CACHE="\${BSP_CACHE_DIR:-\${PROJECT_DIST_DIR:-/project/dist}/cache}"
ROOTFS_TAR="\$BSP_CACHE/rootfs-post.tar.gz"
USER_SCRIPT="\${PROJECT_DIR:-/project}/${relLocation}"

# ---------------------------------------------------------------------------
# Strux helpers — defined here and exported so the project script (run as a
# child process below) inherits them.
# ---------------------------------------------------------------------------

# strux_progress "message"  -> update the current step message in the CLI/UI.
strux_progress() { echo "STRUX_PROGRESS: \$*"; }

# strux_progress_bar "message" <percent>  -> render/advance a progress bar
# (percent is 0-100; a trailing % in the argument is tolerated).
strux_progress_bar() { echo "STRUX_PROGRESS_BAR: \$1 (\${2%\\%}%)"; }

# progress "message"  -> alias matching the built-in build scripts.
progress() { strux_progress "\$*"; }

# run_in_chroot "cmd"  (alias: strux_chroot)  -> run a command inside the rootfs.
run_in_chroot() { chroot "\$ROOTFS_DIR" /bin/bash -c "\$1"; }
strux_chroot() { run_in_chroot "\$1"; }

# strux_install_file <host-src> <abs-dest-in-image> [octal-mode]
# Copy a host file into the rootfs, creating parent dirs (mode default 0644).
strux_install_file() { install -D -m "\${3:-0644}" "\$1" "\$ROOTFS_DIR\$2"; }

export ROOTFS_DIR
export -f strux_progress strux_progress_bar progress run_in_chroot strux_chroot strux_install_file

if [ ! -f "\$ROOTFS_TAR" ]; then
    echo "Strux: rootfs-post.tar.gz not found at \$ROOTFS_TAR" >&2
    exit 1
fi
if [ ! -f "\$USER_SCRIPT" ]; then
    echo "Strux: project script not found at \$USER_SCRIPT" >&2
    exit 1
fi

progress "Extracting rootfs for project script..."
rm -rf "\$ROOTFS_DIR"
mkdir -p "\$ROOTFS_DIR"
tar -xzf "\$ROOTFS_TAR" -C "\$ROOTFS_DIR"

mount --bind /dev "\$ROOTFS_DIR/dev" || true
mount --bind /dev/pts "\$ROOTFS_DIR/dev/pts" || true
mount --bind /proc "\$ROOTFS_DIR/proc" || true
mount --bind /sys "\$ROOTFS_DIR/sys" || true

# Cross-arch chroot support (so run_in_chroot works on a foreign-arch rootfs).
if [ "\$HOST_ARCH" != "\$TARGET_ARCH" ]; then
    if [ "\$TARGET_ARCH" = "arm64" ] && [ -f /usr/bin/qemu-aarch64-static ]; then
        cp /usr/bin/qemu-aarch64-static "\$ROOTFS_DIR/usr/bin/" 2>/dev/null || true
    elif [ "\$TARGET_ARCH" = "armhf" ] && [ -f /usr/bin/qemu-arm-static ]; then
        cp /usr/bin/qemu-arm-static "\$ROOTFS_DIR/usr/bin/" 2>/dev/null || true
    fi
fi

unmount_rootfs() {
    umount "\$ROOTFS_DIR/sys" 2>/dev/null || true
    umount "\$ROOTFS_DIR/proc" 2>/dev/null || true
    umount "\$ROOTFS_DIR/dev/pts" 2>/dev/null || true
    umount "\$ROOTFS_DIR/dev" 2>/dev/null || true
}

progress "Running project script: ${relLocation}"
set +e
/bin/bash "\$USER_SCRIPT"
USER_RC=\$?
set -e

unmount_rootfs

if [ "\$USER_RC" -ne 0 ]; then
    echo "Strux: project script '${relLocation}' failed (exit \$USER_RC); rootfs not repacked." >&2
    exit "\$USER_RC"
fi

progress "Repacking rootfs-post.tar.gz..."
rm -f "\$ROOTFS_TAR"
( cd "\$ROOTFS_DIR" && tar -czf "\$ROOTFS_TAR" . )
`
}

/**
 * Runs all project scripts registered for a given step. Returns true if any
 * script actually executed (i.e. was not skipped by the cache).
 */
export async function runProjectScriptsForStep(
    step: ProjectScriptStep,
    manifest: BuildCacheManifest
): Promise<boolean> {
    const scripts = (Settings.main?.scripts ?? []).filter(s => (s.step ?? "rootfs_post") === step)
    if (scripts.length === 0) return false

    const bspName = Settings.bspName!
    let didRun = false

    for (const script of scripts) {
        const scriptName = script.description ?? script.location
        const cacheKey = getBspScriptCacheKey(PROJECT_NS, step, script.location)

        if (await shouldSkipProjectScript(script, cacheKey, manifest)) {
            Logger.cached(`Skipping project script: ${scriptName}`)
            continue
        }

        const hostPath = scriptHostPath(script)
        if (!fileExists(hostPath)) {
            Logger.errorWithExit(`Project script ${hostPath} (step "${step}") not found. Please create it first.`)
        }

        const relLocation = script.location.replace(/^\.\//, "")
        const wrapper = buildRootfsPostWrapper(relLocation)
        const env = buildProjectScriptEnv(bspName, step)

        didRun = true
        await Runner.runScriptInDocker(wrapper, {
            message: `Running project script: ${scriptName} (${step})...`,
            messageOnError: `Failed to run project script "${scriptName}" for step "${step}". Please check the build logs for more information.`,
            exitOnError: true,
            env,
        })

        await updateProjectScriptCacheAfterRun(script, cacheKey, manifest, bspName)
        Logger.success(`Completed project script: ${scriptName}`)
    }

    return didRun
}
