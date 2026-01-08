/***
 *
 *
 *  Main YAML (strux.yaml) Validation Schema
 *
 */

import { z } from "zod"
import { readFileSync } from "fs"
import { join } from "path"
import { Settings } from "../settings"
import { Logger } from "../utils/log"
import { fileExists } from "../utils/path"

// Boot splash configuration schema
const BootSplashSchema = z.object({
    enabled: z.boolean(),
    logo: z.string(),
    color: z.string().regex(/^[0-9A-Fa-f]{6}$/, "Color must be a 6-digit hex color"),
})

// Boot configuration schema
const BootSchema = z.object({
    splash: BootSplashSchema.optional(),
})

// RootFS configuration schema
const RootFSSchema = z.object({
    overlay: z.string().optional(),
    packages: z.array(z.string()).optional(),
})

// QEMU USB device schema
const QemuUsbDeviceSchema = z.object({
    vendor_id: z.union([z.string(), z.number()]),
    product_id: z.union([z.string(), z.number()]),
})

// QEMU configuration schema
const QemuSchema = z.object({
    enabled: z.boolean(),
    network: z.boolean(),
    usb: z.array(QemuUsbDeviceSchema).optional(),
    flags: z.array(z.string()).optional(),
})

// Build configuration schema
const BuildSchema = z.object({
    host_packages: z.array(z.string()).optional(),
})

// Dev server fallback host schema
const DevFallbackHostSchema = z.object({
    host: z.string(),
    port: z.number().int().positive(),
})

// Dev server configuration schema
const DevServerSchema = z.object({
    fallback_hosts: z.array(DevFallbackHostSchema).optional(),
    use_mdns_on_client: z.boolean(),
    client_key: z.string(),
})

// Dev configuration schema
const DevSchema = z.object({
    server: DevServerSchema.optional(),
})

// Main strux.yaml schema
export const StruxYamlSchema = z.object({
    strux_version: z.string(),
    name: z.string(),
    bsp: z.string(),
    hostname: z.string().optional(),
    boot: BootSchema.optional(),
    rootfs: RootFSSchema.optional(),
    qemu: QemuSchema.optional(),
    build: BuildSchema.optional(),
    dev: DevSchema.optional(),
})

export type StruxYaml = z.infer<typeof StruxYamlSchema>

export class MainYAMLValidator {

    public static schema = StruxYamlSchema

    /**
     * Validates the strux.yaml file and returns true if valid, false otherwise
     */
    public static validate(filePath?: string): boolean {
        const result = this.safeValidate(filePath)
        return result.success
    }

    /**
     * Safely validates the strux.yaml file and returns a result object
     */
    public static safeValidate(filePath?: string): {
        success: boolean
        data?: StruxYaml
        error?: z.ZodError | Error
    } {
        const yamlPath = filePath ?? join(Settings.projectPath, "strux.yaml")

        if (!fileExists(yamlPath)) {
            return {
                success: false,
                error: new Error(`strux.yaml file not found: ${yamlPath}`),
            }
        }

        try {
            const fileContent = readFileSync(yamlPath, "utf-8")
            const parsed = Bun.YAML.parse(fileContent)
            const result = StruxYamlSchema.safeParse(parsed)

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
     * Validates and loads the strux.yaml file into the Settings class
     * Throws an error if validation fails
     */
    public static validateAndLoad(filePath?: string): StruxYaml {
        const yamlPath = filePath ?? join(Settings.projectPath, "strux.yaml")

        if (!fileExists(yamlPath)) {
            Logger.errorWithExit(`strux.yaml file not found: ${yamlPath}`)
            // This will never execute, but satisfies TypeScript's return type check
            throw new Error("File not found")
        }

        try {
            const fileContent = readFileSync(yamlPath, "utf-8")
            const parsed = Bun.YAML.parse(fileContent)
            const validated = StruxYamlSchema.parse(parsed)

            // Load relevant fields into Settings if needed
            // Note: Settings already has projectName, but we could sync other fields here
            if (validated.name) {
                Settings.projectName = validated.name
            }

            if (validated.strux_version) Settings.projectVersion = validated.strux_version

            if (validated.bsp) Settings.bspName = validated.bsp

            Settings.main = validated

            return validated
        } catch (error) {
            if (error instanceof z.ZodError) {
                Logger.error("strux.yaml validation failed:")
                error.issues.forEach((issue: z.ZodIssue) => {
                    const path = issue.path.join(".")
                    Logger.error(`  ${path}: ${issue.message}`)
                })
                Logger.errorWithExit("Please fix the errors in strux.yaml and try again.")
                // This will never execute, but satisfies TypeScript's return type check
                throw new Error("Validation failed")
            }

            const errorMessage = error instanceof Error
                ? error.message
                : String(error)
            Logger.errorWithExit(`Failed to parse strux.yaml: ${errorMessage}`)
            // This will never execute, but satisfies TypeScript's return type check
            throw new Error("Parse failed")
        }
    }

}