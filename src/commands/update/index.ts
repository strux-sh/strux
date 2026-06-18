import { basename, isAbsolute, relative, resolve, join } from "node:path"
import { Settings } from "../../settings"
import { Logger } from "../../utils/log"
import { fileExists } from "../../utils/path"
import { Runner } from "../../utils/run"
import { writeUpdateSigningKeypair, type GenerateUpdateKeypairOptions } from "./keys"

// @ts-ignore
import scriptBundleUpdate from "../../assets/scripts-base/strux-bundle-update.sh" with { type: "text" }

export interface BundleUpdateOptions {
    bsp?: string
    version?: string
    privateKey?: string
    out?: string
}

export interface SendUpdateOptions {
    server?: string
    key?: string
}

function toContainerProjectPath(hostPath: string, label: string): string {
    const absolutePath = resolve(hostPath)
    const relativePath = relative(Settings.projectPath, absolutePath)

    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
        Logger.errorWithExit(`${label} must be inside the Strux project so the builder container can access it: ${absolutePath}`)
    }

    return relativePath === "" ? "/project" : `/project/${relativePath}`
}

export async function bundleUpdate(rootfsImage: string | undefined, options: BundleUpdateOptions): Promise<void> {
    const bsp = options.bsp ?? Settings.bspName ?? Settings.main?.bsp
    if (!bsp) {
        Logger.errorWithExit("BSP is required. Pass --bsp or run from a project with strux.yaml loaded.")
    }

    Settings.bspName = bsp

    const defaultRootfsImage = join(Settings.projectPath, "dist", "output", bsp, "rootfs.ext4")
    const imagePath = resolve(rootfsImage ?? defaultRootfsImage)
    const privateKeyPath = resolve(options.privateKey ?? join(Settings.projectPath, "strux-update.key"))

    if (!fileExists(imagePath)) {
        const hint = rootfsImage
            ? ""
            : ` Build the update-enabled image first or pass an explicit rootfs image path. Default was: ${defaultRootfsImage}`
        Logger.errorWithExit(`Rootfs image not found: ${imagePath}.${hint}`)
    }
    if (!fileExists(privateKeyPath)) {
        Logger.errorWithExit(`RSA-PSS update private key not found: ${privateKeyPath}. Generate a project keypair with strux init, run strux update gen-keypair, or pass --private-key.`)
    }

    const version = options.version ?? Settings.projectVersion
    const outputPath = resolve(options.out ?? join(Settings.projectPath, "dist", "output", bsp, `${basename(imagePath)}.struxb`))

    await Runner.runScriptInDocker(scriptBundleUpdate, {
        message: "Creating Strux update bundle...",
        messageOnError: "Failed to create Strux update bundle.",
        exitOnError: true,
        env: {
            UPDATE_BSP: bsp,
            UPDATE_VERSION: version,
            UPDATE_STRUX_VERSION: Settings.struxVersion,
            UPDATE_ROOTFS_IMAGE: toContainerProjectPath(imagePath, "Rootfs image"),
            UPDATE_PRIVATE_KEY: toContainerProjectPath(privateKeyPath, "Private key"),
            UPDATE_OUTPUT: toContainerProjectPath(outputPath, "Output bundle"),
        }
    })

    Logger.success(`Update bundle created: ${outputPath}`)
}

export async function generateUpdateKeypair(options: GenerateUpdateKeypairOptions): Promise<void> {
    const result = await writeUpdateSigningKeypair(options)

    Logger.success(`Update private key written: ${result.privateKeyPath}`)
    Logger.success(`Update public key written: ${result.publicKeyPath}`)
}

export async function sendUpdate(bundlePath: string | undefined, options: SendUpdateOptions): Promise<void> {
    const devServer = Settings.main?.dev?.server
    const serverURL = new URL(options.server ?? process.env.STRUX_DEV_SERVER_URL ?? "http://127.0.0.1:8000")
    serverURL.pathname = "/__strux/dev/system-update"

    const key = options.key ?? devServer?.client_key ?? ""
    if (!key) {
        Logger.errorWithExit("Client key is required. Add dev.server.client_key to strux.yaml or pass --key.")
    }

    const body = bundlePath
        ? { path: resolve(bundlePath) }
        : {}

    if (body.path && !fileExists(body.path)) {
        Logger.errorWithExit(`Update bundle not found: ${body.path}`)
    }

    Logger.info(`Requesting system update through dev server: ${serverURL.toString()}`)
    const response = await fetch(serverURL, {
        method: "POST",
        headers: {
            "authorization": `Bearer ${key}`,
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    })

    const text = await response.text()
    if (!response.ok) {
        Logger.errorWithExit(text || `Dev server returned HTTP ${response.status}`)
    }

    Logger.success(text || "System update request sent")
}
