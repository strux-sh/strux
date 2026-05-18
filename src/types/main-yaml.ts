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
import { assertSafeRelativePath, assertShellSafeText } from "../utils/sanitize"

function shellSafeString(label: string): z.ZodString {
    return z.string().superRefine((value, ctx) => {
        try {
            assertShellSafeText(value, label)
        } catch (error) {
            ctx.addIssue({
                code: "custom",
                message: error instanceof Error ? error.message : String(error)
            })
        }
    })
}

function shellSafeRelativePath(label: string): z.ZodString {
    return z.string().superRefine((value, ctx) => {
        try {
            assertSafeRelativePath(value, label)
        } catch (error) {
            ctx.addIssue({
                code: "custom",
                message: error instanceof Error ? error.message : String(error)
            })
        }
    })
}

// Boot splash configuration schema
const BootSplashSchema = z.object({
    enabled: z.boolean(),
    logo: shellSafeRelativePath("boot.splash.logo"),
    color: z.string().regex(/^[0-9A-Fa-f]{6}$/, "Color must be a 6-digit hex color"),
})

// Boot configuration schema
const BootSchema = z.object({
    splash: BootSplashSchema.optional(),
})

// Update configuration schema
const UpdateSchema = z.object({
    enabled: z.boolean().default(false),
    auto_bundle: z.boolean().default(false),
})

const SemverSchema = z.string().regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "Version must be valid semver, for example 1.2.3 or 1.2.3-beta.1"
)

// RootFS configuration schema
const RootFSSchema = z.object({
    overlay: shellSafeRelativePath("rootfs.overlay").optional(),
    packages: z.array(shellSafeString("rootfs.packages")).optional(),
})

// QEMU USB device schema
const QemuUsbDeviceSchema = z.object({
    vendor_id: z.string().regex(/^[0-9A-Fa-f]{4}$/, "USB vendor_id must be 4 hex digits"),
    product_id: z.string().regex(/^[0-9A-Fa-f]{4}$/, "USB product_id must be 4 hex digits"),
})

// QEMU configuration schema
const QemuSchema = z.object({
    enabled: z.boolean(),
    network: z.boolean(),
    usb: z.array(QemuUsbDeviceSchema).optional(),
    flags: z.array(shellSafeString("qemu.flags")).optional(),
})

// Cache configuration schema
const CacheConfigSchema = z.object({
    enabled: z.boolean().default(true),
    force_rebuild: z.array(z.string()).optional(),
    ignore_patterns: z.array(z.string()).optional(),
})

// Build configuration schema
const BuildSchema = z.object({
    host_packages: z.array(shellSafeString("build.host_packages")).optional(),
    cache: CacheConfigSchema.optional(),
})

// Dev server fallback host schema
const DevFallbackHostSchema = z.object({
    host: shellSafeString("dev.server.fallback_hosts.host"),
    port: z.number().int().positive(),
})

// Dev server configuration schema
const DevServerSchema = z.object({
    fallback_hosts: z.array(DevFallbackHostSchema).optional(),
    use_mdns_on_client: z.boolean(),
    client_key: z.string(),
})

// WebKit Inspector configuration schema
const DevInspectorSchema = z.object({
    enabled: z.boolean().default(false),
    port: z.number().int().positive().default(9223),
})

function isIPv4CIDRWithTwoUsableIPs(value: string): boolean {
    const parts = value.split("/")
    if (parts.length !== 2) {
        return false
    }

    const [address, prefix] = parts
    const prefixNumber = Number(prefix)
    if (!address || !Number.isInteger(prefixNumber) || prefixNumber < 0 || prefixNumber > 30) {
        return false
    }

    const octets = address.split(".")
    if (octets.length !== 4) {
        return false
    }

    return octets.every((octet) => {
        if (!/^\d{1,3}$/.test(octet)) {
            return false
        }
        const value = Number(octet)
        return Number.isInteger(value) && value >= 0 && value <= 255
    })
}

const DevUSBSchema = z.object({
    enabled: z.boolean().default(true),
    subnet: z.string()
        .refine(isIPv4CIDRWithTwoUsableIPs, "USB subnet must be an IPv4 CIDR with at least two usable addresses (e.g., 192.168.7.0/24)")
        .default("192.168.7.0/24"),
})

// Dev configuration schema
const DevSchema = z.object({
    server: DevServerSchema.optional(),
    inspector: DevInspectorSchema.optional(),
    usb: DevUSBSchema.optional(),
})

const OutputTransformSchema = z.union([
    z.enum(["normal", "0", "90", "180", "270", "flipped", "flipped-90", "flipped-180", "flipped-270"]),
    z.literal(0),
    z.literal(90),
    z.literal(180),
    z.literal(270),
]).transform(String)

// Display monitor configuration schema
const DisplayMonitorSchema = z.object({
    path: z.string(),
    resolution: z.string().regex(/^\d+x\d+$/, "Resolution must be in WIDTHxHEIGHT format (e.g., 1920x1080)").optional(),
    transform: OutputTransformSchema.optional(),
    names: z.array(z.string()).optional(),
    input_devices: z.array(z.string()).optional(),
})

// Display configuration schema
const DisplaySchema = z.object({
    monitors: z.array(DisplayMonitorSchema).min(1),
})

// Main strux.yaml schema
export const StruxYamlSchema = z.object({
    project_version: SemverSchema,
    name: shellSafeString("name"),
    bsp: shellSafeString("bsp"),
    hostname: shellSafeString("hostname").optional(),
    boot: BootSchema.optional(),
    update: UpdateSchema.optional(),
    display: DisplaySchema.optional(),
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

            Settings.projectVersion = validated.project_version

            // Only set bspName from strux.yaml if it wasn't already set by a CLI argument
            if (validated.bsp && !Settings.bspName) Settings.bspName = validated.bsp

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
