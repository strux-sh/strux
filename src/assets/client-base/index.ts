/***
 *
 *
 *  Strux Dev Client
 *
 */
import { validateDevClientConfig } from "./config"
import type { DevClientConfig } from "./config"
import { HostsService } from "./hosts"
import { SocketService } from "./socket"
import { Logger } from "./logger"
import { CageLauncher } from "./cage"

async function launchProduction(): Promise<void> {
    Logger.info("Main", "Production mode: Launching Cage and Cog with production URL")

    // Read display resolution
    let displayResolution = "1920x1080"
    try {
        const resolutionFile = await Bun.file("/strux/.display-resolution").text()
        displayResolution = resolutionFile.trim() || displayResolution
    } catch (_error) {
        Logger.warn("Main", "Could not read display resolution, using default")
    }

    // Check for splash image
    let splashImage: string | undefined
    try {
        const splashExists = await Bun.file("/strux/logo.png").exists()
        if (splashExists) {
            splashImage = "/strux/logo.png"
        }
    } catch (_error) {
        // Splash image not available, continue without it
    }

    // Launch Cage and Cog with production URL
    await CageLauncher.launchCageAndCog({
        cogUrl: "http://localhost:8080",
        displayResolution,
        splashImage,
        waitForBackend: true,
    })

    // Keep process alive
    process.on("SIGINT", () => {
        Logger.info("Main", "Shutting down...")
        CageLauncher.cleanup()
        process.exit(0)
    })

    process.on("SIGTERM", () => {
        Logger.info("Main", "Shutting down...")
        CageLauncher.cleanup()
        process.exit(0)
    })

    // Wait for Cage to exit
    return new Promise(() => {
        // Process will be kept alive by signal handlers
    })
}

async function main() {
    Logger.info("Main", "Starting Strux Client...")

    // Check if dev mode config file exists
    const devConfigExists = await Bun.file("/strux/.dev-env.json").exists()

    if (!devConfigExists) {
        // Production mode - launch directly
        await launchProduction()
        return
    }

    // Dev mode - load config and connect
    Logger.info("Main", "Dev mode detected, loading configuration...")

    let devEnv: DevClientConfig | null = null

    try {
        Logger.info("Main", "Loading configuration from /strux/.dev-env.json...")
        const fileContent = await Bun.file("/strux/.dev-env.json").json()
        devEnv = validateDevClientConfig(fileContent)
        Logger.info("Main", "Configuration loaded successfully")
    } catch (error) {
        Logger.error("Main", "Error reading or validating /strux/.dev-env.json:", error)
        Logger.warn("Main", "Running in production mode")
        await launchProduction()
        return
    }


    // Attempt to connect to discovered hosts
    if (!devEnv) {
        Logger.error("Main", "Dev environment config is required")
        await launchProduction()
        return
    }

    // Wait for the hosts to be discovered
    await HostsService.discover(devEnv)


    Logger.info("Main", "Attempting to connect to dev server via socket.io...")
    const connected = await SocketService.attemptConnection(HostsService, devEnv)

    if (!connected) {
        Logger.error("Main", "Failed to connect to any dev server")
        Logger.warn("Main", "Falling back to production mode")
        await launchProduction()
        return
    }

    Logger.info("Main", "Socket.io connected successfully, waiting for connection to be fully established...")

    // Wait a bit for the connection to stabilize
    await Bun.sleep(500)

    // Verify connection is still active
    if (!SocketService.isConnected()) {
        Logger.error("Main", "Socket connection lost")
        await launchProduction()
        return
    }

    // Determine Cog URL - use discovered host but port 5173 (Vite dev server)
    const connectedHost = SocketService.getConnectedHost()
    const cogUrl = `http://${connectedHost!.host}:5173`
    Logger.info("Main", `Using discovered dev server host with Vite port: ${cogUrl}`)

    // Read display resolution
    let displayResolution = "1920x1080"
    try {
        const resolutionFile = await Bun.file("/strux/.display-resolution").text()
        displayResolution = resolutionFile.trim() || displayResolution
    } catch (_error) {
        Logger.warn("Main", "Could not read display resolution, using default")
    }

    // Check for splash image
    let splashImage: string | undefined
    try {
        const splashExists = await Bun.file("/strux/logo.png").exists()
        if (splashExists) {
            splashImage = "/strux/logo.png"
        }
    } catch (_error) {
        // Splash image not available
    }

    // Launch Cage and Cog
    Logger.info("Main", "Launching Cage and Cog...")
    await CageLauncher.launchCageAndCog({
        cogUrl,
        displayResolution,
        splashImage,
        waitForBackend: true,
    })

    Logger.info("Main", "Dev client connected successfully and ready")

    // Keep the process alive
    process.on("SIGINT", () => {
        Logger.info("Main", "Shutting down dev client...")
        SocketService.disconnect()
        CageLauncher.cleanup()
        process.exit(0)
    })

    process.on("SIGTERM", () => {
        Logger.info("Main", "Shutting down dev client...")
        SocketService.disconnect()
        CageLauncher.cleanup()
        process.exit(0)
    })

    // Wait for Cage to exit
    return new Promise(() => {
        // Process will be kept alive by signal handlers
    })
}

main()
