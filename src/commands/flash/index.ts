/***
 *
 *
 * Flash Command
 *
 * Runs BSP-defined host-side flashing scripts.
 *
 */

import { mkdir } from "fs/promises"
import { join } from "path"
import { Settings } from "../../settings"
import { MainYAMLValidator } from "../../types/main-yaml"
import { BSPYamlValidator } from "../../types/bsp-yaml"
import type { BSPScript, ScriptStep } from "../../types/bsp-yaml"
import { Logger } from "../../utils/log"
import { fileExists } from "../../utils/path"

export type FlashOutputSource = "stdout" | "stderr" | "system"

export interface FlashRunOptions {
    bspName?: string
    inheritStdio?: boolean
    onOutput?: (data: string, source: FlashOutputSource) => void
}

interface LoadedFlashConfig {
    bspName: string
    flashDir: string
    toolScripts: BSPScript[]
    flashScripts: BSPScript[]
}

function getScriptPath(script: BSPScript, bspName: string): string {
    const bspDir = join(Settings.projectPath, "bsp", bspName)
    return script.location.startsWith("./")
        ? join(bspDir, script.location.slice(2))
        : join(bspDir, script.location)
}

function getFlashEnv(step: ScriptStep, bspName: string, flashDir: string): Record<string, string> {
    const projectDir = Settings.projectPath
    const projectDistDir = join(projectDir, "dist")
    const env: Record<string, string> = {
        BSP_NAME: bspName,
        PRESELECTED_BSP: bspName,
        HOST_ARCH: Settings.arch,
        TARGET_ARCH: Settings.targetArch,
        STEP: step,
        STRUX_VERSION: Settings.struxVersion,
        PROJECT_DIR: projectDir,
        PROJECT_FOLDER: projectDir,
        PROJECT_DIST_DIR: projectDistDir,
        PROJECT_DIST_FOLDER: projectDistDir,
        PROJECT_DIST_ARTIFACTS_FOLDER: join(projectDistDir, "artifacts"),
        SHARED_CACHE_DIR: join(projectDistDir, "cache"),
        BSP_CACHE_DIR: join(projectDistDir, "cache", bspName),
        PROJECT_DIST_CACHE_FOLDER: join(projectDistDir, "cache", bspName),
        PROJECT_DIST_OUTPUT_FOLDER: join(projectDistDir, "output", bspName),
        PROJECT_DIST_FLASH_FOLDER: flashDir,
        FLASH_DIR: flashDir,
        BSP_FOLDER: join(projectDir, "bsp", bspName),
    }

    const splash = Settings.main?.boot?.splash
    if (splash) {
        env.SPLASH_ENABLED = splash.enabled ? "true" : "false"
        if (splash.logo) env.SPLASH_LOGO = splash.logo
        if (splash.color) env.SPLASH_COLOR = splash.color
    }

    const display = Settings.bsp?.display
    if (display) {
        env.DISPLAY_WIDTH = String(display.width)
        env.DISPLAY_HEIGHT = String(display.height)
    }

    return env
}

function emit(options: FlashRunOptions, message: string, source: FlashOutputSource = "system"): void {
    if (options.onOutput) {
        options.onOutput(message, source)
        return
    }

    if (source === "stderr") {
        process.stderr.write(message)
        return
    }

    if (source === "stdout") {
        process.stdout.write(message)
    }
}

async function streamOutput(
    stream: ReadableStream<Uint8Array>,
    source: FlashOutputSource,
    options: FlashRunOptions
): Promise<void> {
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
        emit(options, decoder.decode(chunk, { stream: true }), source)
    }
}

async function loadFlashConfig(options: FlashRunOptions): Promise<LoadedFlashConfig> {
    if (!fileExists(join(Settings.projectPath, "strux.yaml"))) {
        throw new Error("strux.yaml file not found. Please create it first.")
    }

    if (options.bspName) {
        Settings.bspName = options.bspName
    }

    MainYAMLValidator.validateAndLoad()

    const bspName = options.bspName ?? Settings.bspName
    if (!bspName) {
        throw new Error("BSP name not found. Please specify one or add a 'bsp' field to strux.yaml.")
    }
    Settings.bspName = bspName

    const bspYamlPath = join(Settings.projectPath, "bsp", bspName, "bsp.yaml")
    if (!fileExists(bspYamlPath)) {
        throw new Error(`BSP ${bspName} not found. Please create it first.`)
    }

    BSPYamlValidator.validateAndLoad(bspYamlPath, bspName)

    const flashDir = join(Settings.projectPath, "dist", "flash", bspName)
    await mkdir(flashDir, { recursive: true })

    const scripts = Settings.bsp?.scripts ?? []
    const toolScripts = scripts.filter((script) => script.step === "flash_script_tool")
    const flashScripts = scripts.filter((script) => script.step === "flash_script")

    if (flashScripts.length === 0) {
        throw new Error(`Not Available for this BSP: ${bspName} does not define a flash_script in bsp.yaml.`)
    }

    return { bspName, flashDir, toolScripts, flashScripts }
}

async function runHostScript(
    script: BSPScript,
    step: ScriptStep,
    config: LoadedFlashConfig,
    options: FlashRunOptions
): Promise<void> {
    const scriptName = script.description ?? script.location
    const scriptPath = getScriptPath(script, config.bspName)

    if (!fileExists(scriptPath)) {
        throw new Error(`Script ${scriptPath} for "${config.bspName}" BSP and step "${step}" not found. Please create it first.`)
    }

    if (options.onOutput) {
        emit(options, `Running BSP script: ${scriptName} (${step})\n`)
    } else {
        Logger.info(`Running BSP script: ${scriptName} (${step})`)
    }

    const stdio = options.inheritStdio
        ? { stdout: "inherit" as const, stderr: "inherit" as const, stdin: "inherit" as const }
        : { stdout: "pipe" as const, stderr: "pipe" as const, stdin: "ignore" as const }

    const proc = Bun.spawn(["/bin/bash", scriptPath], {
        cwd: config.flashDir,
        env: { ...process.env, ...getFlashEnv(step, config.bspName, config.flashDir) },
        ...stdio,
    })

    if (!options.inheritStdio) {
        if (!proc.stdout || !proc.stderr) {
            throw new Error(`Failed to capture output for BSP script "${scriptName}".`)
        }

        await Promise.all([
            streamOutput(proc.stdout, "stdout", options),
            streamOutput(proc.stderr, "stderr", options),
        ])
    }

    const exitCode = await proc.exited
    if (exitCode !== 0) {
        throw new Error(`BSP script "${scriptName}" failed with exit code ${exitCode}.`)
    }

    if (options.onOutput) {
        emit(options, `Completed BSP script: ${scriptName}\n`)
    } else {
        Logger.success(`Completed BSP script: ${scriptName}`)
    }
}

export async function runFlashScripts(options: FlashRunOptions = {}): Promise<void> {
    const config = await loadFlashConfig(options)

    if (options.onOutput) {
        emit(options, `Flash workspace: ${config.flashDir}\n`)
    } else {
        Logger.info(`Flash workspace: ${config.flashDir}`)
    }

    for (const script of config.toolScripts) {
        await runHostScript(script, "flash_script_tool", config, options)
    }

    for (const script of config.flashScripts) {
        await runHostScript(script, "flash_script", config, options)
    }
}

export async function flash(options: FlashRunOptions = {}): Promise<void> {
    await runFlashScripts({ ...options, inheritStdio: options.inheritStdio ?? true })
}
