import { expect, test } from "bun:test"
import { join } from "node:path"
import { shouldIgnoreDevWatchPath } from "./watcher"

const projectRoot = join("/tmp", "strux-project")

test("dev watcher ignores root workspace dependency directories", () => {
    expect(shouldIgnoreDevWatchPath(projectRoot, join(projectRoot, "node_modules"))).toBe(true)
    expect(shouldIgnoreDevWatchPath(projectRoot, join(projectRoot, "node_modules", "typescript", "lib", "typescript.js"))).toBe(true)
})

test("dev watcher ignores dependency directories nested below project sources", () => {
    expect(shouldIgnoreDevWatchPath(projectRoot, join(projectRoot, "packages", "ui", "node_modules", "vue", "index.js"))).toBe(true)
})

test("dev watcher preserves existing generated and frontend exclusions", () => {
    expect(shouldIgnoreDevWatchPath(projectRoot, join(projectRoot, "frontend", "src", "main.ts"))).toBe(true)
    expect(shouldIgnoreDevWatchPath(projectRoot, join(projectRoot, "dist", "cache", "app"))).toBe(true)
    expect(shouldIgnoreDevWatchPath(projectRoot, join(projectRoot, "bsp", "qemu", "bsp.yaml"))).toBe(true)
})

test("dev watcher keeps application and configuration sources visible", () => {
    expect(shouldIgnoreDevWatchPath(projectRoot, join(projectRoot, "main.go"))).toBe(false)
    expect(shouldIgnoreDevWatchPath(projectRoot, join(projectRoot, "strux.yaml"))).toBe(false)
    expect(shouldIgnoreDevWatchPath(projectRoot, join(projectRoot, "internal", "device", "device.go"))).toBe(false)
})

test("dev watcher matches directory names by segment instead of substring", () => {
    expect(shouldIgnoreDevWatchPath(projectRoot, join(projectRoot, "frontend-tools", "main.go"))).toBe(false)
    expect(shouldIgnoreDevWatchPath(projectRoot, join(projectRoot, "node_modules_backup", "main.go"))).toBe(false)
})
