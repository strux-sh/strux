import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Settings } from "../settings"
import { computeDependencyHashes } from "../commands/build/cache"
import { StruxYamlSchema } from "../types/main-yaml"
import { frontendDockerMounts, resolveFrontendLayout } from "./frontend-layout"

const originalSettings = {
    projectPath: Settings.projectPath,
    main: Settings.main,
}

let tempWorkspace: string | null = null

afterEach(async () => {
    Settings.projectPath = originalSettings.projectPath
    Settings.main = originalSettings.main

    if (tempWorkspace) {
        await rm(tempWorkspace, { recursive: true, force: true })
        tempWorkspace = null
    }
})

async function writeJson(filePath: string, value: unknown): Promise<void> {
    await writeFile(filePath, JSON.stringify(value, null, 2))
}

async function createWorkspaceFixture(): Promise<{ projectDirectory: string; uiDirectory: string; unrelatedDirectory: string }> {
    tempWorkspace = await realpath(await mkdtemp(join(tmpdir(), "strux-frontend-workspace-")))
    const projectDirectory = join(tempWorkspace, "apps", "kiosk")
    const frontendDirectory = join(projectDirectory, "frontend")
    const uiDirectory = join(tempWorkspace, "packages", "ui")
    const unrelatedDirectory = join(tempWorkspace, "packages", "unrelated")

    await mkdir(join(frontendDirectory, "src"), { recursive: true })
    await mkdir(join(uiDirectory, "src"), { recursive: true })
    await mkdir(join(unrelatedDirectory, "src"), { recursive: true })
    await mkdir(join(unrelatedDirectory, "node_modules"), { recursive: true })

    await writeJson(join(tempWorkspace, "package.json"), {
        name: "workspace-root",
        private: true,
        workspaces: ["apps/*/frontend", "packages/*"],
    })
    await writeJson(join(tempWorkspace, "package-lock.json"), { lockfileVersion: 3, packages: {} })
    await writeJson(join(frontendDirectory, "package.json"), {
        name: "@example/kiosk",
        dependencies: { "@example/ui": "*" },
    })
    await writeJson(join(uiDirectory, "package.json"), { name: "@example/ui" })
    await writeJson(join(unrelatedDirectory, "package.json"), { name: "@example/unrelated" })
    await writeFile(join(frontendDirectory, "src", "main.ts"), "export const kiosk = true\n")
    await writeFile(join(uiDirectory, "src", "index.ts"), "export const ui = true\n")
    await writeFile(join(unrelatedDirectory, "src", "index.ts"), "export const unrelated = true\n")
    await writeFile(join(projectDirectory, "strux.yaml"), "frontend:\n  workspace:\n    root: ../..\n    package: '@example/kiosk'\n")

    Settings.projectPath = projectDirectory
    Settings.main = {
        frontend: {
            directory: "./frontend",
            workspace: { root: "../..", package: "@example/kiosk" },
            package_manager: "npm",
            scripts: { build: "build", dev: "dev" },
            output: "./dist",
        },
    } as any

    return { projectDirectory, uiDirectory, unrelatedDirectory }
}

test("frontend schema accepts an explicit npm workspace configuration", () => {
    const result = StruxYamlSchema.safeParse({
        project_version: "0.1.0",
        name: "kiosk",
        bsp: "qemu",
        frontend: {
            workspace: { root: "../..", package: "@example/kiosk" },
        },
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.frontend).toEqual({
        directory: "./frontend",
        workspace: { root: "../..", package: "@example/kiosk" },
        package_manager: "npm",
        scripts: { build: "build", dev: "dev" },
        output: "./dist",
    })
})

test("standalone frontend layout keeps the conventional project paths", async () => {
    tempWorkspace = await realpath(await mkdtemp(join(tmpdir(), "strux-frontend-standalone-")))
    const frontendDirectory = join(tempWorkspace, "frontend")
    await mkdir(join(frontendDirectory, "src"), { recursive: true })
    await writeJson(join(frontendDirectory, "package.json"), { name: "standalone-frontend" })

    Settings.projectPath = tempWorkspace
    Settings.main = {} as any

    const layout = resolveFrontendLayout()
    const mounts = frontendDockerMounts(layout)

    expect(layout.workspaceRoot).toBeNull()
    expect(layout.containerProjectDirectory).toBe("/project")
    expect(layout.containerFrontendDirectory).toBe("/project/frontend")
    expect(mounts).toContainEqual({ type: "bind", source: tempWorkspace, target: "/project" })
    expect(mounts).toContainEqual({ type: "volume", target: "/project/frontend/node_modules" })
})

test("workspace layout includes transitive local packages and isolates container dependencies", async () => {
    const { projectDirectory, uiDirectory, unrelatedDirectory } = await createWorkspaceFixture()

    const layout = resolveFrontendLayout()
    const mounts = frontendDockerMounts(layout)

    expect(layout.workspaceRoot).toBe(tempWorkspace)
    expect(layout.workspacePackageDirectories).toEqual([join(projectDirectory, "frontend"), uiDirectory])
    expect(layout.workspacePackageDirectories).not.toContain(unrelatedDirectory)
    expect(layout.containerProjectDirectory).toBe("/workspace/apps/kiosk")
    expect(layout.containerInstallDirectory).toBe("/workspace")
    expect(mounts).toContainEqual({ type: "bind", source: layout.workspaceRoot!, target: "/workspace" })
    expect(mounts).not.toContainEqual({ type: "bind", source: projectDirectory, target: "/workspace/apps/kiosk" })
    expect(mounts).toContainEqual({ type: "volume", target: "/workspace/node_modules" })
    expect(mounts).toContainEqual({ type: "volume", target: "/workspace/packages/unrelated/node_modules" })
})

test("frontend cache changes when a transitive workspace package changes", async () => {
    const { uiDirectory } = await createWorkspaceFixture()

    const before = await computeDependencyHashes("frontend", "qemu")
    await writeFile(join(uiDirectory, "src", "index.ts"), "export const ui = false\n")
    const after = await computeDependencyHashes("frontend", "qemu")

    expect(before["frontend-workspace:dir:packages/ui"]).toBeDefined()
    expect(after["frontend-workspace:dir:packages/ui"]).not.toBe(before["frontend-workspace:dir:packages/ui"])
    expect(before["frontend-workspace:dir:packages/unrelated"]).toBeUndefined()
})

test("workspace package must resolve to the configured frontend directory", async () => {
    await createWorkspaceFixture()
    Settings.main!.frontend!.workspace!.package = "@example/ui"

    expect(() => resolveFrontendLayout()).toThrow("resolves to")
})
