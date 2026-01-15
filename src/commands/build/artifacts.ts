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
import artifactPlymouthTheme from "../../assets/scripts-base/artifacts/plymouth/strux.plymouth" with { type: "file" }
//@ts-ignore
import artifactPlymouthScript from "../../assets/scripts-base/artifacts/plymouth/strux.script" with { type: "file" }
//@ts-ignore
import artifactPlymouthConf from "../../assets/scripts-base/artifacts/plymouth/plymouthd.conf" with { type: "file" }

// Init Services
// @ts-ignore
import initScript from "../../assets/scripts-base/artifacts/scripts/init.sh" with { type: "text" }
//@ts-ignore
import initNetworkScript from "../../assets/scripts-base/artifacts/scripts/strux-network.sh" with { type: "text" }
//@ts-ignore
import initStruxScript from "../../assets/scripts-base/artifacts/scripts/strux.sh" with { type: "text" }

// Systemd Services
// @ts-ignore
import systemdStruxService from "../../assets/scripts-base/artifacts/systemd/strux.service" with { type: "text" }
// @ts-ignore
import systemdNetworkService from "../../assets/scripts-base/artifacts/systemd/strux-network.service" with { type: "text" }
// @ts-ignore
import systemdEthernetNetwork from "../../assets/scripts-base/artifacts/systemd/20-ethernet.network" with { type: "text" }

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
import clientGoWebsocket from "../../assets/client-base/websocket.go" with {type: "text"}
// @ts-ignore
import clientGoMod from "../../assets/client-base/go.mod" with { type: "text" }
// @ts-ignore
import clientGoSum from "../../assets/client-base/go.sum" with { type: "text" }

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

    // Check if already copied and not cleaning
    if (fileExists(destLogoPath) && !Settings.clean) {
        return Logger.cached("Using existing logo.png")
    }

    // Check if source logo file exists
    if (!fileExists(sourceLogoPath)) {
        Logger.error(`Logo file not found: ${sourceLogoPath}. Please check your strux.yaml configuration. Using a default logo.png instead...`)
        await Bun.write(destLogoPath, defaultLogoPNG)
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
        await Bun.write(join(clientSrcPath, "websocket.go"), clientGoWebsocket)
        await Bun.write(join(clientSrcPath, "go.mod"), clientGoMod)
        await Bun.write(join(clientSrcPath, "go.sum"), clientGoSum)
    }
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
}

