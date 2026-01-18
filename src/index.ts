/***
 *
 *  Main Entry Point
 *
 */

import { Command } from "commander"
import { Settings, type ArchType, type TemplateType } from "./settings"
import { STRUX_VERSION } from "./version"
import { Logger } from "./utils/log"
import { init } from "./commands/init"
import { build } from "./commands/build"
import { run } from "./commands/run"
import { dev } from "./commands/dev"
import { usb, usbAdd, usbList } from "./commands/usb"

const program = new Command()

program
    .name("strux")
    .description("A Framework for Building Kiosk-Style Operating Systems")
    .version(STRUX_VERSION)
    .option("--verbose", "Enable verbose output")
    .hook("preAction", (command: Command) => {

        const options = command.opts()

        if (options.verbose) {

            // We enable verbose output
            Settings.verbose = true

        }


    })


program.command("init")
    .description("Initialize a new Strux project")
    .argument("<project-name>", "The name of the project to create")
    .option("-t, --template <template>", "Frontend Template (vanilla, react, or vue)", "vanilla")
    .option("-a, --arch <arch>", "Target Architecture (arm64, x86_64, or armhf)", "arm64")
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
            if (!["arm64", "x86_64", "armhf"].includes(Settings.arch)) {
                Logger.error(`Invalid architecture: ${Settings.arch}. Must be one of: arm64, x86_64, armhf`)
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
    .argument("<bsp>", "The board support package to build for")
    .option("--clean", "Clean the build cache before building")
    .option("--dev", "Build a development image")
    .action(async (bspName: string, options: {clean?: boolean, dev?: boolean}) => {

        try {
            Logger.title("Building Strux OS Image for BSP: " + bspName)
            Settings.bspName = bspName
            Settings.clean = options.clean ?? false
            Settings.isDevMode = options.dev ?? false
            await build()
        } catch (err) {
            Logger.error(`Build failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exit(1)
        }


    })

program.command("run")
    .option("--debug", "Show console output and systemd messages")
    .description("Run the Strux OS Image in QEMU")
    .action(async (options: {debug?: boolean}) => {

        try {

            Logger.title("Running Strux OS Image in QEMU")
            Settings.qemuSystemDebug = options.debug ?? false
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
    .action(async (options: {remote?: boolean, clean?: boolean, debug?: boolean, vite?: boolean}) => {

        try {

            Logger.title("Starting Strux OS Development Server")
            Settings.isRemoteOnly = options.remote ?? false
            Settings.clean = options.clean ?? false
            Settings.devDebug = options.debug ?? false
            Settings.devViteDebug = options.vite ?? false
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

program.parse()