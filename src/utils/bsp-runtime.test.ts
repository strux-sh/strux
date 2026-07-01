import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Settings } from "../settings"
import {
    findCapabilityConflicts,
    getIncludedBSPRuntimeExtensions,
    getProjectStruxApiKey,
    resolveBSPRuntimeExtensions,
    syncStruxRuntimeVersion
} from "./bsp-runtime"

let tmpDir: string
let originalProjectPath: string
let originalVersion: string
let originalBsp: typeof Settings.bsp

beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "strux-bsp-runtime-"))
    originalProjectPath = Settings.projectPath
    originalVersion = Settings.struxVersion
    originalBsp = Settings.bsp
    Settings.projectPath = tmpDir
    Settings.struxVersion = "0.4.0"
})

afterEach(() => {
    Settings.projectPath = originalProjectPath
    Settings.struxVersion = originalVersion
    Settings.bsp = originalBsp
    rmSync(tmpDir, { recursive: true, force: true })
})

interface TestExtension {
    import: string
    compatible_strux_api?: string | string[]
    implements?: string | string[]
}

function setExtensions(extensions: TestExtension[]): void {
    Settings.bsp = { runtime: { extensions } } as unknown as typeof Settings.bsp
}

function includedImports(): string[] {
    return getIncludedBSPRuntimeExtensions().map((e) => e.importPath)
}

function writeGoMod(contents: string): string {
    const path = join(tmpDir, "go.mod")
    writeFileSync(path, contents)
    return path
}

test("rewrites a grouped require to the CLI version", () => {
    const path = writeGoMod(
        "module example.com/proj\n\ngo 1.21\n\nrequire (\n\tgithub.com/strux-dev/strux v0.3.0\n)\n"
    )

    const result = syncStruxRuntimeVersion()

    expect(result).toEqual({ changed: true, from: "v0.3.0", to: "v0.4.0" })
    expect(readFileSync(path, "utf-8")).toContain("github.com/strux-dev/strux v0.4.0")
})

test("rewrites a single-line require", () => {
    const path = writeGoMod(
        "module example.com/proj\n\ngo 1.21\n\nrequire github.com/strux-dev/strux v0.3.1\n"
    )

    const result = syncStruxRuntimeVersion()

    expect(result.changed).toBe(true)
    expect(readFileSync(path, "utf-8")).toContain("require github.com/strux-dev/strux v0.4.0")
})

test("is a no-op when already in sync", () => {
    const original = "module example.com/proj\n\nrequire github.com/strux-dev/strux v0.4.0\n"
    const path = writeGoMod(original)

    const result = syncStruxRuntimeVersion()

    expect(result).toEqual({ changed: false, from: "v0.4.0", to: "v0.4.0" })
    expect(readFileSync(path, "utf-8")).toBe(original)
})

test("does not touch the .../pkg/runtime import path token", () => {
    // The require line carries the module path + version; the regex must anchor
    // on the version token and never rewrite a subpackage reference.
    const path = writeGoMod(
        "module example.com/proj\n\nrequire github.com/strux-dev/strux v0.3.0 // indirect via github.com/strux-dev/strux/pkg/runtime\n"
    )

    syncStruxRuntimeVersion()

    const out = readFileSync(path, "utf-8")
    expect(out).toContain("github.com/strux-dev/strux v0.4.0")
    expect(out).toContain("github.com/strux-dev/strux/pkg/runtime")
})

test("no-op when go.mod is absent", () => {
    const result = syncStruxRuntimeVersion()
    expect(result).toEqual({ changed: false, from: null, to: "v0.4.0" })
})

test("no-op when the runtime is not a dependency", () => {
    writeGoMod("module example.com/proj\n\ngo 1.21\n\nrequire example.com/other v1.2.3\n")

    const result = syncStruxRuntimeVersion()
    expect(result).toEqual({ changed: false, from: null, to: "v0.4.0" })
})

test("normalizes a CLI version that already has a v prefix", () => {
    Settings.struxVersion = "v0.5.0"
    writeGoMod("module example.com/proj\n\nrequire github.com/strux-dev/strux v0.4.0\n")

    const result = syncStruxRuntimeVersion()
    expect(result.to).toBe("v0.5.0")
    expect(result.changed).toBe(true)
})

// --- API key derivation ----------------------------------------------------

test("getProjectStruxApiKey falls back to the CLI version when no go.mod", () => {
    expect(getProjectStruxApiKey()).toBe("0.4")
})

test("getProjectStruxApiKey prefers the go.mod runtime version", () => {
    writeGoMod("module example.com/proj\n\nrequire github.com/strux-dev/strux v0.3.5\n")
    expect(getProjectStruxApiKey()).toBe("0.3")
})

test("getProjectStruxApiKey is null for an unparseable version", () => {
    Settings.struxVersion = "dev"
    expect(getProjectStruxApiKey()).toBeNull()
})

test("getProjectStruxApiKey uses the CLI version (not stale go.mod) under --local-runtime", () => {
    // Regression: with a local runtime, go.mod is intentionally unsynced, so the
    // gate must follow the CLI version or it wrongly skips current extensions.
    writeGoMod("module example.com/proj\n\nrequire github.com/strux-dev/strux v0.2.0\n")
    Settings.struxVersion = "0.4.0"
    Settings.localRuntime = "/some/local/strux"
    try {
        expect(getProjectStruxApiKey()).toBe("0.4")
    } finally {
        Settings.localRuntime = null
    }
})

// --- per-extension gating --------------------------------------------------

test("includes an extension with no compatible_strux_api constraint", () => {
    setExtensions([{ import: "example.com/proj/runtime/network" }])
    expect(includedImports()).toEqual(["example.com/proj/runtime/network"])
})

test("includes an extension whose compat list contains the build's API key", () => {
    setExtensions([{ import: "example.com/proj/runtime/audio", compatible_strux_api: "0.4" }])
    expect(includedImports()).toEqual(["example.com/proj/runtime/audio"])
})

test("skips an extension whose compat list excludes the build's API key", () => {
    setExtensions([{ import: "example.com/proj/runtime/v0.3/audio", compatible_strux_api: ["0.3"] }])
    expect(includedImports()).toEqual([])
})

test("gates per extension across a version-split BSP", () => {
    setExtensions([
        { import: "example.com/proj/runtime/network" },
        { import: "example.com/proj/runtime/v0.3/audio", compatible_strux_api: ["0.3"] },
        { import: "example.com/proj/runtime/v0.4/audio", compatible_strux_api: ["0.3", "0.4"] },
    ])
    // Building against 0.4: stable network + the v0.4 audio; the v0.3 audio is gated out.
    expect(includedImports()).toEqual([
        "example.com/proj/runtime/network",
        "example.com/proj/runtime/v0.4/audio",
    ])
})

test("disables gating (includes everything) when the API key is unknown", () => {
    Settings.struxVersion = "dev"
    setExtensions([{ import: "example.com/proj/runtime/audio", compatible_strux_api: ["0.4"] }])
    expect(includedImports()).toEqual(["example.com/proj/runtime/audio"])
})

// --- implements declaration + capability conflicts -------------------------

test("normalizes a single implements value to an array", () => {
    setExtensions([{ import: "example.com/proj/runtime/audio", implements: "audio" }])
    expect(resolveBSPRuntimeExtensions()[0].implements).toEqual(["audio"])
})

test("no conflict when each capability is implemented by one extension", () => {
    setExtensions([
        { import: "example.com/proj/runtime/audio", implements: ["audio", "audio/capture"] },
        { import: "example.com/proj/runtime/network", implements: ["network"] },
    ])
    expect(findCapabilityConflicts(resolveBSPRuntimeExtensions())).toEqual([])
})

test("flags two extensions implementing the same capability", () => {
    setExtensions([
        { import: "example.com/proj/runtime/audio-a", implements: ["audio"] },
        { import: "example.com/proj/runtime/audio-b", implements: ["audio/capture"] },
    ])
    const conflicts = findCapabilityConflicts(resolveBSPRuntimeExtensions())
    expect(conflicts).toEqual([
        { capability: "audio", importPaths: ["example.com/proj/runtime/audio-a", "example.com/proj/runtime/audio-b"] },
    ])
})

test("does not treat multiple custom extensions as a conflict", () => {
    setExtensions([
        { import: "example.com/proj/runtime/foo", implements: "custom" },
        { import: "example.com/proj/runtime/bar", implements: "custom" },
    ])
    expect(findCapabilityConflicts(resolveBSPRuntimeExtensions())).toEqual([])
})

test("conflict check only sees compiled-in extensions (gated apart = no conflict)", () => {
    setExtensions([
        { import: "example.com/proj/runtime/v0.3/audio", implements: ["audio"], compatible_strux_api: ["0.3"] },
        { import: "example.com/proj/runtime/v0.4/audio", implements: ["audio"], compatible_strux_api: ["0.4"] },
    ])
    // Building against 0.4, only the v0.4 audio is included -> no conflict.
    expect(findCapabilityConflicts(getIncludedBSPRuntimeExtensions())).toEqual([])
})
