/***
 *
 *
 *  Artifact Copying Utilities
 *
 *  Functions for copying bundled assets to dist/artifacts/
 *  These files are written once on first build, then users can modify them.
 *
 */

import { join } from "path"
import { Settings } from "../../settings"
import { fileExists } from "../../utils/path"
import { Logger } from "../../utils/log"

// Plymouth Files
//@ts-ignore
import artifactPlymouthTheme from "../../assets/scripts-base/artifacts/plymouth/strux.plymouth" with { type: "text" }
//@ts-ignore
import artifactPlymouthScript from "../../assets/scripts-base/artifacts/plymouth/strux.script" with { type: "text" }
//@ts-ignore
import artifactPlymouthConf from "../../assets/scripts-base/artifacts/plymouth/plymouthd.conf" with { type: "text" }

// Init Services
// @ts-ignore
import initScript from "../../assets/scripts-base/artifacts/scripts/init.sh" with { type: "text" }
//@ts-ignore
import initNetworkScript from "../../assets/scripts-base/artifacts/scripts/strux-network.sh" with { type: "text" }
//@ts-ignore
import initStruxScript from "../../assets/scripts-base/artifacts/scripts/strux.sh" with { type: "text" }
//@ts-ignore
import runCogScript from "../../assets/scripts-base/artifacts/scripts/strux-run-cog.sh" with { type: "text" }

// Systemd Services
// @ts-ignore
import systemdStruxService from "../../assets/scripts-base/artifacts/systemd/strux.service" with { type: "text" }
// @ts-ignore
import systemdNetworkService from "../../assets/scripts-base/artifacts/systemd/strux-network.service" with { type: "text" }
// @ts-ignore
import systemdEthernetNetwork from "../../assets/scripts-base/artifacts/systemd/20-ethernet.network" with { type: "text" }

// Not Configured HTML (for unconfigured monitor outputs)
// @ts-ignore
import notConfiguredHTML from "../../assets/scripts-base/artifacts/not-configured.html" with { type: "text" }

// Cog autoplay-policy patch (backported from cog 0.19.1)
// @ts-ignore
import cogAutoplayPatch from "../../assets/scripts-base/artifacts/patches/cog-autoplay-policy.patch" with { type: "text" }

// Default Logo
// @ts-ignore
import defaultLogoPNG from "../../assets/template-base/logo.png" with { type: "file" }

// Go Client-base files
// @ts-ignore
import clientGoMain from "../../assets/client-base/main.go" with { type: "text" }
// @ts-ignore
import clientGoBinary from "../../assets/client-base/binary.go" with { type: "text" }
// @ts-ignore
import clientGoCage from "../../assets/client-base/cage.go" with { type: "text" }
// @ts-ignore
import clientGoConfig from "../../assets/client-base/config.go" with { type: "text" }
// @ts-ignore
import clientGoHosts from "../../assets/client-base/hosts.go" with { type: "text" }
// @ts-ignore
import clientGoLogger from "../../assets/client-base/logger.go" with { type: "text" }
// @ts-ignore
import clientGoLogs from "../../assets/client-base/logs.go" with { type: "text" }
// @ts-ignore
import clientGoSocket from "../../assets/client-base/socket.go" with { type: "text" }
// @ts-ignore
import clientGoHelpers from "../../assets/client-base/helpers.go" with { type: "text" }
// @ts-ignore
import clientGoExec from "../../assets/client-base/exec.go" with { type: "text" }
// @ts-ignore
import clientGoWebsocket from "../../assets/client-base/websocket.go" with {type: "text"}
// @ts-ignore
import clientGoMod from "../../assets/client-base/go.mod" with { type: "text" }
// @ts-ignore
import clientGoSum from "../../assets/client-base/go.sum" with { type: "text" }

// ============================================================================
// Cage Wayland Compositor Source Files
// Source: src/assets/cage-base/
// ============================================================================
// @ts-ignore
import cageMain from "../../assets/cage-base/cage.c" with { type: "text" }
// @ts-ignore
import cageOutput from "../../assets/cage-base/output.c" with { type: "text" }
// @ts-ignore
import cageOutputH from "../../assets/cage-base/output.h" with { type: "text" }
// @ts-ignore
import cageSeat from "../../assets/cage-base/seat.c" with { type: "text" }
// @ts-ignore
import cageSeatH from "../../assets/cage-base/seat.h" with { type: "text" }
// @ts-ignore
import cageView from "../../assets/cage-base/view.c" with { type: "text" }
// @ts-ignore
import cageViewH from "../../assets/cage-base/view.h" with { type: "text" }
// @ts-ignore
import cageXdgShell from "../../assets/cage-base/xdg_shell.c" with { type: "text" }
// @ts-ignore
import cageXdgShellH from "../../assets/cage-base/xdg_shell.h" with { type: "text" }
// @ts-ignore
import cageXwayland from "../../assets/cage-base/xwayland.c" with { type: "text" }
// @ts-ignore
import cageXwaylandH from "../../assets/cage-base/xwayland.h" with { type: "text" }
// @ts-ignore
import cageIdleInhibit from "../../assets/cage-base/idle_inhibit_v1.c" with { type: "text" }
// @ts-ignore
import cageIdleInhibitH from "../../assets/cage-base/idle_inhibit_v1.h" with { type: "text" }
// @ts-ignore
import cageSplash from "../../assets/cage-base/splash.c" with { type: "text" }
// @ts-ignore
import cageSplashH from "../../assets/cage-base/splash.h" with { type: "text" }
// @ts-ignore
import cageServerH from "../../assets/cage-base/server.h" with { type: "text" }
// @ts-ignore
import cageConfigH from "../../assets/cage-base/config.h.in" with { type: "text" }
// @ts-ignore
import cageMesonBuild from "../../assets/cage-base/meson.build" with { type: "text" }
// @ts-ignore
import cageMesonOptions from "../../assets/cage-base/meson_options.txt" with { type: "text" }
// @ts-ignore
import cageLicense from "../../assets/cage-base/LICENSE" with { type: "text" }
// @ts-ignore
import cageManPage from "../../assets/cage-base/cage.1.scd" with { type: "text" }
// @ts-ignore
import cageReadme from "../../assets/cage-base/README.md" with { type: "text" }

// ============================================================================
// WPE WebKit Extension Source Files
// Source: src/assets/wpe-extension-base/
// ============================================================================
// @ts-ignore
import wpeExtensionC from "../../assets/wpe-extension-base/extension.c" with { type: "text" }
// @ts-ignore
import wpeExtensionCMake from "../../assets/wpe-extension-base/CMakeLists.txt" with { type: "text" }

/**
 * Copies Plymouth theme files to dist/artifacts/plymouth/ if they don't exist.
 * Files are only written on first build - users can modify them afterwards.
 */
export async function copyPlymouthArtifacts(): Promise<void> {
    const plymouthDir = join(Settings.projectPath, "dist", "artifacts", "plymouth")

    if (!fileExists(join(plymouthDir, "strux.plymouth"))) {
        await Bun.write(join(plymouthDir, "strux.plymouth"), artifactPlymouthTheme)
    }
    if (!fileExists(join(plymouthDir, "strux.script"))) {
        await Bun.write(join(plymouthDir, "strux.script"), artifactPlymouthScript)
    }
    if (!fileExists(join(plymouthDir, "plymouthd.conf"))) {
        await Bun.write(join(plymouthDir, "plymouthd.conf"), artifactPlymouthConf)
    }
}

/**
 * Copies init scripts to dist/artifacts/scripts/ if they don't exist.
 * Files are only written on first build - users can modify them afterwards.
 */
export async function copyInitScripts(): Promise<void> {
    const scriptsDir = join(Settings.projectPath, "dist", "artifacts", "scripts")

    if (!fileExists(join(scriptsDir, "init.sh"))) {
        await Bun.write(join(scriptsDir, "init.sh"), initScript)
    }
    if (!fileExists(join(scriptsDir, "strux-network.sh"))) {
        await Bun.write(join(scriptsDir, "strux-network.sh"), initNetworkScript)
    }
    if (!fileExists(join(scriptsDir, "strux.sh"))) {
        await Bun.write(join(scriptsDir, "strux.sh"), initStruxScript)
    }
    if (!fileExists(join(scriptsDir, "strux-run-cog.sh"))) {
        await Bun.write(join(scriptsDir, "strux-run-cog.sh"), runCogScript)
    }

    // Not-configured HTML page for unconfigured monitor outputs
    const artifactsDir = join(Settings.projectPath, "dist", "artifacts")
    if (!fileExists(join(artifactsDir, "not-configured.html"))) {
        await Bun.write(join(artifactsDir, "not-configured.html"), notConfiguredHTML)
    }
}

/**
 * Copies systemd service files to dist/artifacts/systemd/ if they don't exist.
 * Files are only written on first build - users can modify them afterwards.
 */
export async function copySystemdServices(): Promise<void> {
    const systemdDir = join(Settings.projectPath, "dist", "artifacts", "systemd")

    if (!fileExists(join(systemdDir, "strux.service"))) {
        await Bun.write(join(systemdDir, "strux.service"), systemdStruxService)
    }
    if (!fileExists(join(systemdDir, "strux-network.service"))) {
        await Bun.write(join(systemdDir, "strux-network.service"), systemdNetworkService)
    }
    if (!fileExists(join(systemdDir, "20-ethernet.network"))) {
        await Bun.write(join(systemdDir, "20-ethernet.network"), systemdEthernetNetwork)
    }
}

/**
 * Copies the boot splash logo to dist/artifacts/logo.png.
 * Uses the user-configured logo from strux.yaml, or falls back to default.
 */
export async function copyBootSplashLogo(): Promise<void> {
    // Check if splash is enabled and configured
    if (!Settings.main?.boot?.splash?.enabled) {
        return Logger.cached("Boot splash disabled, skipping logo copy")
    }

    const logoPath = Settings.main.boot.splash.logo
    if (!logoPath) {
        return Logger.cached("No logo path configured, skipping logo copy")
    }

    // Resolve the logo path relative to the project directory
    const normalizedLogoPath = logoPath.startsWith("./") ? logoPath.slice(2) : logoPath
    const sourceLogoPath = join(Settings.projectPath, normalizedLogoPath)
    const destLogoPath = join(Settings.projectPath, "dist", "artifacts", "logo.png")

    // Check if already copied and source hasn't changed
    if (fileExists(destLogoPath) && !Settings.clean && fileExists(sourceLogoPath)) {
        const sourceHash = Bun.hash(await Bun.file(sourceLogoPath).arrayBuffer())
        const destHash = Bun.hash(await Bun.file(destLogoPath).arrayBuffer())
        if (sourceHash === destHash) {
            return Logger.cached("Using existing logo.png")
        }
    }

    // Check if source logo file exists
    if (!fileExists(sourceLogoPath)) {
        Logger.error(`Logo file not found: ${sourceLogoPath}. Please check your strux.yaml configuration. Using a default logo.png instead...`)
        // For bundled binary files, we need to read from the bunfs path
        const defaultLogoFile = Bun.file(defaultLogoPNG)
        await Bun.write(destLogoPath, defaultLogoFile)
        return Logger.success("Using default logo.png")
    }

    // Copy the logo file to dist/artifacts/logo.png
    const logoFile = Bun.file(sourceLogoPath)
    await Bun.write(destLogoPath, logoFile)

    Logger.success("Custom Boot splash logo copied successfully")
}

/**
 * Copies Go client base files to dist/artifacts/client/ if they don't exist.
 * Files are only written on first build - users can modify them afterwards.
 */
export async function copyClientBaseFiles(clientSrcPath: string): Promise<void> {
    if (!fileExists(join(clientSrcPath, "main.go"))) {
        Logger.log("Copying Strux Client (Go) base files...")
        await Bun.write(join(clientSrcPath, "main.go"), clientGoMain)
        await Bun.write(join(clientSrcPath, "binary.go"), clientGoBinary)
        await Bun.write(join(clientSrcPath, "cage.go"), clientGoCage)
        await Bun.write(join(clientSrcPath, "config.go"), clientGoConfig)
        await Bun.write(join(clientSrcPath, "hosts.go"), clientGoHosts)
        await Bun.write(join(clientSrcPath, "logger.go"), clientGoLogger)
        await Bun.write(join(clientSrcPath, "logs.go"), clientGoLogs)
        await Bun.write(join(clientSrcPath, "socket.go"), clientGoSocket)
        await Bun.write(join(clientSrcPath, "helpers.go"), clientGoHelpers)
        await Bun.write(join(clientSrcPath, "exec.go"), clientGoExec)
        await Bun.write(join(clientSrcPath, "websocket.go"), clientGoWebsocket)
        await Bun.write(join(clientSrcPath, "go.mod"), clientGoMod)
        await Bun.write(join(clientSrcPath, "go.sum"), clientGoSum)
        return
    }

    if (!fileExists(join(clientSrcPath, "exec.go"))) {
        Logger.log("Adding missing exec.go to client base...")
        await Bun.write(join(clientSrcPath, "exec.go"), clientGoExec)
    }
}

/**
 * Copies Cage Wayland compositor source files to dist/artifacts/cage/ if they don't exist.
 * Files are only written on first build - users can modify them afterwards.
 */
export async function copyCageSourceFiles(cageSrcPath: string): Promise<void> {
    if (!fileExists(join(cageSrcPath, "cage.c"))) {
        Logger.log("Copying Cage compositor source files...")
        // Main source files
        await Bun.write(join(cageSrcPath, "cage.c"), cageMain)
        await Bun.write(join(cageSrcPath, "output.c"), cageOutput)
        await Bun.write(join(cageSrcPath, "output.h"), cageOutputH)
        await Bun.write(join(cageSrcPath, "seat.c"), cageSeat)
        await Bun.write(join(cageSrcPath, "seat.h"), cageSeatH)
        await Bun.write(join(cageSrcPath, "view.c"), cageView)
        await Bun.write(join(cageSrcPath, "view.h"), cageViewH)
        await Bun.write(join(cageSrcPath, "xdg_shell.c"), cageXdgShell)
        await Bun.write(join(cageSrcPath, "xdg_shell.h"), cageXdgShellH)
        await Bun.write(join(cageSrcPath, "xwayland.c"), cageXwayland)
        await Bun.write(join(cageSrcPath, "xwayland.h"), cageXwaylandH)
        await Bun.write(join(cageSrcPath, "idle_inhibit_v1.c"), cageIdleInhibit)
        await Bun.write(join(cageSrcPath, "idle_inhibit_v1.h"), cageIdleInhibitH)
        await Bun.write(join(cageSrcPath, "splash.c"), cageSplash)
        await Bun.write(join(cageSrcPath, "splash.h"), cageSplashH)
        await Bun.write(join(cageSrcPath, "server.h"), cageServerH)
        await Bun.write(join(cageSrcPath, "config.h.in"), cageConfigH)
        // Build files
        await Bun.write(join(cageSrcPath, "meson.build"), cageMesonBuild)
        await Bun.write(join(cageSrcPath, "meson_options.txt"), cageMesonOptions)
        await Bun.write(join(cageSrcPath, "LICENSE"), cageLicense)
        await Bun.write(join(cageSrcPath, "cage.1.scd"), cageManPage)
        await Bun.write(join(cageSrcPath, "README.md"), cageReadme)
    }
}

/**
 * Copies WPE WebKit extension source files to dist/artifacts/wpe-extension/ if they don't exist.
 * Files are only written on first build - users can modify them afterwards.
 */
export async function copyWPEExtensionSourceFiles(wpeExtSrcPath: string): Promise<void> {
    if (!fileExists(join(wpeExtSrcPath, "extension.c"))) {
        Logger.log("Copying WPE extension source files...")
        await Bun.write(join(wpeExtSrcPath, "extension.c"), wpeExtensionC)
        await Bun.write(join(wpeExtSrcPath, "CMakeLists.txt"), wpeExtensionCMake)
    }
}

/**
 * Copies patch files to dist/artifacts/patches/.
 * Always overwrites — patches are not user-modifiable.
 */
export async function copyPatches(): Promise<void> {
    const patchesDir = join(Settings.projectPath, "dist", "artifacts", "patches")

    const { mkdir } = await import("fs/promises")
    await mkdir(patchesDir, { recursive: true })

    await Bun.write(join(patchesDir, "cog-autoplay-policy.patch"), cogAutoplayPatch)
}

/**
 * Copies all initial artifacts needed for the build.
 * This includes init scripts, systemd services, and plymouth files.
 */
export async function copyAllInitialArtifacts(): Promise<void> {
    await copyInitScripts()
    await copySystemdServices()
    await copyPlymouthArtifacts()
    await copyBootSplashLogo()
    await copyPatches()
}

/**
 * Force-restores ALL artifacts to their built-in versions, overwriting any user modifications.
 * This writes every embedded file regardless of whether it already exists on disk.
 */
export async function forceRestoreAllArtifacts(): Promise<void> {
    const artifactsDir = join(Settings.projectPath, "dist", "artifacts")
    const plymouthDir = join(artifactsDir, "plymouth")
    const scriptsDir = join(artifactsDir, "scripts")
    const systemdDir = join(artifactsDir, "systemd")
    const clientSrcPath = join(artifactsDir, "client")
    const cageSrcPath = join(artifactsDir, "cage")
    const wpeExtSrcPath = join(artifactsDir, "wpe-extension")

    const patchesDir = join(artifactsDir, "patches")

    // Ensure all directories exist
    const { mkdir } = await import("fs/promises")
    await Promise.all([
        mkdir(plymouthDir, { recursive: true }),
        mkdir(scriptsDir, { recursive: true }),
        mkdir(systemdDir, { recursive: true }),
        mkdir(clientSrcPath, { recursive: true }),
        mkdir(cageSrcPath, { recursive: true }),
        mkdir(wpeExtSrcPath, { recursive: true }),
        mkdir(patchesDir, { recursive: true }),
    ])

    // Plymouth
    await Bun.write(join(plymouthDir, "strux.plymouth"), artifactPlymouthTheme)
    await Bun.write(join(plymouthDir, "strux.script"), artifactPlymouthScript)
    await Bun.write(join(plymouthDir, "plymouthd.conf"), artifactPlymouthConf)

    // Init scripts
    await Bun.write(join(scriptsDir, "init.sh"), initScript)
    await Bun.write(join(scriptsDir, "strux-network.sh"), initNetworkScript)
    await Bun.write(join(scriptsDir, "strux.sh"), initStruxScript)
    await Bun.write(join(scriptsDir, "strux-run-cog.sh"), runCogScript)

    // Not-configured HTML
    await Bun.write(join(artifactsDir, "not-configured.html"), notConfiguredHTML)

    // Systemd services
    await Bun.write(join(systemdDir, "strux.service"), systemdStruxService)
    await Bun.write(join(systemdDir, "strux-network.service"), systemdNetworkService)
    await Bun.write(join(systemdDir, "20-ethernet.network"), systemdEthernetNetwork)

    // Go client source files
    await Bun.write(join(clientSrcPath, "main.go"), clientGoMain)
    await Bun.write(join(clientSrcPath, "binary.go"), clientGoBinary)
    await Bun.write(join(clientSrcPath, "cage.go"), clientGoCage)
    await Bun.write(join(clientSrcPath, "config.go"), clientGoConfig)
    await Bun.write(join(clientSrcPath, "hosts.go"), clientGoHosts)
    await Bun.write(join(clientSrcPath, "logger.go"), clientGoLogger)
    await Bun.write(join(clientSrcPath, "logs.go"), clientGoLogs)
    await Bun.write(join(clientSrcPath, "socket.go"), clientGoSocket)
    await Bun.write(join(clientSrcPath, "helpers.go"), clientGoHelpers)
    await Bun.write(join(clientSrcPath, "exec.go"), clientGoExec)
    await Bun.write(join(clientSrcPath, "websocket.go"), clientGoWebsocket)
    await Bun.write(join(clientSrcPath, "go.mod"), clientGoMod)
    await Bun.write(join(clientSrcPath, "go.sum"), clientGoSum)

    // Cage compositor source files
    await Bun.write(join(cageSrcPath, "cage.c"), cageMain)
    await Bun.write(join(cageSrcPath, "output.c"), cageOutput)
    await Bun.write(join(cageSrcPath, "output.h"), cageOutputH)
    await Bun.write(join(cageSrcPath, "seat.c"), cageSeat)
    await Bun.write(join(cageSrcPath, "seat.h"), cageSeatH)
    await Bun.write(join(cageSrcPath, "view.c"), cageView)
    await Bun.write(join(cageSrcPath, "view.h"), cageViewH)
    await Bun.write(join(cageSrcPath, "xdg_shell.c"), cageXdgShell)
    await Bun.write(join(cageSrcPath, "xdg_shell.h"), cageXdgShellH)
    await Bun.write(join(cageSrcPath, "xwayland.c"), cageXwayland)
    await Bun.write(join(cageSrcPath, "xwayland.h"), cageXwaylandH)
    await Bun.write(join(cageSrcPath, "idle_inhibit_v1.c"), cageIdleInhibit)
    await Bun.write(join(cageSrcPath, "idle_inhibit_v1.h"), cageIdleInhibitH)
    await Bun.write(join(cageSrcPath, "splash.c"), cageSplash)
    await Bun.write(join(cageSrcPath, "splash.h"), cageSplashH)
    await Bun.write(join(cageSrcPath, "server.h"), cageServerH)
    await Bun.write(join(cageSrcPath, "config.h.in"), cageConfigH)
    await Bun.write(join(cageSrcPath, "meson.build"), cageMesonBuild)
    await Bun.write(join(cageSrcPath, "meson_options.txt"), cageMesonOptions)
    await Bun.write(join(cageSrcPath, "LICENSE"), cageLicense)
    await Bun.write(join(cageSrcPath, "cage.1.scd"), cageManPage)
    await Bun.write(join(cageSrcPath, "README.md"), cageReadme)

    // WPE extension source files
    await Bun.write(join(wpeExtSrcPath, "extension.c"), wpeExtensionC)
    await Bun.write(join(wpeExtSrcPath, "CMakeLists.txt"), wpeExtensionCMake)

    // Patches
    await Bun.write(join(patchesDir, "cog-autoplay-policy.patch"), cogAutoplayPatch)

    Logger.success("All artifacts restored to built-in versions")
}
