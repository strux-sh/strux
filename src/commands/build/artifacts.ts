/***
 *
 *
 *  Artifact Copying Utilities
 *
 *  Regenerates dist/artifacts/ from the bundled assets. As of v0.4.0 this is
 *  fully derived build state — wiped and rewritten on every build so it always
 *  matches the running CLI. Genuine customization lives in overlays and
 *  strux.yaml, not here (see regenerateArtifacts).
 *
 */

import { dirname, join } from "path"
import { mkdir as mkdirp, rm } from "fs/promises"
import { Settings } from "../../settings"
import { fileExists } from "../../utils/path"
import { Logger } from "../../utils/log"

// Dockerfile (for Docker builder image)
// @ts-ignore
import scriptsBaseDockerfile from "../../assets/scripts-base/Dockerfile" with { type: "text" }

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
import systemdUsbnetService from "../../assets/scripts-base/artifacts/systemd/strux-usbnet.service" with { type: "text" }
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
import clientDevConnectPNG from "../../assets/client-base/assets/dev-connect.png" with { type: "file" }
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
import clientGoUpdate from "../../assets/client-base/update.go" with { type: "text" }
// @ts-ignore
import clientGoHelpers from "../../assets/client-base/helpers.go" with { type: "text" }
// @ts-ignore
import clientGoExec from "../../assets/client-base/exec.go" with { type: "text" }
// @ts-ignore
import clientGoWebsocket from "../../assets/client-base/websocket.go" with {type: "text"}
// @ts-ignore
import clientGoScreen from "../../assets/client-base/screen.go" with { type: "text" }
// @ts-ignore
import clientGoUSBNet from "../../assets/client-base/usbnet.go" with { type: "text" }
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

// ============================================================================
// Screen Capture Daemon Source Files
// Source: src/assets/screen-base/
// ============================================================================
// @ts-ignore
import screenMainC from "../../assets/screen-base/main.c" with { type: "text" }
// @ts-ignore
import screenCaptureC from "../../assets/screen-base/capture.c" with { type: "text" }
// @ts-ignore
import screenCaptureH from "../../assets/screen-base/capture.h" with { type: "text" }
// @ts-ignore
import screenPipelineC from "../../assets/screen-base/pipeline.c" with { type: "text" }
// @ts-ignore
import screenPipelineH from "../../assets/screen-base/pipeline.h" with { type: "text" }
// @ts-ignore
import screenInputC from "../../assets/screen-base/input.c" with { type: "text" }
// @ts-ignore
import screenInputH from "../../assets/screen-base/input.h" with { type: "text" }
// @ts-ignore
import screenMesonBuild from "../../assets/screen-base/meson.build" with { type: "text" }
// @ts-ignore
import screenProtocolXml from "../../assets/screen-base/protocols/wlr-screencopy-unstable-v1.xml" with { type: "text" }
// @ts-ignore
import screenProtocolVirtualPointerXml from "../../assets/screen-base/protocols/wlr-virtual-pointer-unstable-v1.xml" with { type: "text" }
// @ts-ignore
import screenProtocolVirtualKeyboardXml from "../../assets/screen-base/protocols/virtual-keyboard-unstable-v1.xml" with { type: "text" }

// ----------------------------------------------------------------------------
// Artifact manifest — the SINGLE source of truth for everything written into
// dist/artifacts/. Add a file here and it is regenerated on every build; there
// is no second list to keep in sync. The old write-once copies + a separate
// force-restore list drifting apart is exactly what silently stranded new files
// like strux-usbnet.service. Paths are relative to dist/artifacts/.
// ----------------------------------------------------------------------------
const ARTIFACT_FILES: readonly (readonly [string, string])[] = [
    // Plymouth boot splash theme
    ["plymouth/strux.plymouth", artifactPlymouthTheme],
    ["plymouth/strux.script", artifactPlymouthScript],
    ["plymouth/plymouthd.conf", artifactPlymouthConf],

    // Init + lifecycle scripts
    ["scripts/init.sh", initScript],
    ["scripts/strux-network.sh", initNetworkScript],
    ["scripts/strux.sh", initStruxScript],
    ["scripts/strux-run-cog.sh", runCogScript],

    // systemd units
    ["systemd/strux.service", systemdStruxService],
    ["systemd/strux-usbnet.service", systemdUsbnetService],
    ["systemd/strux-network.service", systemdNetworkService],
    ["systemd/20-ethernet.network", systemdEthernetNetwork],

    // Standalone files
    ["not-configured.html", notConfiguredHTML],
    ["Dockerfile", scriptsBaseDockerfile],

    // Go client source
    ["client/main.go", clientGoMain],
    ["client/binary.go", clientGoBinary],
    ["client/cage.go", clientGoCage],
    ["client/config.go", clientGoConfig],
    ["client/hosts.go", clientGoHosts],
    ["client/logger.go", clientGoLogger],
    ["client/logs.go", clientGoLogs],
    ["client/socket.go", clientGoSocket],
    ["client/update.go", clientGoUpdate],
    ["client/helpers.go", clientGoHelpers],
    ["client/exec.go", clientGoExec],
    ["client/screen.go", clientGoScreen],
    ["client/usbnet.go", clientGoUSBNet],
    ["client/websocket.go", clientGoWebsocket],
    ["client/go.mod", clientGoMod],
    ["client/go.sum", clientGoSum],

    // Cage Wayland compositor source
    ["cage/cage.c", cageMain],
    ["cage/output.c", cageOutput],
    ["cage/output.h", cageOutputH],
    ["cage/seat.c", cageSeat],
    ["cage/seat.h", cageSeatH],
    ["cage/view.c", cageView],
    ["cage/view.h", cageViewH],
    ["cage/xdg_shell.c", cageXdgShell],
    ["cage/xdg_shell.h", cageXdgShellH],
    ["cage/xwayland.c", cageXwayland],
    ["cage/xwayland.h", cageXwaylandH],
    ["cage/idle_inhibit_v1.c", cageIdleInhibit],
    ["cage/idle_inhibit_v1.h", cageIdleInhibitH],
    ["cage/splash.c", cageSplash],
    ["cage/splash.h", cageSplashH],
    ["cage/server.h", cageServerH],
    ["cage/config.h.in", cageConfigH],
    ["cage/meson.build", cageMesonBuild],
    ["cage/meson_options.txt", cageMesonOptions],
    ["cage/LICENSE", cageLicense],
    ["cage/cage.1.scd", cageManPage],
    ["cage/README.md", cageReadme],

    // WPE WebKit extension source
    ["wpe-extension/extension.c", wpeExtensionC],
    ["wpe-extension/CMakeLists.txt", wpeExtensionCMake],

    // Screen capture daemon source
    ["screen/main.c", screenMainC],
    ["screen/capture.c", screenCaptureC],
    ["screen/capture.h", screenCaptureH],
    ["screen/pipeline.c", screenPipelineC],
    ["screen/pipeline.h", screenPipelineH],
    ["screen/input.c", screenInputC],
    ["screen/input.h", screenInputH],
    ["screen/meson.build", screenMesonBuild],
    ["screen/protocols/wlr-screencopy-unstable-v1.xml", screenProtocolXml],
    ["screen/protocols/wlr-virtual-pointer-unstable-v1.xml", screenProtocolVirtualPointerXml],
    ["screen/protocols/virtual-keyboard-unstable-v1.xml", screenProtocolVirtualKeyboardXml],

    // Build patches (applied to upstream sources inside the build container)
    ["patches/cog-autoplay-policy.patch", cogAutoplayPatch],
]

// Binary artifacts: [dest path relative to dist/artifacts/, embedded file path].
const ARTIFACT_BINARY_FILES: readonly (readonly [string, string])[] = [
    ["client/assets/dev-connect.png", clientDevConnectPNG],
]

/**
 * Regenerates dist/artifacts/ from the embedded assets.
 *
 * dist/artifacts/ is fully DERIVED build state, never user state: it is wiped
 * and rewritten on every build so it always matches the running CLI version.
 * This is a v0.4.0 breaking change from the old write-once model, where a stale
 * copy could shadow a CLI fix, or a newly added file (e.g. strux-usbnet.service)
 * could silently never appear. Genuine customization belongs in overlays
 * (overlay/, bsp/<bsp>/overlay/) and strux.yaml — not here.
 */
export async function regenerateArtifacts(): Promise<void> {
    const artifactsDir = join(Settings.projectPath, "dist", "artifacts")

    // Wipe first so renamed/removed framework files never linger across versions.
    await rm(artifactsDir, { recursive: true, force: true })

    for (const [relativePath, contents] of ARTIFACT_FILES) {
        const dest = join(artifactsDir, relativePath)
        await mkdirp(dirname(dest), { recursive: true })
        await Bun.write(dest, contents)
    }

    for (const [relativePath, sourcePath] of ARTIFACT_BINARY_FILES) {
        const dest = join(artifactsDir, relativePath)
        await mkdirp(dirname(dest), { recursive: true })
        await Bun.write(dest, Bun.file(sourcePath))
    }

    // The boot logo comes from strux.yaml (user config), not the embedded set —
    // regenerate it after the wipe so a configured splash survives.
    await copyBootSplashLogo()

    Logger.success("Artifacts regenerated from built-in versions")
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
