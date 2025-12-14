/***
 *
 *
 *  Main Entry Point for the Application
 *
 */

import { Command } from "commander"
import { build } from "./tools/build"
import { setVerbose, error, title, info } from "./utils/colors"
import { init, detectArch, type TemplateType, type ArchType } from "./tools/init"
import { bspAdd, bspList, bspRemove, bspInfo, bspInit } from "./tools/bsp"
import { usb, usbAdd, usbList } from "./tools/usb"
import { STRUX_VERSION } from "./version"

const program = new Command()

program
    .name("strux")
    .description("A Framework for building Kiosk-Style operating systems")
    .version(STRUX_VERSION)
    .option("--verbose", "Enable verbose output")
    .hook("preAction", (thisCommand) => {
        const opts = thisCommand.opts()
        if (opts.verbose) {
            setVerbose(true)
        }
    })

program.command("build")
    .argument("<bsp>", "The Board Support Package to build for")
    .option("--clean", "Clean the build cache before building")
    .description("Build the Strux OS image for a specific BSP")
    .action(async (bspName: string, options: { clean?: boolean }) => {
        try {
            title(`Building Strux OS Image for ${bspName}`)
            await build(bspName, { clean: options.clean ?? false })
        } catch (err) {
            error(`Build failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exit(1)
        }
    })

program.command("types")
    .description("Generate TypeScript type definitions from Go structs")
    .action(async () => {
        const { generateTypes } = await import("./tools/types")
        const cwd = process.cwd()
        const result = await generateTypes({
            mainGoPath: `${cwd}/main.go`,
            outputDir: `${cwd}/frontend`,
        })
        if (result.success) {
            console.log(`Generated ${result.methodCount} methods, ${result.fieldCount} fields`)
            console.log(`Output: ${result.outputPath}`)
        } else {
            error(result.error ?? "Unknown error")
            process.exit(1)
        }
    })

program.command("clean")
    .description("Clean the build cache")
    .action(async () => {
        const { clean } = await import("./tools/build")
        try {
            await clean()
        } catch (err) {
            error(`Clean failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exit(1)
        }
    })

program.command("run")
    .description("Run the Strux OS in QEMU emulator")
    .option("--debug", "Show console output and systemd messages")
    .action(async (options: { debug?: boolean }) => {
        const { run } = await import("./tools/run")
        try {
            await run({ systemDebug: options.debug ?? false })
        } catch (err) {
            error(`Run failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exit(1)
        }
    })

program.command("dev")
    .argument("[bsp]", "The Board Support Package to use (default: qemu)", "qemu")
    .option("--clean", "Clean the dev build cache before building")
    .option("--debug", "Show console output and systemd messages")
    .description("Start Strux OS in dev mode with hot-reload")
    .action(async (bspName: string, options: { clean?: boolean; debug?: boolean }) => {
        const { dev } = await import("./tools/dev")
        try {
            await dev(bspName, { clean: options.clean ?? false, debug: options.debug ?? false })
        } catch (err) {
            error(`Dev failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exit(1)
        }
    })

const usbCmd = program.command("usb")
    .description("USB device helpers")

usbCmd.command("add")
    .description("Auto-detect USB devices and add selected devices to strux.json")
    .action(async () => {
        try {
            await usbAdd()
        } catch (err) {
            error(`USB detection failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exit(1)
        }
    })

usbCmd.command("list")
    .description("List configured USB devices and optionally remove them")
    .action(async () => {
        try {
            await usbList()
        } catch (err) {
            error(`USB list failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exit(1)
        }
    })

usbCmd
    .action(async () => {
        try {
            await usb()
        } catch (err) {
            error(`USB detection failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exit(1)
        }
    })

// Init command
program.command("init")
    .argument("<project-name>", "Name of the project to create")
    .option("-t, --template <template>", "Frontend template (vanilla, react, vue)", "vanilla")
    .option("-a, --arch <arch>", "Target architecture (arm64, x86_64)")
    .description("Initialize a new Strux project")
    .action(async (projectName: string, options: { template?: string; arch?: string }) => {
        try {
            const template = (options.template ?? "vanilla") as TemplateType
            const arch = (options.arch ?? detectArch()) as ArchType

            // Validate template
            if (!["vanilla", "react", "vue"].includes(template)) {
                error(`Invalid template: ${template}. Must be one of: vanilla, react, vue`)
                process.exit(1)
            }

            // Validate arch
            if (!["arm64", "x86_64"].includes(arch)) {
                error(`Invalid architecture: ${arch}. Must be one of: arm64, x86_64`)
                process.exit(1)
            }

            title(`Initializing Strux Project: ${projectName}`)
            await init(projectName, { template, arch })
        } catch (err) {
            error(`Init failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exit(1)
        }
    })

// BSP commands
const bsp = program.command("bsp")
    .description("Board Support Package management")

bsp.command("add")
    .argument("<source>", "Git URL or local path to the BSP")
    .option("--set", "Set as active BSP after adding")
    .description("Add a BSP from a git repository or local path")
    .action(async (source: string, options: { set?: boolean }) => {
        try {
            await bspAdd(source, options)
        } catch (err) {
            error(`BSP add failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exit(1)
        }
    })

bsp.command("list")
    .description("List all available BSPs")
    .action(async () => {
        try {
            await bspList()
        } catch (err) {
            error(`BSP list failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exit(1)
        }
    })

bsp.command("remove")
    .argument("<name>", "Name of the BSP to remove")
    .description("Remove a BSP")
    .action(async (name: string) => {
        try {
            await bspRemove(name)
        } catch (err) {
            error(`BSP remove failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exit(1)
        }
    })

bsp.command("info")
    .argument("<name>", "Name of the BSP to show info for")
    .description("Show detailed information about a BSP")
    .action(async (name: string) => {
        try {
            await bspInfo(name)
        } catch (err) {
            error(`BSP info failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exit(1)
        }
    })

bsp.command("init")
    .argument("<name>", "Name of the BSP to create")
    .option("-a, --arch <arch>", "Target architecture (arm64, amd64)")
    .description("Initialize a new BSP skeleton")
    .action(async (name: string, options: { arch?: string }) => {
        try {
            await bspInit(name, options)
        } catch (err) {
            error(`BSP init failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exit(1)
        }
    })

program.parse()
