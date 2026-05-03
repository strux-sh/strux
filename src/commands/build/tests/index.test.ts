import { afterEach, expect, test } from "bun:test"
import { Settings } from "../../../settings"
import { buildWithDeps, type BuildCache, type BuildDeps, type BuildMetadata, type BuildSteps } from "../index"
import { type BuildCacheManifest, type StepCacheEntry } from "../cache"
import { type BuildStep } from "../cache-deps"
import { type BSPScript, type ScriptStep } from "../../../types/bsp-yaml"

const originalSettings = {
    projectPath: Settings.projectPath,
    bspName: Settings.bspName,
    isDevMode: Settings.isDevMode,
    noChown: Settings.noChown,
    clean: Settings.clean,
    main: Settings.main,
    bsp: Settings.bsp,
    struxVersion: Settings.struxVersion,
}

interface HarnessOptions {
    rebuildSteps?: Iterable<BuildStep>
    scriptRuns?: Iterable<ScriptStep>
    dockerRebuilt?: boolean
    manifest?: BuildCacheManifest
    stepOverrides?: Partial<BuildSteps>
    shouldRebuildStep?: BuildCache["shouldRebuildStep"]
}

afterEach(() => {
    Settings.projectPath = originalSettings.projectPath
    Settings.bspName = originalSettings.bspName
    Settings.isDevMode = originalSettings.isDevMode
    Settings.noChown = originalSettings.noChown
    Settings.clean = originalSettings.clean
    Settings.main = originalSettings.main
    Settings.bsp = originalSettings.bsp
    Settings.struxVersion = originalSettings.struxVersion
})

function configureBuildSettings(): void {
    Settings.projectPath = "/tmp/strux-build-test"
    Settings.bspName = "qemu"
    Settings.struxVersion = "test-version"
    Settings.isDevMode = false
    Settings.noChown = false
    Settings.clean = false
    Settings.main = {
        strux_version: "test-version",
        name: "test-project",
        bsp: "qemu",
        build: {
            cache: {
                enabled: true,
            },
        },
    } as any
    Settings.bsp = {
        name: "qemu",
        arch: "x86_64",
        boot: {
            kernel: {
                custom_kernel: false,
            },
            bootloader: {
                enabled: false,
            },
        },
    } as any
}

function setBspScripts(scripts: BSPScript[]): void {
    Settings.bsp = {
        ...Settings.bsp,
        scripts,
    } as any
}

function setCustomKernel(enabled: boolean): void {
    Settings.bsp = {
        ...Settings.bsp,
        boot: {
            ...Settings.bsp?.boot,
            kernel: {
                ...Settings.bsp?.boot?.kernel,
                custom_kernel: enabled,
            },
        },
    } as any
}

function setCacheEnabled(enabled: boolean): void {
    Settings.main = {
        ...Settings.main,
        build: {
            ...Settings.main?.build,
            cache: {
                ...Settings.main?.build?.cache,
                enabled,
            },
        },
    } as any
}

function cachedEntry(): StepCacheEntry {
    return {
        lastRun: "2026-04-24T00:00:00.000Z",
        dependencies: {},
        artifacts: [],
    }
}

function createManifest(steps: Partial<Record<BuildStep, StepCacheEntry>> = {}): BuildCacheManifest {
    return {
        version: "2.0",
        dockerImageHash: "old-image",
        struxVersion: "old-version",
        steps,
        bspScripts: {},
    }
}

function expectEventsInOrder(events: string[], expected: string[]): void {
    let lastIndex = -1
    for (const event of expected) {
        const nextIndex = events.indexOf(event)
        expect(nextIndex, `${event} should be present`).toBeGreaterThan(-1)
        expect(nextIndex, `${event} should happen after ${expected[Math.max(0, expected.indexOf(event) - 1)]}`).toBeGreaterThan(lastIndex)
        lastIndex = nextIndex
    }
}

function createDeps(options: HarnessOptions = {}): { deps: BuildDeps; events: string[]; manifest: BuildCacheManifest } {
    const events: string[] = []
    const manifest = options.manifest ?? createManifest()
    const rebuildSteps = new Set(options.rebuildSteps ?? [])
    const scriptRuns = new Set(options.scriptRuns ?? [])

    const step = (name: string) => async () => {
        events.push(`step:${name}`)
    }

    const baseSteps: BuildSteps = {
        compileFrontend: step("frontend"),
        compileApplication: step("application"),
        compileCage: step("cage"),
        compileWPE: step("wpe"),
        compileScreen: step("screen"),
        buildStruxClient: async (isDevMode: boolean) => {
            events.push(`step:client:${isDevMode}`)
        },
        copyClientBinaryIfExists: async (bspName: string) => {
            events.push(`step:copy-client:${bspName}`)
        },
        extractKernel: step("extract-kernel"),
        buildKernel: step("kernel"),
        buildBootloader: step("bootloader"),
        buildRootFS: step("rootfs-base"),
        writeDisplayConfig: async (bspName: string) => {
            events.push(`step:display:${bspName}`)
        },
        postProcessRootFS: step("rootfs-post"),
        updateDevEnvConfig: async (bspName: string) => {
            events.push(`step:dev-env:${bspName}`)
        },
    }

    const deps: BuildDeps = {
        logger: {
            log: (message: string) => events.push(`log:${message}`),
            success: (message: string) => events.push(`success:${message}`),
            debug: (message: string) => events.push(`debug:${message}`),
            cached: (message: string) => events.push(`cached:${message}`),
            errorWithExit: (message: string): never => {
                throw new Error(message)
            },
        },
        validators: {
            validateMainYAML: () => undefined,
            validateBSPYAML: () => undefined,
        },
        files: {
            fileExists: () => true,
            prepareBuildDirectories: async () => {
                events.push("files:prepare")
            },
            writeBuildMetadata: async (_bspName: string, metadata: BuildMetadata) => {
                events.push(`files:metadata:${metadata.buildMode}:${metadata.buildTime}`)
            },
        },
        cache: {
            loadBuildCacheManifest: async () => {
                events.push("cache:load-manifest")
                return manifest
            },
            saveBuildCacheManifest: async () => {
                events.push("cache:save-manifest")
            },
            shouldRebuildStep: options.shouldRebuildStep ?? (async (buildStep: BuildStep) => {
                events.push(`cache:check:${buildStep}`)
                return {
                    rebuild: rebuildSteps.has(buildStep),
                    reason: rebuildSteps.has(buildStep) ? "test rebuild" : undefined,
                }
            }),
            updateStepCache: async (buildStep: BuildStep) => {
                events.push(`cache:update:${buildStep}`)
                manifest.steps[buildStep] = cachedEntry()
            },
        },
        steps: {
            ...baseSteps,
            ...options.stepOverrides,
        },
        scripts: {
            runScriptsForStep: async (scriptStep: ScriptStep) => {
                events.push(`script:${scriptStep}`)
                return scriptRuns.has(scriptStep)
            },
        },
        runner: {
            skipChown: false,
            prepareDockerImage: async () => {
                events.push("runner:prepare-docker")
                return { imageHash: "new-image", rebuilt: options.dockerRebuilt ?? false }
            },
            chownProjectFiles: async () => {
                events.push("runner:chown")
            },
        },
        now: () => new Date("2026-04-24T12:00:00.000Z"),
    }

    return { deps, events, manifest }
}

test("runs uncached build steps through the build orchestration", async () => {
    configureBuildSettings()

    const { deps, events } = createDeps({
        rebuildSteps: [
            "frontend",
            "application",
            "cage",
            "wpe",
            "screen",
            "client",
            "rootfs-base",
            "rootfs-post",
        ],
    })

    await buildWithDeps(deps)

    expect(events.filter(event => event.startsWith("step:"))).toEqual([
        "step:frontend",
        "step:application",
        "step:cage",
        "step:wpe",
        "step:screen",
        "step:client:false",
        "step:rootfs-base",
        "step:display:qemu",
        "step:rootfs-post",
    ])
    expect(events).toContain("runner:chown")
    expect(events).toContain("files:metadata:production:2026-04-24T12:00:00.000Z")
    expect(deps.runner.skipChown).toBe(false)
})

test("refreshes cached dev client config without treating it as a rebuild", async () => {
    configureBuildSettings()
    Settings.isDevMode = true

    const { deps, events } = createDeps()

    await buildWithDeps(deps)

    expect(events.filter(event => event.startsWith("step:"))).toEqual([
        "step:copy-client:qemu",
        "step:dev-env:qemu",
        "step:display:qemu",
    ])
    expect(events).not.toContain("runner:chown")
    expect(events).toContain("files:metadata:dev:2026-04-24T12:00:00.000Z")
    expect(deps.runner.skipChown).toBe(false)
})

test("copies cached client binary and writes dev config inside the client hook window", async () => {
    configureBuildSettings()
    Settings.isDevMode = true

    const { deps, events } = createDeps()

    await buildWithDeps(deps)

    expectEventsInOrder(events, [
        "script:before_client",
        "cache:check:client",
        "step:copy-client:qemu",
        "step:dev-env:qemu",
        "script:after_client",
    ])
})

test("invalidates step cache when the docker image is rebuilt", async () => {
    configureBuildSettings()

    const manifest = createManifest({
        frontend: cachedEntry(),
        application: cachedEntry(),
    })
    const { deps, events } = createDeps({
        dockerRebuilt: true,
        manifest,
        shouldRebuildStep: async (buildStep, currentManifest) => {
            events.push(`cache:check:${buildStep}:${Object.keys(currentManifest.steps).join(",")}`)
            return { rebuild: false }
        },
    })

    await buildWithDeps(deps)

    expect(events).toContain("log:Docker image rebuilt, invalidating all cached steps...")
    expect(events).toContain("cache:check:frontend:")
})

test("does not chown when noChown is enabled", async () => {
    configureBuildSettings()
    Settings.noChown = true

    const { deps, events } = createDeps({ rebuildSteps: ["frontend"] })

    await buildWithDeps(deps)

    expect(events).toContain("step:frontend")
    expect(events).not.toContain("runner:chown")
    expect(deps.runner.skipChown).toBe(false)
})

test("writes display config after rootfs hooks and before rootfs-post cache decision", async () => {
    configureBuildSettings()

    const { deps, events } = createDeps({ rebuildSteps: ["rootfs-post"] })

    await buildWithDeps(deps)

    expectEventsInOrder(events, [
        "script:before_rootfs",
        "cache:check:rootfs-base",
        "script:after_rootfs",
        "step:display:qemu",
        "cache:check:rootfs-post",
        "step:rootfs-post",
        "cache:update:rootfs-post",
    ])
})

test("writes display config even when rootfs-post is cached", async () => {
    configureBuildSettings()

    const { deps, events } = createDeps()

    await buildWithDeps(deps)

    expectEventsInOrder(events, [
        "script:after_rootfs",
        "step:display:qemu",
        "cache:check:rootfs-post",
    ])
    expect(events).not.toContain("step:rootfs-post")
})

test("resets skipChown after a build step failure", async () => {
    configureBuildSettings()

    const { deps, events } = createDeps({
        rebuildSteps: ["frontend"],
        stepOverrides: {
            compileFrontend: async () => {
                events.push("step:frontend")
                throw new Error("frontend failed")
            },
        },
    })

    await expect(buildWithDeps(deps)).rejects.toThrow("frontend failed")

    expect(events).toContain("runner:chown")
    expect(deps.runner.skipChown).toBe(false)
})

test("runs all non-conditional steps when build cache is disabled", async () => {
    configureBuildSettings()
    setCacheEnabled(false)

    const { deps, events } = createDeps()

    await buildWithDeps(deps)

    expect(events.filter(event => event.startsWith("step:"))).toEqual([
        "step:frontend",
        "step:application",
        "step:cage",
        "step:wpe",
        "step:screen",
        "step:client:false",
        "step:rootfs-base",
        "step:display:qemu",
        "step:rootfs-post",
    ])
    expect(events.some(event => event.startsWith("cache:check:"))).toBe(false)
    expect(events.some(event => event.startsWith("cache:update:"))).toBe(false)
})

test("writes build metadata after final BSP image hooks", async () => {
    configureBuildSettings()

    const { deps, events } = createDeps()

    await buildWithDeps(deps)

    expectEventsInOrder(events, [
        "script:before_bundle",
        "script:make_image",
        "script:after_build",
        "files:metadata:production:2026-04-24T12:00:00.000Z",
        "success:Build completed successfully!",
    ])
})

test("prepares build directories before loading cache or preparing docker", async () => {
    configureBuildSettings()

    const { deps, events } = createDeps()

    await buildWithDeps(deps)

    expectEventsInOrder(events, [
        "files:prepare",
        "cache:load-manifest",
        "runner:prepare-docker",
        "cache:save-manifest",
    ])
})

test("uses custom kernel BSP script instead of built-in kernel steps", async () => {
    configureBuildSettings()
    setCustomKernel(true)
    setBspScripts([
        {
            step: "custom_kernel",
            location: "./kernel.sh",
        },
    ])

    const { deps, events } = createDeps({ scriptRuns: ["custom_kernel"] })

    await buildWithDeps(deps)

    expect(events).toContain("script:custom_kernel")
    expect(events).not.toContain("step:extract-kernel")
    expect(events).not.toContain("step:kernel")
    expect(events).toContain("runner:chown")
})

test("runs built-in kernel extract, hook, build, and cache update in order", async () => {
    configureBuildSettings()
    setCustomKernel(true)

    const { deps, events } = createDeps({ rebuildSteps: ["kernel"] })

    await buildWithDeps(deps)

    expect(events.filter(event => [
        "script:before_kernel",
        "cache:check:kernel",
        "step:extract-kernel",
        "script:after_kernel_extract",
        "step:kernel",
        "cache:update:kernel",
        "script:after_kernel",
    ].includes(event))).toEqual([
        "script:before_kernel",
        "cache:check:kernel",
        "step:extract-kernel",
        "script:after_kernel_extract",
        "step:kernel",
        "cache:update:kernel",
        "script:after_kernel",
    ])
})

test("chowns when only a BSP script ran", async () => {
    configureBuildSettings()

    const { deps, events } = createDeps({ scriptRuns: ["before_build"] })

    await buildWithDeps(deps)

    expect(events).toContain("script:before_build")
    expect(events).toContain("runner:chown")
})
