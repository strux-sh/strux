/***
 *
 *
 *  Strux Types Command
 *
 */

import { $ } from "bun"
import { join, dirname } from "path"
import {
    type IntrospectionOutput,
    type MethodDef,
    type FieldDef,
    type StructDef,
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
 * Get the path to strux-introspect binary (in same directory as strux binary)
 */
function getIntrospectBinaryPath(): string {
    const binaryDir = getStruxBinaryDir()
    return join(binaryDir, "strux-introspect")
}

// Runtime types JSON structure from gen-runtime-types
interface RuntimeParamDef {
    name: string
    goType: string
    tsType: string
}

interface RuntimeMethodInfo {
    name: string
    params?: RuntimeParamDef[]
    returnType?: string
    hasError: boolean
}

interface RuntimeExtensionInfo {
    namespace: string
    subNamespace: string
    methods: RuntimeMethodInfo[]
}

interface RuntimeTypes {
    extensions: RuntimeExtensionInfo[]
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
    const binary = binaryPath ?? getIntrospectBinaryPath()

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

/**
 * Get the runtime types string from the already-generated strux-runtime.ts file
 * This file is generated during the build process, not on the fly
 */
function getRuntimeTypesString(): string {
    try {
        return STRUX_RUNTIME_TYPES
    } catch {
        // If we can't import it, return empty (user projects don't need runtime types)
        return ""
    }
}

/**
 * Generate TypeScript interface from runtime types JSON
 */
export function generateRuntimeTypesInterface(runtimeTypes: RuntimeTypes): string {
    const lines: string[] = []

    // Group extensions by namespace
    const namespaces = new Map<string, RuntimeExtensionInfo[]>()
    for (const ext of runtimeTypes.extensions) {
        if (!namespaces.has(ext.namespace)) {
            namespaces.set(ext.namespace, [])
        }
        namespaces.get(ext.namespace)!.push(ext)
    }

    // Generate interface for each namespace
    for (const [namespace, exts] of namespaces) {
        // Capitalize first letter for interface name
        const interfaceName = namespace.charAt(0).toUpperCase() + namespace.slice(1)

        lines.push(`interface ${interfaceName} {`)

        for (const ext of exts) {
            lines.push(`  ${ext.subNamespace}: {`)

            for (const method of ext.methods) {
                const params = (method.params ?? [])
                    .map(p => `${p.name}: ${p.tsType}`)
                    .join(", ")

                let returnType = "void"
                if (method.returnType) {
                    returnType = method.returnType
                    if (method.hasError) {
                        returnType += " | null"
                    }
                }
                returnType = `Promise<${returnType}>`

                lines.push(`    ${method.name}(${params}): ${returnType};`)
            }

            lines.push("  };")
        }

        lines.push("}")
    }

    return lines.join("\n")
}

/**
 * Generate TypeScript definition content from introspection data and runtime types
 */
export function generateTypeScriptDefinitions(
    introspection: IntrospectionOutput,
    runtimeTypesString: string
): string {
    const lines: string[] = []

    // Header - match the format from init
    lines.push("// Auto-generated Strux type definitions")
    lines.push("// Run 'strux types' to regenerate from Go code")
    lines.push("// This file is automatically generated. DO NOT EDIT")
    lines.push("")

    const { app, structs } = introspection

    // Generate and add Strux runtime types FIRST (matching init format)
    // Only include if we have runtime types (they're optional for user projects)
    if (runtimeTypesString) {
        lines.push("// Strux Runtime API")
        lines.push(runtimeTypesString)
        lines.push("")
    }

    const globalLines: string[] = []
    const appendInterfaceBlock = (block: string[]): void => {
        if (globalLines.length > 0 && globalLines[globalLines.length - 1] !== "") {
            globalLines.push("")
        }
        globalLines.push(...block)
    }

    // Generate interfaces for custom structs (excluding the app struct)
    const usedStructs = findUsedStructs(app, structs)
    for (const structName of usedStructs) {
        const structDef = structs[structName]
        if (structDef) {
            const block: string[] = [`interface ${structName} {`]
            for (const field of structDef.fields) {
                block.push(`  ${field.name}: ${field.tsType};`)
            }
            block.push("}")
            appendInterfaceBlock(block)
        }
    }

    // Generate the App interface inside the global scope
    const appBlock: string[] = [`interface ${app.name} {`]

    for (const field of app.fields) {
        appBlock.push(`  ${field.name}: ${field.tsType};`)
    }

    if (app.fields.length > 0 && app.methods.length > 0) {
        appBlock.push("")
    }

    for (const method of app.methods) {
        const params = formatMethodParams(method)
        const returnType = formatReturnType(method)
        appBlock.push(`  ${method.name}(${params}): ${returnType};`)
    }

    appBlock.push("}")
    appendInterfaceBlock(appBlock)

    if (globalLines.length > 0 && globalLines[globalLines.length - 1] !== "") {
        globalLines.push("")
    }

    // Generate Window interface augmentation with both user app and strux runtime
    globalLines.push("const strux: Strux;")
    globalLines.push("interface Window {")
    globalLines.push("  strux: Strux;")
    globalLines.push("  go: {")
    globalLines.push(`    ${app.packageName}: {`)
    globalLines.push(`      ${app.name}: ${app.name};`)
    globalLines.push("    }")
    globalLines.push("  }")
    globalLines.push("}")

    lines.push("// Global type declarations")
    lines.push("declare global {")
    for (const line of globalLines) {
        lines.push(line === "" ? "" : `  ${line}`)
    }
    lines.push("}")
    lines.push("")
    lines.push("export {};")

    return lines.join("\n")
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

        // Run introspection for user's app
        const introspection = await runIntrospection(mainGoPath, introspectBinaryPath)

        // Get runtime types string from the already-generated file (not generated on the fly)
        const runtimeTypesString = getRuntimeTypesString()

        // Generate TypeScript definitions from introspection and runtime types string
        const tsContent = generateTypeScriptDefinitions(introspection, runtimeTypesString)

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

// Helper functions

function formatMethodParams(method: MethodDef): string {
    return method.params
        .map((param, index) => {
            const name = param.name ?? `arg${index}`
            return `${name}: ${param.tsType}`
        })
        .join(", ")
}

function formatReturnType(method: MethodDef): string {
    let baseType = "void"

    const returnTypes = method.returnTypes
    if (returnTypes && returnTypes.length > 0) {
        if (returnTypes.length === 1) {
            // Single return value
            baseType = returnTypes[0]!.tsType
        } else {
            // Multiple return values - use tuple type
            const types = returnTypes.map(rt => rt.tsType)
            baseType = `[${types.join(", ")}]`
        }

        if (method.hasError) {
            baseType += " | null"
        }
    }

    return `Promise<${baseType}>`
}

function findUsedStructs(
    app: { fields: FieldDef[]; methods: MethodDef[] },
    structs: Record<string, StructDef>
): string[] {
    const used = new Set<string>()
    const knownStructNames = new Set(Object.keys(structs))

    // Check fields
    for (const field of app.fields) {
        checkTypeForStruct(field.tsType, knownStructNames, used)
    }

    // Check methods
    for (const method of app.methods) {
        for (const param of method.params) {
            checkTypeForStruct(param.tsType, knownStructNames, used)
        }
        if (method.returnTypes) {
            for (const rt of method.returnTypes) {
                checkTypeForStruct(rt.tsType, knownStructNames, used)
            }
        }
    }

    return Array.from(used)
}

function checkTypeForStruct(
    tsType: string,
    knownStructs: Set<string>,
    used: Set<string>
): void {
    // Remove array suffix
    const baseType = tsType.replace(/\[\]$/, "")

    if (knownStructs.has(baseType)) {
        used.add(baseType)
    }
}
