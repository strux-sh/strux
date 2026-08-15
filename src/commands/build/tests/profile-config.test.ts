import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Settings } from "../../../settings"
import { writeProfileConfig } from "../index"

const originalProjectPath = Settings.projectPath
const originalProfile = Settings.profile
let tempProjectPath: string | null = null

afterEach(async () => {
    Settings.projectPath = originalProjectPath
    Settings.profile = originalProfile
    if (tempProjectPath) await rm(tempProjectPath, { recursive: true, force: true })
    tempProjectPath = null
})

async function prepareCache(): Promise<string> {
    tempProjectPath = await mkdtemp(join(tmpdir(), "strux-profile-config-"))
    const cacheDir = join(tempProjectPath, "dist", "cache", "qemu")
    await mkdir(cacheDir, { recursive: true })
    Settings.projectPath = tempProjectPath
    return join(cacheDir, "profile.json")
}

test("writeProfileConfig writes only runtime profile fields", async () => {
    const path = await prepareCache()
    Settings.profile = {
        name: "touch",
        label: "Touch display",
        bsp: ["qemu", "panel-a"],
    }

    await writeProfileConfig("qemu")

    expect(await Bun.file(path).json()).toEqual({
        name: "touch",
        label: "Touch display",
    })
})

test("writeProfileConfig removes a stale profile when profiles are disabled", async () => {
    const path = await prepareCache()
    await Bun.write(path, "stale")
    Settings.profile = null

    await writeProfileConfig("qemu")

    expect(await Bun.file(path).exists()).toBe(false)
})
