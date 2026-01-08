/***
 *
 *
 *  Build Command
 *
 */

import { Settings } from "../../settings"
import { Runner } from "../../utils/run"

// Scripts
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
import scriptBuildClient from "../../assets/scripts-base/strux-build-client.sh" with { type: "text" }


// Plymouth Files
//@ts-ignore
import artifactPlymouthTheme from "../../assets/scripts-base/artifacts/plymouth/strux.plymouth" with { type: "file" }
//@ts-ignore
import artifactPlymouthScript from "../../assets/scripts-base/artifacts/plymouth/strux.script" with { type: "file" }
//@ts-ignore
import artifactPlymouthConf from "../../assets/scripts-base/artifacts/plymouth/plymouthd.conf" with { type: "file" }

// Client-base files
// @ts-ignore
import clientBaseIndex from "../../assets/client-base/index.ts" with { type: "text" }
// @ts-ignore
import clientBaseBinary from "../../assets/client-base/binary.ts" with { type: "text" }
// @ts-ignore
import clientBaseCage from "../../assets/client-base/cage.ts" with { type: "text" }
// @ts-ignore
import clientBaseConfig from "../../assets/client-base/config.ts" with { type: "text" }
// @ts-ignore
import clientBaseHosts from "../../assets/client-base/hosts.ts" with { type: "text" }
// @ts-ignore
import clientBaseLogger from "../../assets/client-base/logger.ts" with { type: "text" }
// @ts-ignore
import clientBaseLogs from "../../assets/client-base/logs.ts" with { type: "text" }
// @ts-ignore
import clientBaseSocket from "../../assets/client-base/socket.ts" with { type: "text" }
// @ts-ignore
import clientBasePackageJson from "../../assets/client-base/package.json"
// @ts-ignore
import clientBaseTsConfig from "../../assets/client-base/tsconfig.json"


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


import { fileExists, directoryExists } from "../../utils/path"
import { join } from "path"
import { Logger } from "../../utils/log"
import { mkdir } from "node:fs/promises"

// YAML Validators
import { MainYAMLValidator } from "../../types/main-yaml"
import { BSPYamlValidator } from "../../types/bsp-yaml"

export async function build() {


}


async function compileFrontend() {

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
    })


}


async function compileApplication() {

    await Runner.runScriptInDocker(scriptBuildApp, {
        message: "Compiling Application...",
        messageOnError: "Failed to compile Application. Please check the build logs for more information.",
        exitOnError: true,
    })


}

async function compileCage() {


    if (fileExists(join(Settings.projectPath, "dist", "cache", "cage")) && !Settings.clean) return Logger.cached("Using Cage Binary")

    await Runner.runScriptInDocker(scriptBuildCage, {
        message: "Compiling Cage...",
        messageOnError: "Failed to compile Cage. Please check the build logs for more information.",
        exitOnError: true,
    })

}

async function compileWPE() {


    if (fileExists(join(Settings.projectPath, "dist", "cache", "libstrux-extension.so")) && !Settings.clean) return Logger.cached("Using WPE Extension Library")

    await Runner.runScriptInDocker(scriptBuildWPE, {
        message: "Compiling WPE Extension...",
        messageOnError: "Failed to compile WPE Extension. Please check the build logs for more information.",
        exitOnError: true,
    })


}

async function copyRootFSPlymouth() {

    if (fileExists(join(Settings.projectPath, "dist", "artifacts", "strux.plymouth")) && !Settings.clean) return Logger.cached("Using Plymouth Theme and Script")

    // Write the plymouth theme and script to the dist/artifacts folder
    await Bun.write(join(Settings.projectPath, "dist", "artifacts", "plymouth", "strux.plymouth"), artifactPlymouthTheme)
    await Bun.write(join(Settings.projectPath, "dist", "artifacts", "plymouth", "strux.script"), artifactPlymouthScript)
    await Bun.write(join(Settings.projectPath, "dist", "artifacts", "plymouth", "plymouthd.conf"), artifactPlymouthConf)

}

async function copyBootSplashLogo() {
    // Check if splash is enabled and configured
    if (!Settings.main?.boot?.splash?.enabled) {
        return Logger.cached("Boot splash disabled, skipping logo copy")
    }

    const logoPath = Settings.main.boot.splash.logo
    if (!logoPath) {
        return Logger.cached("No logo path configured, skipping logo copy")
    }

    // Resolve the logo path relative to the project directory
    // Remove leading ./ if present
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


async function buildRootFS(useQEMU = false) {


    // ensure the strux.yaml file exists
    if (!fileExists(join(Settings.projectPath, "strux.yaml"))) return Logger.errorWithExit("strux.yaml file not found. Please create it first.")

    // Load and Validate the Strux YAML into the Settings object
    const mainYAML = MainYAMLValidator.validateAndLoad()

    // Determine the BSP we are going to use
    const selectedBSP = useQEMU ? "qemu" : Settings.bspName!

    // Check if the bsp specified exists
    if (!fileExists(join(Settings.projectPath, "bsp", selectedBSP, "bsp.yaml"))) return Logger.errorWithExit(`BSP ${selectedBSP} not found. Please create it first.`)

    // Load and Validate the BSP YAML
    const bspYAML = BSPYamlValidator.validateAndLoad(join(Settings.projectPath, "bsp", selectedBSP, "bsp.yaml"), selectedBSP)


    // TODO: Build the root filesystem using the base script


}


async function buildStruxClient(addDevMode = false) {

    // This is a folder
    const clientSrcPath = join(Settings.projectPath, "dist", "artifacts", "client")

    // This is a file (client binary)
    const clientDestPath = join(Settings.projectPath, "dist", "cache", "client")

    // This is a file (dev environment config)
    const devEnvPath = join(Settings.projectPath, "dist", "cache", ".dev-env.json")

    // Check if already built and not cleaning
    if (fileExists(clientDestPath) && fileExists(devEnvPath) && !Settings.clean) {
        return Logger.cached("Using Strux Client and Dev Environment Configuration")
    }

    Logger.log("Copying Strux Client base files...")
    // Write all client-base files
    await Bun.write(join(clientSrcPath, "index.ts"), clientBaseIndex)
    await Bun.write(join(clientSrcPath, "binary.ts"), clientBaseBinary)
    await Bun.write(join(clientSrcPath, "cage.ts"), clientBaseCage)
    await Bun.write(join(clientSrcPath, "config.ts"), clientBaseConfig)
    await Bun.write(join(clientSrcPath, "hosts.ts"), clientBaseHosts)
    await Bun.write(join(clientSrcPath, "logger.ts"), clientBaseLogger)
    await Bun.write(join(clientSrcPath, "logs.ts"), clientBaseLogs)
    await Bun.write(join(clientSrcPath, "socket.ts"), clientBaseSocket)
    await Bun.write(join(clientSrcPath, "package.json"), JSON.stringify(clientBasePackageJson, null, 2))
    await Bun.write(join(clientSrcPath, "tsconfig.json"), JSON.stringify(clientBaseTsConfig, null, 2))

    Logger.log("Compiling Strux Client...")

    if (addDevMode) {

        const devEnvJSON = {
            clientKey: Settings.main?.dev?.server?.client_key ?? "",
            useMDNS: Settings.main?.dev?.server?.use_mdns_on_client ?? true,
            fallbackHosts: Settings.main?.dev?.server?.fallback_hosts ?? [],
        }

        // Write the JSON file to dist/cache/.dev-env.json
        await Bun.write(devEnvPath, JSON.stringify(devEnvJSON, null, 2))

    } else {


        // Remove the dev environment config file if it exists
        if (fileExists(devEnvPath)) await Bun.file(devEnvPath).delete()

    }

    // Install dependencies in the destination folder
    await Runner.runScriptInDocker(scriptBuildClient, {
        message: "Compiling Strux Client...",
        messageOnError: "Failed to compile Strux Client. Please check the build logs for more information.",
        exitOnError: true,
    })


    Logger.success("Strux Client built successfully")
}

async function postProcessRootFS(addDevMode = false) {


    // Copy init scripts to artifacts folder
    if (!fileExists(join(Settings.projectPath, "dist", "artifacts", "scripts", "init.sh"))) await Bun.write(join(Settings.projectPath, "dist", "artifacts", "scripts", "init.sh"), initScript)
    if (!fileExists(join(Settings.projectPath, "dist", "artifacts", "scripts", "strux-network.sh"))) await Bun.write(join(Settings.projectPath, "dist", "artifacts", "scripts", "strux-network.sh"), initNetworkScript)
    if (!fileExists(join(Settings.projectPath, "dist", "artifacts", "scripts", "strux.sh"))) await Bun.write(join(Settings.projectPath, "dist", "artifacts", "scripts", "strux.sh"), initStruxScript)

    // Copy Systemd services to artifacts folder
    if (!fileExists(join(Settings.projectPath, "dist", "artifacts", "systemd", "strux.service"))) await Bun.write(join(Settings.projectPath, "dist", "artifacts", "systemd", "strux.service"), systemdStruxService)
    if (!fileExists(join(Settings.projectPath, "dist", "artifacts", "systemd", "strux-network.service"))) await Bun.write(join(Settings.projectPath, "dist", "artifacts", "systemd", "strux-network.service"), systemdNetworkService)
    if (!fileExists(join(Settings.projectPath, "dist", "artifacts", "systemd", "20-ethernet.network"))) await Bun.write(join(Settings.projectPath, "dist", "artifacts", "systemd", "20-ethernet.network"), systemdEthernetNetwork)

    // TODO: Copy RootFS Plymouth
    await copyRootFSPlymouth()

    // Copy Boot Splash logo
    await copyBootSplashLogo()

    // TODO: Run post process script


    // NOTE: Need to have a conditional copy for strux dev watch services

}