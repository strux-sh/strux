/***
 *
 *
 * Init Command
 *
 */

// Main
import { Settings } from "../../settings"
import { Logger } from "../../utils/log"
import { Runner } from "../../utils/run"

// Utils
import { pathExists } from "../../utils/path"
import { mkdir } from "fs/promises"
import { join } from "path"


// Additional
import cryptoRandomString from "crypto-random-string"

// Files

// @ts-ignore
import templateBaseMainGo from "../../assets/template-base/main.go" with { type: "text" }
// @ts-ignore
import templateBaseYAML from "../../assets/template-base/strux.yaml" with { type: "text" }
// @ts-ignore
import templateBaseBSPYAML from "../../assets/template-base/bsp.yaml" with { type: "text" }
// @ts-ignore
import templateBaseGitignore from "../../assets/template-base/.gitignore" with { type: "text" }
// @ts-ignore
import templateBaseLogoPNG from "../../assets/template-base/logo.png" with { type: "file" }

import { generateTypes } from "../types"


export async function init() {

    // Validate Project Name
    if (Settings.projectName === "") return Logger.error("Please specify a project name")

    // Check if the project directory already exists
    if (pathExists(Settings.projectName)) return Logger.error(`Project directory already exists: ${Settings.projectName}`)


    // Check if NPM is installed
    await Runner.runCommand("npm --version", {
        message: "Checking for NPM installation...",
        messageOnError: "NPM is not installed. Please install NPM and try again.",
        exitOnError: true
    })

    // Check if Go is installed
    await Runner.runCommand("go version", {
        message: "Checking for Go installation...",
        messageOnError: "Go is not installed. Please install Go and try again.",
        exitOnError: true
    })


    // Create the new project Directory
    await mkdir(Settings.projectName, { recursive: true })

    // Calculate Project Path
    Settings.calculateProjectPath()

    // Generate a random client key
    const clientKey = cryptoRandomString({ length: 32, type: "distinguishable" })

    // Make the BSP Directory
    await mkdir(join(Settings.projectPath, "bsp", "qemu"), { recursive: true })

    // Write the BSP.yaml file in the directory
    await Bun.write(join(Settings.projectPath, "bsp", "qemu", "bsp.yaml"), templateBaseBSPYAML.replace("${projectName}", Settings.projectName).replace("${version}", Settings.struxVersion).replace("${hostArch}", Settings.arch))


    // Create the scripts directory in the BSP directory
    await mkdir(join(Settings.projectPath, "bsp", "qemu", "scripts"), { recursive: true })


    // Create the overlay directory in the BSP directory
    await mkdir(join(Settings.projectPath, "bsp", "qemu", "overlay"), { recursive: true })


    // Make the assets directory
    await mkdir(join(Settings.projectPath, "assets"), { recursive: true })

    // Make the overlay directory
    await mkdir(join(Settings.projectPath, "overlay"), { recursive: true })

    // Write the Main.go file in the directory
    await Bun.write(join(Settings.projectPath, "main.go"), templateBaseMainGo.replace("${projectName}", Settings.projectName))

    // Use go to create a go.mod file in the directory
    await Runner.runCommand(`go mod init ${Settings.projectName}`, {
        message: "Creating go.mod file...",
        messageOnError: "Failed to create go.mod file. Please create it manually.",
        cwd: Settings.projectPath,
        exitOnError: true
    })

    // Install the Strux Runtime
    await Runner.runCommand("go get github.com/strux-dev/strux/pkg/runtime", {
        message: "Installing Strux Runtime...",
        messageOnError: "Failed to install Strux Runtime. Please install it manually.",
        exitOnError: true,
        cwd: Settings.projectPath
    })

    // Write the Strux.yaml file in the directory
    await Bun.write(join(Settings.projectPath, "strux.yaml"),
        templateBaseYAML.replace("${projectName}", Settings.projectName).replace("${version}", Settings.struxVersion).replace("${clientKey}", clientKey)
    )

    // Generate the Strux Types by introspecting the main.go file
    // Bootstrap the project with vue or react or vanilla template
    if (Settings.template === "vue") await bootstrapProjectWithVue()
    if (Settings.template === "react") await bootstrapProjectWithReact()
    if (Settings.template === "vanilla") await bootstrapProjectWithVanilla()


    // Generate gitignore file
    await Bun.write(join(Settings.projectPath, ".gitignore"), templateBaseGitignore)

    // Write the logo.png file in the assets directory
    const logoPath = Bun.file(templateBaseLogoPNG)
    await Bun.write(join(Settings.projectPath, "assets", "logo.png"), logoPath)

}


async function generateStruxTypes(projectDir: string): Promise<void> {
    const mainGoPath = join(projectDir, "main.go")
    const frontendDir = join(projectDir, "frontend", "src")

    // Use the actual type generation function to introspect main.go
    const result = await generateTypes({
        mainGoPath,
        outputDir: frontendDir,
    })

    if (!result.success) {
        throw new Error(`Failed to generate types: ${result.error}`)
    }

    Logger.success("Created strux.d.ts type definitions")
}


async function bootstrapProjectWithVue(): Promise<void> {

    // Create the Vue Project
    await Runner.runCommand("npm create vue@latest frontend -- --ts", {
        message: "Creating Vue Project...",
        messageOnError: "Failed to create Vue Project. Please create it manually.",
        messageOnSuccess: "Vue Project created successfully",
        exitOnError: true,
        cwd: Settings.projectPath
    })

    // NPM Install in the directory
    await Runner.runCommand("npm install", {
        message: "Installing Vue Project dependencies...",
        messageOnError: "Failed to install Vue Project dependencies. Please install them manually.",
        exitOnError: true,
        cwd: join(Settings.projectPath, "frontend")
    })

    // Generate the Strux Types by introspecting the main.go file
    await generateStruxTypes(join(Settings.projectPath))

}


async function bootstrapProjectWithReact(): Promise<void> {


    await Runner.runCommand("npm create vite@latest frontend -- --template react-ts", {
        message: "Creating React Project...",
        messageOnError: "Failed to create React Project. Please create it manually.",
        exitOnError: true,
        env: {
            ...process.env,
            CI: "true",
            npm_config_yes: "true",
        },
        cwd: Settings.projectPath
    })

    // NPM Install in the directory
    await Runner.runCommand("npm install", {
        message: "Installing React Project dependencies...",
        messageOnError: "Failed to install React Project dependencies. Please install them manually.",
        exitOnError: true,
        env: {
            ...process.env,
            CI: "true",
            npm_config_yes: "true",
        },
        cwd: join(Settings.projectPath, "frontend")
    })

    // Generate the Strux Types by introspecting the main.go file
    await generateStruxTypes(join(Settings.projectPath))

}


async function bootstrapProjectWithVanilla(): Promise<void> {

    // Create the vanilla project
    await Runner.runCommand("npm create vite@latest frontend -- --template vanilla-ts", {
        message: "Creating Vanilla Project...",
        messageOnError: "Failed to create Vanilla Project. Please create it manually.",
        exitOnError: true,
        cwd: Settings.projectPath,
        env: {
            ...process.env,
            CI: "true",
            npm_config_yes: "true",
        }
    })

    // NPM Install in the directory
    await Runner.runCommand("npm install", {
        message: "Installing Vanilla Project dependencies...",
        messageOnError: "Failed to install Vanilla Project dependencies. Please install them manually.",
        exitOnError: true,
        env: {
            ...process.env,
            CI: "true",
            npm_config_yes: "true",
        },
        cwd: join(Settings.projectPath, "frontend")
    })

    // Generate the Strux Types by introspecting the main.go file
    await generateStruxTypes(join(Settings.projectPath))

}