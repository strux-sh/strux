/***
 *
 *
 *  BSP YAML (bsp.yaml) Validation Schema
 *
 */

import { z } from "zod"
import { readFileSync } from "fs"
import { join } from "path"
import { Settings } from "../settings"
import { Logger } from "../utils/log"
import { fileExists } from "../utils/path"

// Display configuration schema
const DisplaySchema = z.object({
    resolution: z.string(),
})

// Script step type schema
const ScriptStepSchema = z.enum([
    "before_build",
    "before_application",
    "after_application",
    "before_cage",
    "after_cage",
    "before_wpe",
    "after_wpe",
    "before_rootfs",
    "after_rootfs",
    "before_kernel",
    "after_kernel",
    "before_bootloader",
    "after_bootloader",
    "before_bundle",
    "after_build",
    "flash_script",
])

// Script configuration schema
const ScriptSchema = z.object({
    location: z.string(),
    step: ScriptStepSchema,
})

// Bootloader configuration schema
const BootloaderSchema = z.object({
    enabled: z.boolean(),
    type: z.enum(["grub", "u-boot"]).optional(),
    version: z.string().optional(),
    source: z.string().optional(),
    defconfig: z.string().optional(),
    fragments: z.array(z.string()).optional(),
    patches: z.array(z.string()).optional(),
})

// Device tree configuration schema
const DeviceTreeSchema = z.object({
    dts: z.string(),
    overlays: z.array(z.string()).optional(),
    include_paths: z.array(z.string()).optional(),
})

// Kernel configuration schema
const KernelSchema = z.object({
    custom_kernel: z.boolean(),
    source: z.string().optional(),
    version: z.string().optional(),
    defconfig: z.string().optional(),
    fragments: z.array(z.string()).optional(),
    patches: z.array(z.string()).optional(),
    device_tree: DeviceTreeSchema.optional(),
})

// Boot configuration schema
const BootSchema = z.object({
    bootloader: BootloaderSchema.optional(),
    kernel: KernelSchema.optional(),
})

// RootFS configuration schema
const RootFSSchema = z.object({
    overlay: z.string().optional(),
    packages: z.array(z.string()).optional(),
})

// BSP configuration schema
const BSPConfigSchema = z.object({
    name: z.string(),
    description: z.string(),
    display: DisplaySchema.optional(),
    arch: z.string(),
    hostname: z.string(),
    scripts: z.array(ScriptSchema).optional(),
    boot: BootSchema.optional(),
    rootfs: RootFSSchema.optional(),
})

// Main bsp.yaml schema
export const BSPYamlSchema = z.object({
    strux_version: z.string(),
    bsp: BSPConfigSchema,
})

export type BSPYaml = z.infer<typeof BSPYamlSchema>

export class BSPYamlValidator {

    public static schema = BSPYamlSchema

    /**
     * Validates the bsp.yaml file and returns true if valid, false otherwise
     */
    public static validate(filePath?: string): boolean {
        const result = this.safeValidate(filePath)
        return result.success
    }

    /**
     * Safely validates the bsp.yaml file and returns a result object
     */
    public static safeValidate(filePath?: string): {
        success: boolean
        data?: BSPYaml
        error?: z.ZodError | Error
    } {
        const yamlPath = filePath ?? this.getDefaultPath()

        if (!fileExists(yamlPath)) {
            return {
                success: false,
                error: new Error(`bsp.yaml file not found: ${yamlPath}`),
            }
        }

        try {
            const fileContent = readFileSync(yamlPath, "utf-8")
            const parsed = Bun.YAML.parse(fileContent)
            const result = BSPYamlSchema.safeParse(parsed)

            if (result.success) {
                return { success: true, data: result.data }
            }

            return { success: false, error: result.error }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error
                    ? error
                    : new Error(`Failed to parse YAML: ${String(error)}`),
            }
        }
    }

    /**
     * Validates and loads the bsp.yaml file into the Settings class
     * Throws an error if validation fails
     */
    public static validateAndLoad(filePath?: string, bspName?: string): BSPYaml {
        const yamlPath = filePath ?? this.getDefaultPath(bspName)

        if (!fileExists(yamlPath)) {
            Logger.errorWithExit(`bsp.yaml file not found: ${yamlPath}`)
            // This will never execute, but satisfies TypeScript's return type check
            throw new Error("File not found")
        }

        try {
            const fileContent = readFileSync(yamlPath, "utf-8")
            const parsed = Bun.YAML.parse(fileContent)
            const validated = BSPYamlSchema.parse(parsed)

            // Load relevant fields into Settings if needed
            if (validated.bsp.arch) {
                // Map arch values to Settings.ArchType
                const arch = validated.bsp.arch.toLowerCase()
                if (arch === "arm64" || arch === "aarch64") {
                    Settings.targetArch = "arm64"
                } else if (arch === "x86_64" || arch === "amd64") {
                    Settings.targetArch = "x86_64"
                }
            }

            // Store BSP config in Settings
            Settings.bsp = validated

            return validated
        } catch (error) {
            if (error instanceof z.ZodError) {
                Logger.error("bsp.yaml validation failed:")
                error.issues.forEach((issue: z.ZodIssue) => {
                    const path = issue.path.join(".")
                    Logger.error(`  ${path}: ${issue.message}`)
                })
                Logger.errorWithExit("Please fix the errors in bsp.yaml and try again.")
                // This will never execute, but satisfies TypeScript's return type check
                throw new Error("Validation failed")
            }

            const errorMessage = error instanceof Error
                ? error.message
                : String(error)
            Logger.errorWithExit(`Failed to parse bsp.yaml: ${errorMessage}`)
            // This will never execute, but satisfies TypeScript's return type check
            throw new Error("Parse failed")
        }
    }

    /**
     * Gets the default path for bsp.yaml based on Settings or provided BSP name
     */
    private static getDefaultPath(bspName?: string): string {
        // If BSP name is provided, use it
        if (bspName) {
            return join(Settings.projectPath, "bsp", bspName, "bsp.yaml")
        }

        // Otherwise, try to get BSP name from Settings.main if available
        if (Settings.main?.bsp) {
            return join(Settings.projectPath, "bsp", Settings.main.bsp, "bsp.yaml")
        }

        // Fallback: assume qemu (common default)
        return join(Settings.projectPath, "bsp", "qemu", "bsp.yaml")
    }

}

