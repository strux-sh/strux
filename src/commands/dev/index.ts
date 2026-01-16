/***
 *
 *
 *  Dev Command
 *
 *  Main entry point for the Strux dev tool
 *
 */

import path from "path"

import chokidar from "chokidar"

import { Settings } from "../../settings"
import { Logger } from "../../utils/log"
import { compileApplication } from "../build/steps"
import { build as buildCommand } from "../build"
import { MainYAMLValidator } from "../../types/main-yaml"
import { createDevServer, stopDevServer, type DevServer } from "./server"
import { run as runQEMU } from "../run"


// Dev server instance
let devServer: DevServer | null = null

// QEMU process reference
let qemuProcess: Awaited<ReturnType<typeof runQEMU>> | null = null

// Vite dev server process reference
let viteProcess: ReturnType<typeof Bun.spawn> | null = null


export async function dev(): Promise<void> {


    // Enable dev mode
    Settings.isDevMode = true

    // Load and validate strux.yaml to get the client key and other settings
    MainYAMLValidator.validateAndLoad()

    // Determine BSP based on --remote flag
    if (Settings.isRemoteOnly) {

        // Remote mode: Use BSP from strux.yaml
        Logger.info("Remote mode: Using BSP from strux.yaml")

        if (!Settings.bspName) {

            Logger.errorWithExit("No BSP specified in strux.yaml. Please add a 'bsp' field.")

        }

    } else {

        // Local mode: Force QEMU BSP
        Logger.info("Local mode: Using QEMU BSP for development")

        Settings.bspName = "qemu"

    }

    // Get the client key from the config
    const clientKey = Settings.main?.dev?.server?.client_key ?? ""

    if (!clientKey) {

        Logger.errorWithExit("No client key found in strux.yaml. Please add a client_key under dev.server.")

    }

    // Get the server port from fallback hosts (default to 8000)
    const serverPort = Settings.main?.dev?.server?.fallback_hosts?.[0]?.port ?? 8000

    // Run the initial build
    Logger.title("Building Development Image")

    await buildCommand()

    // Start the Vite dev server for the frontend inside Docker
    // This ensures consistent Linux-native npm packages and proper caching
    Logger.title("Starting Vite Dev Server (Docker)")

    // Build Docker command for Vite dev server
    // Uses the same strux-builder image with port mapping for HMR
    const viteDockerArgs: string[] = [
        "docker", "run", "--rm",
        "-v", `${Settings.projectPath}:/project`,
        "-p", "5173:5173",  // Vite dev server port
        "-w", "/project/frontend",
        // Enable polling for file watching (Docker doesn't propagate native fs events well)
        "-e", "CHOKIDAR_USEPOLLING=true",
        "-e", "CHOKIDAR_INTERVAL=100",
        "strux-builder",
        "/bin/bash", "-c",
        "npm install && npm run dev -- --host 0.0.0.0 --port 5173"
    ]

    // Silence Vite output by default, show with --vite flag
    const viteStdio: ["inherit", "inherit", "inherit"] | ["pipe", "pipe", "pipe"] = Settings.devViteDebug
        ? ["inherit", "inherit", "inherit"]
        : ["pipe", "pipe", "pipe"]

    viteProcess = Bun.spawn(viteDockerArgs, {
        stdio: viteStdio
    })

    Logger.success("Vite dev server started on http://localhost:5173 (running in Docker)")

    // Handle Vite process exit
    viteProcess.exited.then((code) => {

        // Exit codes 130 (SIGINT) and 143 (SIGTERM) are expected when we kill the process
        const isSignalExit = code === 130 || code === 143

        if (code !== 0 && code !== null && !isSignalExit) {

            Logger.error(`Vite dev server exited with code ${code}`)

        }

    })

    // Start QEMU if not in remote mode
    if (!Settings.isRemoteOnly) {

        Logger.title("Starting QEMU Emulator")

        const proc = await runQEMU({ devMode: true, returnProcess: true, quiet: true })

        if (proc) {

            qemuProcess = proc

            // Handle QEMU exit
            proc.exited.then((code) => {

                // Reset terminal to prevent blank lines
                process.stdout.write("\x1b[0m\x1b[?25h")

                if (code !== 0) {
                    Logger.error(`QEMU exited with code ${code}`)
                } else {
                    Logger.log("QEMU emulator stopped")
                }

                // Stop dev server and Vite when QEMU closes
                stopDevServer()

                if (viteProcess) {
                    viteProcess.kill()
                }

                // Give processes a moment to clean up, then exit
                setTimeout(() => {
                    process.stdout.write("\n")
                    process.exit(code ?? 0)
                }, 100)

            })

        }

    }

    // Start the dev server
    Logger.title("Starting Development Server")

    devServer = createDevServer({
        port: serverPort,
        clientKey,
        onClientConnected: () => {

            Logger.success("Device connected to dev server")

            // Only start streaming logs in debug mode
            if (Settings.devDebug) {
                devServer?.startLogStream("system", "journalctl")
            }

        },
        onClientDisconnected: () => {

            Logger.warning("Device disconnected from dev server")

        },
        onBinaryRequested: async () => {

            // Client requested binary, send the current one without recompiling
            Logger.log("Binary requested by client, sending current binary...")

            await sendCurrentBinary()

        }
    })

    Logger.info(`Client key: ${clientKey}`)

    // Start the file watcher
    await runFileWatcher()

    // Handle graceful shutdown
    const cleanup = () => {

        // Reset terminal to prevent blank lines from child processes
        process.stdout.write("\x1b[0m\x1b[?25h") // Reset styles and show cursor

        Logger.log("Shutting down...")

        stopDevServer()

        if (viteProcess) {
            viteProcess.kill()
        }

        if (qemuProcess && "kill" in qemuProcess) {
            qemuProcess.kill()
        }

        // Give processes a moment to clean up, then exit
        setTimeout(() => {
            process.stdout.write("\n")
            process.exit(0)
        }, 100)

    }

    process.on("SIGINT", cleanup)
    process.on("SIGTERM", cleanup)

    // Keep the process running
    await new Promise((_resolve) => { /* Never resolves - keeps process alive */ })

}


async function runFileWatcher(): Promise<void> {


    const watcher = chokidar.watch(Settings.projectPath, {
        ignored: (filePath: string, stats) => {
            // Ignore everything in frontend, dist, assets, bsp, and overlay directories
            const ignoreDirs = ["frontend/", "dist/", "assets/", "bsp/", "overlay/"]
            // Normalize path separators for cross-platform consistency
            const normalizedPath = filePath.replace(/\\/g, "/")
            for (const dir of ignoreDirs) {
                if (normalizedPath.includes(`/${dir}`) || normalizedPath.startsWith(`${dir}`)) {
                    return true
                }
            }
            if (!stats?.isFile?.()) return false
            return !(
                filePath.endsWith(".go") ||
                filePath.endsWith(".mod") ||
                filePath.endsWith(".yaml") || // This handles strux.yaml
                filePath.endsWith(".sum")
            )
        },
        persistent: true,
        ignoreInitial: true
    })

    watcher.on("all", async (_event, filePath) => {

        Logger.log("Changes detected, rebuilding application...")

        // Check if the file is a strux file
        if (filePath.endsWith(".yaml")) await triggerFullRebuild()
        else await rebuildApplication()

    })

}


async function sendCurrentBinary(): Promise<void> {


    Logger.log("Sending current binary to client...")

    // Send the current binary without recompiling
    if (devServer?.isClientConnected()) {

        const bspName = Settings.bspName!

        // Read the compiled binary from the BSP cache directory
        const binaryPath = path.join(Settings.projectPath, "dist", "cache", bspName, "app", "main")

        const binaryFile = Bun.file(binaryPath)

        if (await binaryFile.exists()) {

            const binaryData = Buffer.from(await binaryFile.arrayBuffer())

            devServer.sendBinary(binaryData)

            Logger.success("Binary sent to device")

        } else {

            Logger.warning(`Compiled binary not found at ${binaryPath}`)

        }

    }

}


async function rebuildApplication(): Promise<void> {

    // Compile the application
    await compileApplication()

    // Stream the application to the connected client
    await sendCurrentBinary()

}


async function triggerFullRebuild(): Promise<void> {


    Settings.isDevMode = true

    // Reload the config in case it changed
    MainYAMLValidator.validateAndLoad()

    // Build the application
    await buildCommand()

}
