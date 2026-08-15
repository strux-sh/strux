import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProfileTransferPayload, DEVICE_PROFILE_UPDATE_PATH } from "./profile-transfer"

let projectPath: string | null = null

afterEach(async () => {
    if (projectPath) await rm(projectPath, { recursive: true, force: true })
    projectPath = null
})

async function prepareProject(): Promise<string> {
    projectPath = await mkdtemp(join(tmpdir(), "strux-profile-transfer-"))
    await mkdir(join(projectPath, "dist", "cache", "qemu"), { recursive: true })
    return projectPath
}

test("createProfileTransferPayload sends the generated profile through the staged update path", async () => {
    const root = await prepareProject()
    const profile = JSON.stringify({ name: "kiosk", label: "Kiosk" }, null, 2)
    await Bun.write(join(root, "dist", "cache", "qemu", "profile.json"), profile)

    const payload = await createProfileTransferPayload(root, "qemu")

    expect(payload.destPath).toBe(DEVICE_PROFILE_UPDATE_PATH)
    expect(payload.removesProfile).toBe(false)
    expect(Buffer.from(payload.data, "base64").toString()).toBe(profile)
})

test("createProfileTransferPayload sends a tombstone when profile metadata was removed", async () => {
    const root = await prepareProject()

    const payload = await createProfileTransferPayload(root, "qemu")

    expect(payload.destPath).toBe(DEVICE_PROFILE_UPDATE_PATH)
    expect(payload.removesProfile).toBe(true)
    expect(Buffer.from(payload.data, "base64").toString()).toBe("null\n")
})
