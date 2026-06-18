/***
 *
 *
 *  Strux Types Command
 *
 */

import { $ } from "bun"
import { join, dirname } from "path"
import { tmpdir } from "os"
import { unlink } from "node:fs/promises"
import {
    type IntrospectionOutput,
    validateIntrospection
} from "../../types/introspection"
import { STRUX_RUNTIME_TYPES } from "../../types/strux-runtime"

/**
 * Get the directory where the strux binary is located
 */
function getStruxBinaryDir(): string {
    // process.execPath gives us the path to the current executable (strux binary)
    return dirname(process.execPath)
}

/**
 * Get the path to strux-introspect binary
 * Priority: 1) parent of strux.yaml (local dev build), 2) same dir as strux binary, 3) OS PATH
 */
async function getIntrospectBinaryPath(): Promise<string> {
    // Check parent directory of strux.yaml (one level up from project root)
    const projectParent = dirname(process.cwd())
    const projectParentPath = join(projectParent, "strux-introspect")
    const projectParentFile = Bun.file(projectParentPath)
    if (await projectParentFile.exists()) {
        return projectParentPath
    }

    const binaryDir = getStruxBinaryDir()
    const localPath = join(binaryDir, "strux-introspect")

    // Check if binary exists in same directory as strux
    const localFile = Bun.file(localPath)
    if (await localFile.exists()) {
        return localPath
    }

    // If not found locally, check OS PATH
    try {
        const result = await $`which strux-introspect`.quiet()
        if (result.exitCode === 0) {
            const pathInEnv = result.stdout.toString().trim()
            if (pathInEnv) {
                return pathInEnv
            }
        }
    } catch {
        // If which fails, fall through to return local path anyway
    }

    // Return local path even if not found (will fail with better error message later)
    return localPath
}

export interface GenerateTypesOptions {
  // Path to the user's main.go file
  mainGoPath: string;
  // Path to output directory (default: frontend/)
  outputDir?: string;
  // Output filename (default: strux.d.ts)
  outputFilename?: string;
  // Path to introspection binary (optional, will use bundled binary if not provided)
  introspectBinaryPath?: string;
  // Local Go package directories that register BSP runtime extensions
  runtimeExtensionDirs?: string[];
}

export interface GenerateTypesResult {
  success: boolean;
  outputPath?: string;
  methodCount?: number;
  fieldCount?: number;
  structCount?: number;
  error?: string;
}

/**
 * Run the Go introspection tool and get JSON output
 */
export async function runIntrospection(
    mainGoPath: string,
    binaryPath?: string
): Promise<IntrospectionOutput> {
    const binary = binaryPath ?? await getIntrospectBinaryPath()

    try {
        const result = await $`${binary} ${mainGoPath}`.quiet()

        if (result.exitCode !== 0) {
            const stderr = result.stderr.toString()
            throw new Error(`strux-introspect failed with exit code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`)
        }

        const output = result.stdout.toString()
        if (!output.trim()) {
            throw new Error("strux-introspect produced no output")
        }

        const data = JSON.parse(output)
        return validateIntrospection(data)
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Failed to run introspection: ${error.message}`)
        }
        throw error
    }
}

async function runDTSGeneration(
    mainGoPath: string,
    runtimeExtensionDirs: string[],
    binaryPath?: string
): Promise<string> {
    const binary = binaryPath ?? await getIntrospectBinaryPath()
    const runtimeJSONPath = join(tmpdir(), `strux-runtime-types-${process.pid}-${Date.now()}.json`)

    await Bun.write(runtimeJSONPath, JSON.stringify(STRUX_RUNTIME_TYPES))

    try {
        const result = await $`${binary} ${mainGoPath} --runtime-dts ${runtimeExtensionDirs.filter(Boolean).join(",")} --runtime-json ${runtimeJSONPath}`.quiet()
        if (result.exitCode !== 0) {
            const stderr = result.stderr.toString().trim()
            throw new Error(`strux-introspect failed with exit code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`)
        }

        const output = result.stdout.toString()
        if (!output.trim()) {
            throw new Error("strux-introspect produced no DTS output")
        }
        return output
    } finally {
        await unlink(runtimeJSONPath).catch(() => {})
    }
}

/**
 * Generate .d.ts file from a Go main.go file
 */
export async function generateTypes(
    options: GenerateTypesOptions
): Promise<GenerateTypesResult> {
    const {
        mainGoPath,
        outputDir = join(dirname(mainGoPath), "frontend"),
        outputFilename = "strux.d.ts",
        introspectBinaryPath,
        runtimeExtensionDirs = [],
    } = options

    try {
    // Check if main.go exists
        const mainGoFile = Bun.file(mainGoPath)
        if (!(await mainGoFile.exists())) {
            return {
                success: false,
                error: `main.go not found at ${mainGoPath}`,
            }
        }

        const tsContent = await runDTSGeneration(mainGoPath, runtimeExtensionDirs, introspectBinaryPath)
        const introspection = await runIntrospection(mainGoPath, introspectBinaryPath)

        // Ensure output directory exists
        await $`mkdir -p ${outputDir}`.quiet()

        // Write the .d.ts file
        const outputPath = join(outputDir, outputFilename)
        await Bun.write(outputPath, tsContent)

        return {
            success: true,
            outputPath,
            methodCount: introspection.app.methods.length,
            fieldCount: introspection.app.fields.length,
            structCount: Object.keys(introspection.structs).length,
        }
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        }
    }
}
