/***
 *
 *  Main Entry Point
 *
 */

import { Command } from "commander"
import { join, resolve } from "path"
import { normalizeBuilderTag, Settings, type ArchType, type TemplateType } from "./settings"
import { STRUX_VERSION } from "./version"
import { Logger } from "./utils/log"
import { fileExists } from "./utils/path"
import { init } from "./commands/init"
import { build } from "./commands/build"
import { run } from "./commands/run"
import { dev } from "./commands/dev"
import { usb, usbAdd, usbList } from "./commands/usb"
import { kernelMenuconfig, kernelClean } from "./commands/kernel"
import { UpdateChecker } from "./updatecheck"

const program = new Command()

await UpdateChecker.checkForUpdates()

program
    .name("strux")
    .description("A Framework for Building Kiosk-Style Operating Systems")
    .version(STRUX_VERSION)
    .option("--verbose", "Enable verbose output")
    .option("--local-builder", "Build Docker image locally instead of pulling from GHCR")
    .option("--remote-builder <branch-or-tag>", "Pull a branch-scoped builder image from GHCR, e.g. feature/v0.3.0 -> feature-v0.3.0")
    .hook("preAction", (command: Command) => {

        const options = command.optsWithGlobals()

        if (options.verbose) {
            Settings.verbose = true
        }

        if (options.localBuilder) {
            Settings.localBuilder = true
        }

        if (options.remoteBuilder) {
            Settings.remoteBuilderTag = normalizeBuilderTag(options.remoteBuilder)
        }

    })


program.command("init")
    .description("Initialize a new Strux project")
    .argument("<project-name>", "The name of the project to create")
    .option("-t, --template <template>", "Frontend Template (vanilla, react, or vue)", "vanilla")
    .option("-a, --arch <arch>", "Target Architecture (host, arm64, x86_64, or armhf)", "host")
    .action(async (projectName: string, options: {template?: string, arch?: string}) => {
        try {
            Settings.template = (options.template ?? "vanilla") as TemplateType
            Settings.arch = (options.arch ?? "arm64") as ArchType
            Settings.projectName = projectName

            // Validate template
            if (!["vanilla", "react", "vue"].includes(Settings.template)) {
                Logger.error(`Invalid template: ${Settings.template}. Must be one of: vanilla, react, vue`)
                process.exit(1)
            }

            // Validate arch
            if (!["host", "arm64", "x86_64", "armhf"].includes(Settings.arch)) {
                Logger.error(`Invalid architecture: ${Settings.arch}. Must be one of: host, arm64, x86_64, armhf`)
                process.exit(1)
            }

            Logger.log(`Initializing Strux Project: ${projectName}`)
            await init()
        } catch (err) {
            Logger.error(`Init failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exit(1)
        }
    })


program.command("types")
    .description("Generate TypeScript type definitions from Go structs")
    .action(async () => {
        const { generateTypes } = await import("./commands/types")
        const cwd = process.cwd()
        const result = await generateTypes({
            mainGoPath: `${cwd}/main.go`,
            outputDir: `${cwd}/frontend/src`,
        })
        if (result.success) {
            console.log(`Generated ${result.methodCount} methods, ${result.fieldCount} fields`)
            console.log(`Output: ${result.outputPath}`)
        } else {
            Logger.error(result.error ?? "Unknown error")
            process.exit(1)
        }
    })


program.command("build")
    .description("Build a complete OS image for a BSP")
    .argument("<bsp>", "The board support package to build for")
    .option("--clean", "Clean the build cache before building")
    .option("--dev", "Build a development image")
    .option("--no-chown", "Skip file permission fixing after builds")
    .option("--local-runtime <path>", "Use a local strux repo for the Go runtime instead of the published module")
    .action(async (bspName: string, options: {clean?: boolean, dev?: boolean, chown?: boolean, localRuntime?: string}) => {

        try {
            Logger.title("Building Strux OS Image for BSP: " + bspName)
            Settings.bspName = bspName
            Settings.clean = options.clean ?? false
            Settings.isDevMode = options.dev ?? false
            Settings.noChown = options.chown === false
            Settings.localRuntime = options.localRuntime ? resolve(options.localRuntime) : null
            await build()
        } catch (err) {
            Logger.error(`Build failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exit(1)
        }


    })

program.command("run")
    .option("--debug", "Show console output and systemd messages")
    .option("--headless", "Run QEMU without opening a host display window")
    .description("Run the Strux OS Image in QEMU")
    .action(async (options: {debug?: boolean, headless?: boolean}) => {

        try {

            Logger.title("Running Strux OS Image in QEMU")
            Settings.qemuSystemDebug = options.debug ?? false
            Settings.qemuHeadless = options.headless ?? false
            await run()

        } catch (err) {

            Logger.errorWithExit(`Run failed: ${err instanceof Error ? err.message : String(err)}`)

        }


    })

program.command("dev")
    .description("Start the Strux OS development server")
    .option("--remote", "Run the development server to serve the project to a remote device (skips build and QEMU running)")
    .option("--clean", "Clean the build cache before building")
    .option("--debug", "Show device log streams")
    .option("--vite", "Show Vite dev server output")
    .option("--no-app-debug", "Disable app output streaming")
    .option("--no-rebuild", "Skip the initial build and use existing artifacts")
    .option("--no-chown", "Skip file permission fixing after builds")
    .option("--local-runtime <path>", "Use a local strux repo for the Go runtime instead of the published module")
    .action(async (options: {remote?: boolean, clean?: boolean, debug?: boolean, vite?: boolean, appDebug?: boolean, rebuild?: boolean, chown?: boolean, localRuntime?: string}) => {

        try {

            Logger.title("Starting Strux OS Development Server")
            Settings.isRemoteOnly = options.remote ?? false
            Settings.clean = options.clean ?? false
            Settings.devDebug = options.debug ?? false
            Settings.devViteDebug = options.vite ?? false
            Settings.devAppDebug = options.appDebug ?? true
            Settings.noRebuild = options.rebuild === false
            Settings.noChown = options.chown === false
            Settings.localRuntime = options.localRuntime ? resolve(options.localRuntime) : null
            await dev()

        } catch (err) {

            Logger.errorWithExit(`Dev failed: ${err instanceof Error ? err.message : String(err)}`)

        }

    })


const USBCommand = program.command("usb")
    .description("Manage USB device passthrough configuration for QEMU")

USBCommand.command("add")
    .description("Auto-detect USB devices and add selected devices to strux.yaml")
    .action(async () => {

        try {

            Logger.title("Auto-detecting USB Devices for QEMU")
            await usbAdd()


        } catch (err) {

            Logger.errorWithExit(`USB add/detection failed: ${err instanceof Error ? err.message : String(err)}`)

        }


    })

USBCommand.command("list")
    .description("List configured USB devices and optionally remove selected devices")
    .action(async () => {
        try {
            Logger.title("Listing Configured USB Devices for QEMU")
            await usbList()
        } catch (err) {
            Logger.errorWithExit(`USB list failed: ${err instanceof Error ? err.message : String(err)}`)
        }
    })

USBCommand.action(async () => {

    try {


        Logger.title("Managing USB Devices for QEMU")
        await usb()

    } catch (err) {
        Logger.errorWithExit(`USB command failed: ${err instanceof Error ? err.message : String(err)}`)
    }

})

const KernelCommand = program.command("kernel")
    .description("Kernel configuration and management commands")

KernelCommand.command("menuconfig")
    .description("Open interactive kernel configuration menu (make menuconfig)")
    .option("--save", "Save the configuration as a fragment file")
    .action(async (options: { save?: boolean }) => {
        try {
            // Get BSP name from strux.yaml or require it as argument
            const { readFileSync } = await import("fs")
            const struxYamlPath = join(process.cwd(), "strux.yaml")
            if (fileExists(struxYamlPath)) {
                const struxYaml = Bun.YAML.parse(readFileSync(struxYamlPath, "utf-8")) as { bsp?: string }
                if (struxYaml.bsp) {
                    Settings.bspName = struxYaml.bsp
                }
            }

            if (!Settings.bspName) {
                Logger.errorWithExit("BSP name not found. Please specify in strux.yaml or use 'strux build <bsp>' first.")
            }

            Logger.title("Opening Kernel Menuconfig")
            await kernelMenuconfig({ save: options.save ?? false })
        } catch (err) {
            Logger.errorWithExit(`Kernel menuconfig failed: ${err instanceof Error ? err.message : String(err)}`)
        }
    })

KernelCommand.command("clean")
    .description("Clean kernel build artifacts")
    .option("--mode <mode>", "Clean mode: mrproper (default), clean, or full", "mrproper")
    .action(async (options: { mode?: string }) => {
        try {
            // Get BSP name from strux.yaml
            const { readFileSync } = await import("fs")
            const struxYamlPath = join(process.cwd(), "strux.yaml")
            if (fileExists(struxYamlPath)) {
                const struxYaml = Bun.YAML.parse(readFileSync(struxYamlPath, "utf-8")) as { bsp?: string }
                if (struxYaml.bsp) {
                    Settings.bspName = struxYaml.bsp
                }
            }

            if (!Settings.bspName) {
                Logger.errorWithExit("BSP name not found. Please specify in strux.yaml or use 'strux build <bsp>' first.")
            }

            // Validate mode
            const validModes = ["mrproper", "clean", "full"]
            const mode = options.mode ?? "mrproper"
            if (!validModes.includes(mode)) {
                Logger.errorWithExit(`Invalid clean mode: ${mode}. Must be one of: ${validModes.join(", ")}`)
            }

            Logger.title("Cleaning Kernel Build")
            await kernelClean({ mode: mode as "mrproper" | "clean" | "full" })
        } catch (err) {
            Logger.errorWithExit(`Kernel clean failed: ${err instanceof Error ? err.message : String(err)}`)
        }
    })

program.parse()
