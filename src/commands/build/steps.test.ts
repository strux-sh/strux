import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Settings } from "../../settings"
import { compileFrontend } from "./steps"

const originalSettings = {
    projectPath: Settings.projectPath,
    main: Settings.main,
    bsp: Settings.bsp,
}

let tempProjectPath: string | null = null

afterEach(async () => {
    Settings.projectPath = originalSettings.projectPath
    Settings.main = originalSettings.main
    Settings.bsp = originalSettings.bsp

    if (tempProjectPath) {
        await rm(tempProjectPath, { recursive: true, force: true })
        tempProjectPath = null
    }
})

test("compileFrontend reports type generation failure without terminating the process", async () => {
    tempProjectPath = await mkdtemp(join(tmpdir(), "strux-frontend-failure-"))
    await mkdir(join(tempProjectPath, "frontend"))
    Settings.projectPath = tempProjectPath
    Settings.main = null
    Settings.bsp = null

    await expect(compileFrontend()).rejects.toThrow(`main.go not found at ${join(tempProjectPath, "main.go")}`)
})
