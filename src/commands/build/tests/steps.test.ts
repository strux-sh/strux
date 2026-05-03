import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Settings } from "../../../settings"
import { Logger } from "../../../utils/log"
import { updateDevEnvConfig, writeDisplayConfig } from "../steps"

const originalSettings = {
    projectPath: Settings.projectPath,
    main: Settings.main,
    bsp: Settings.bsp,
}

let tempProjectPath: string | null = null

beforeEach(() => {
    Logger.setSink(() => undefined)
})

afterEach(async () => {
    Logger.setSink(null)
    Settings.projectPath = originalSettings.projectPath
    Settings.main = originalSettings.main
    Settings.bsp = originalSettings.bsp

    if (tempProjectPath) {
        await rm(tempProjectPath, { recursive: true, force: true })
        tempProjectPath = null
    }
})

async function configureProjectCache(bspName = "qemu"): Promise<string> {
    tempProjectPath = await mkdtemp(join(tmpdir(), "strux-build-steps-"))
    const cacheDir = join(tempProjectPath, "dist", "cache", bspName)
    await mkdir(cacheDir, { recursive: true })
    Settings.projectPath = tempProjectPath
    return cacheDir
}

test("writeDisplayConfig writes explicit monitor and input mappings to the BSP cache", async () => {
    const cacheDir = await configureProjectCache()
    Settings.main = {
        display: {
            monitors: [
                {
                    path: "/left",
                    resolution: "1280x720",
                    names: ["HDMI-A-1"],
                    input_devices: ["touch-left", "pen-left"],
                },
                {
                    path: "/right",
                    names: ["HDMI-A-2"],
                },
            ],
        },
    } as any
    Settings.bsp = {
        display: {
            width: 1920,
            height: 1080,
        },
    } as any

    await writeDisplayConfig("qemu")

    const displayConfig = await Bun.file(join(cacheDir, ".display-config.json")).json()
    const inputMap = await Bun.file(join(cacheDir, ".input-map")).text()

    expect(displayConfig).toEqual({
        monitors: [
            {
                path: "/left",
                resolution: "1280x720",
                names: ["HDMI-A-1"],
            },
            {
                path: "/right",
                names: ["HDMI-A-2"],
            },
        ],
    })
    expect(inputMap).toBe("touch-left:HDMI-A-1\npen-left:HDMI-A-1\n")
})

test("writeDisplayConfig writes the BSP display fallback when strux.yaml has no monitors", async () => {
    const cacheDir = await configureProjectCache()
    Settings.main = {} as any
    Settings.bsp = {
        display: {
            width: 800,
            height: 480,
        },
    } as any

    await writeDisplayConfig("qemu")

    const displayConfig = await Bun.file(join(cacheDir, ".display-config.json")).json()
    const inputMapExists = await Bun.file(join(cacheDir, ".input-map")).exists()

    expect(displayConfig).toEqual({
        monitors: [
            {
                path: "/",
                resolution: "800x480",
            },
        ],
    })
    expect(inputMapExists).toBe(false)
})

test("updateDevEnvConfig writes the current dev server and inspector settings", async () => {
    const cacheDir = await configureProjectCache()
    Settings.main = {
        dev: {
            server: {
                client_key: "secret-key",
                use_mdns_on_client: false,
                fallback_hosts: [
                    {
                        host: "10.0.0.10",
                        port: 5173,
                    },
                ],
            },
            inspector: {
                enabled: true,
                port: 9229,
            },
        },
    } as any

    await updateDevEnvConfig("qemu")

    const devEnv = await Bun.file(join(cacheDir, ".dev-env.json")).json()

    expect(devEnv).toEqual({
        clientKey: "secret-key",
        useMDNS: false,
        fallbackHosts: [
            {
                host: "10.0.0.10",
                port: 5173,
            },
        ],
        inspector: {
            enabled: true,
            port: 9229,
        },
    })
})

test("updateDevEnvConfig writes safe defaults when dev settings are omitted", async () => {
    const cacheDir = await configureProjectCache()
    Settings.main = {} as any

    await updateDevEnvConfig("qemu")

    const devEnv = await Bun.file(join(cacheDir, ".dev-env.json")).json()

    expect(devEnv).toEqual({
        clientKey: "",
        useMDNS: true,
        fallbackHosts: [],
        inspector: {
            enabled: false,
            port: 9223,
        },
    })
})
