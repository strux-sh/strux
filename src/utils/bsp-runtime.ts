import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { isAbsolute, join, relative, resolve, sep } from "path"
import { Settings } from "../settings"
import { Logger } from "./log"

export interface ResolvedBSPRuntimeExtension {
    importPath: string
    sourcePath?: string
    // Strux API version keys this extension is gated to, normalized to an array.
    // undefined = no constraint (always compiled in).
    compatibleApi?: string[]
    // What this extension declares it provides: "custom", or "<capability>" /
    // "<capability>/<feature>" identifiers. undefined = not declared.
    implements?: string[]
}

export const BSP_RUNTIME_IMPORTS_FILENAME = "strux_bsp_runtime_extensions.go"

function toSlashPath(value: string): string {
    return value.split(sep).join("/")
}

function readProjectModulePath(): string | null {
    const goModPath = join(Settings.projectPath, "go.mod")
    if (!existsSync(goModPath)) return null

    const content = readFileSync(goModPath, "utf-8")
    const match = /^module\s+(.+)\s*$/m.exec(content)
    return match?.[1]?.trim() ?? null
}

function resolveFromBSP(value: string): string {
    const bspName = Settings.bspName
    const baseDir = bspName
        ? join(Settings.projectPath, "bsp", bspName)
        : Settings.projectPath

    return isAbsolute(value)
        ? resolve(value)
        : resolve(baseDir, value)
}

function deriveImportPath(sourcePath: string): string {
    const modulePath = readProjectModulePath()
    if (!modulePath) {
        throw new Error("Cannot derive BSP runtime extension import path because go.mod has no module declaration")
    }

    const projectPath = resolve(Settings.projectPath)
    const resolvedSource = resolve(sourcePath)
    const relativePath = relative(projectPath, resolvedSource)

    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
        throw new Error(`BSP runtime extension path must set import when it is outside the project: ${sourcePath}`)
    }

    return `${modulePath}/${toSlashPath(relativePath)}`
}

export function resolveBSPRuntimeExtensions(): ResolvedBSPRuntimeExtension[] {
    const entries = Settings.bsp?.runtime?.extensions ?? []

    return entries.map((entry) => {
        const sourcePath = entry.path ? resolveFromBSP(entry.path) : undefined
        const importPath = entry.import ?? (sourcePath ? deriveImportPath(sourcePath) : undefined)

        if (!importPath) {
            throw new Error("BSP runtime extension requires an import path")
        }

        const compat = entry.compatible_strux_api
        const compatibleApi = compat === undefined
            ? undefined
            : Array.isArray(compat) ? compat : [compat]

        const impl = entry.implements
        const implementsList = impl === undefined
            ? undefined
            : Array.isArray(impl) ? impl : [impl]

        return {
            importPath,
            sourcePath,
            compatibleApi,
            implements: implementsList,
        }
    })
}

/**
 * A capability declared (via `implements`) by more than one of the given
 * extensions. Only one provider per capability is allowed, so this is a build
 * error. The capability is the part before any "/" (so "audio" and
 * "audio/capture" both count as the "audio" capability); "custom" is excluded —
 * multiple custom extensions are fine.
 */
export interface CapabilityConflict {
    capability: string
    importPaths: string[]
}

export function findCapabilityConflicts(extensions: ResolvedBSPRuntimeExtension[]): CapabilityConflict[] {
    const byCapability = new Map<string, Set<string>>()

    for (const extension of extensions) {
        if (!extension.implements) continue
        const capabilities = new Set(
            extension.implements
                .filter((entry) => entry !== "custom")
                .map((entry) => entry.split("/")[0])
        )
        for (const capability of capabilities) {
            const owners = byCapability.get(capability) ?? new Set<string>()
            owners.add(extension.importPath)
            byCapability.set(capability, owners)
        }
    }

    const conflicts: CapabilityConflict[] = []
    for (const [capability, owners] of byCapability) {
        if (owners.size > 1) {
            conflicts.push({ capability, importPaths: [...owners] })
        }
    }
    return conflicts
}

/**
 * The Strux API key (major.minor, e.g. "0.4") of the runtime this build targets.
 * Read from the project's go.mod strux version — which the build pins to the CLI
 * version (see syncStruxRuntimeVersion) — falling back to the CLI version. Null
 * when no parseable version is available (e.g. a local-runtime dev checkout), in
 * which case per-extension gating is disabled (everything is included).
 */
export function getProjectStruxApiKey(): string | null {
    // The CLI version is the source of truth. In a normal build the project's
    // go.mod is pinned to it (syncStruxRuntimeVersion), so reading go.mod agrees
    // with the CLI version. With --local-runtime the runtime is the CLI's own
    // checkout and go.mod is intentionally left unsynced, so the CLI version wins
    // (reading the stale go.mod would wrongly gate out current-version extensions).
    let version = Settings.struxVersion
    if (!Settings.localRuntime) {
        const goModPath = join(Settings.projectPath, "go.mod")
        if (existsSync(goModPath)) {
            const content = readFileSync(goModPath, "utf-8")
            const match = /github\.com\/strux-dev\/strux\s+(v?\d+\.\d+\.\d+(?:[-+\w.]*)?)/.exec(content)
            if (match?.[1]) version = match[1]
        }
    }
    const parsed = /^v?(\d+)\.(\d+)/.exec(version.trim())
    return parsed ? `${parsed[1]}.${parsed[2]}` : null
}

function isExtensionCompatible(extension: ResolvedBSPRuntimeExtension, apiKey: string | null): boolean {
    // No constraint, or no determinable API to gate against -> always included.
    if (!extension.compatibleApi || extension.compatibleApi.length === 0 || apiKey === null) {
        return true
    }
    return extension.compatibleApi.includes(apiKey)
}

/**
 * Returns the runtime extensions that should be compiled into this build, gating
 * out any whose compatible_strux_api excludes the runtime version being built
 * against. When log is set, every extension's decision is logged — so a stripped
 * or mistyped compatible_strux_api (which Zod silently drops) surfaces as an
 * "included unconditionally" line rather than vanishing.
 */
export function getIncludedBSPRuntimeExtensions(options: { log?: boolean } = {}): ResolvedBSPRuntimeExtension[] {
    const apiKey = getProjectStruxApiKey()
    const included: ResolvedBSPRuntimeExtension[] = []

    for (const extension of resolveBSPRuntimeExtensions()) {
        const compatible = isExtensionCompatible(extension, apiKey)

        if (options.log) {
            const provides = extension.implements ? ` — implements [${extension.implements.join(", ")}]` : ""
            if (!extension.compatibleApi) {
                Logger.debug(`Runtime extension ${extension.importPath}: included (no compatible_strux_api constraint)${provides}`)
            } else if (apiKey === null) {
                Logger.warning(`Runtime extension ${extension.importPath}: cannot determine Strux API version; including despite compatible_strux_api [${extension.compatibleApi.join(", ")}]${provides}`)
            } else if (compatible) {
                Logger.info(`Runtime extension ${extension.importPath}: included (API ${apiKey} ∈ [${extension.compatibleApi.join(", ")}])${provides}`)
            } else {
                Logger.warning(`Runtime extension ${extension.importPath}: skipped (needs Strux API [${extension.compatibleApi.join(", ")}], building against ${apiKey})${provides}`)
            }
        }

        if (compatible) {
            included.push(extension)
        }
    }

    return included
}

export async function writeBSPRuntimeExtensionImports(): Promise<ResolvedBSPRuntimeExtension[]> {
    const extensions = getIncludedBSPRuntimeExtensions({ log: true })
    const outputPath = join(Settings.projectPath, BSP_RUNTIME_IMPORTS_FILENAME)

    // Two extensions compiled into the same build can't both provide a capability
    // (one provider per capability — the runtime would panic at registration).
    const conflicts = findCapabilityConflicts(extensions)
    for (const { capability, importPaths } of conflicts) {
        Logger.errorWithExit(
            `Multiple runtime extensions implement the "${capability}" capability in this build: ${importPaths.join(", ")}. ` +
            "Only one provider per capability is allowed — gate them apart with compatible_strux_api, or remove the duplicate."
        )
    }

    if (extensions.length === 0) {
        if (existsSync(outputPath)) {
            unlinkSync(outputPath)
        }
        return extensions
    }

    const imports = extensions
        .map((extension) => `\t_ "${extension.importPath}"`)
        .join("\n")

    const content = `// Code generated by Strux; DO NOT EDIT.

package main

import (
${imports}
)
`

    await Bun.write(outputPath, content)
    return extensions
}

export function getLocalBSPRuntimeExtensionDirs(): string[] {
    // Only the extensions actually compiled in (gating applied, no logging here —
    // this runs for cache-dependency hashing as well as the build mount).
    return getIncludedBSPRuntimeExtensions()
        .map((extension) => extension.sourcePath)
        .filter((path): path is string => Boolean(path))
        .filter((path) => existsSync(path))
}

export function getBSPRuntimeImportsPath(): string {
    return join(Settings.projectPath, BSP_RUNTIME_IMPORTS_FILENAME)
}

export interface StruxRuntimeVersionSync {
    changed: boolean
    from: string | null
    to: string
}

/**
 * Pins the project's go.mod `require` for the Strux runtime to the running CLI's
 * version. The CLI and the runtime ship in tandem, so the runtime compiled into
 * a project must always match the CLI building it — a drift is never intended,
 * so we correct it (and the caller logs it) rather than fail.
 *
 * Only go.mod is rewritten here; go.sum for the new version is reconciled inside
 * the build container where Go is available (see strux-build-app.sh). No-op when
 * go.mod is absent, the runtime is not a direct dependency, or it is already in
 * sync. Returns what changed so the caller can log it.
 */
export function syncStruxRuntimeVersion(): StruxRuntimeVersionSync {
    const to = `v${Settings.struxVersion.replace(/^v/, "")}`
    const goModPath = join(Settings.projectPath, "go.mod")
    if (!existsSync(goModPath)) {
        return { changed: false, from: null, to }
    }

    const content = readFileSync(goModPath, "utf-8")
    // Match the runtime module's require line (module path + whitespace +
    // version). The \s+ anchors us to the version token, so this never matches
    // the longer ".../pkg/runtime" import path that init's `go get` references.
    const requireRe = /(github\.com\/strux-dev\/strux)(\s+)(v[0-9][\w.\-+]*)/
    const match = requireRe.exec(content)
    if (!match) {
        return { changed: false, from: null, to }
    }

    const from = match[3]
    if (from === to) {
        return { changed: false, from, to }
    }

    writeFileSync(goModPath, content.replace(requireRe, `$1$2${to}`))
    return { changed: true, from, to }
}
