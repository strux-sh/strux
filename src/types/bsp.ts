/***
 *
 *  BSP (Board Support Package) Types
 *
 */

import { z } from "zod"
import { join } from "path"

// Partition definition
export const PartitionSchema = z.object({
    name: z.string().optional(),
    source: z.enum(["rawcopy", "rootfs", "fat", "empty"]),
    file: z.string().optional(),
    offset: z.string().optional(),
    size: z.string().optional(),
    align: z.string().optional(),
    fstype: z.string().optional(),
    no_table: z.boolean().optional(),
    uuid: z.string().optional(),
})
export type Partition = z.infer<typeof PartitionSchema>

// Partition layout
export const PartitionLayoutSchema = z.object({
    table: z.enum(["gpt", "mbr"]).optional(),
    layout: z.array(PartitionSchema).default([]),
})
export type PartitionLayout = z.infer<typeof PartitionLayoutSchema>

// Artifacts configuration
export const ArtifactsConfigSchema = z.object({
    source: z.enum(["script", "download", "prebuilt"]).optional(),
    script: z.string().optional(),
    urls: z.record(z.string(), z.string()).optional(),
})
export type ArtifactsConfig = z.infer<typeof ArtifactsConfigSchema>

// Kernel configuration
export const KernelConfigSchema = z.object({
    enabled: z.boolean().default(false),
    source: z.string().optional(),
    version: z.string().optional(),
    defconfig: z.string().optional(),
    fragments: z.array(z.string()).default([]),
    patches: z.array(z.string()).default([]),
    external_dts: z.array(z.string()).default([]),
    primary_dtb: z.string().optional(),
    overlays: z.array(z.string()).default([]),
    extra_make_args: z.array(z.string()).default([]),
})
export type KernelConfig = z.infer<typeof KernelConfigSchema>

// U-Boot configuration
export const UBootConfigSchema = z.object({
    enabled: z.boolean().default(false),
    source: z.string().optional(),
    version: z.string().optional(),
    defconfig: z.string().optional(),
    patches: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    extra_make_args: z.array(z.string()).default([]),
    output_files: z.record(z.string(), z.string()).optional(),
})
export type UBootConfig = z.infer<typeof UBootConfigSchema>

// Flash configuration
export const FlashConfigSchema = z.object({
    script: z.string().optional(),
    instructions: z.string().optional(),
})
export type FlashConfig = z.infer<typeof FlashConfigSchema>

// Full BSP schema
export const BSPSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    arch: z.enum(["arm64", "amd64"]),
    soc: z.string().optional(),
    artifacts: ArtifactsConfigSchema.optional(),
    partitions: PartitionLayoutSchema.optional(),
    kernel: KernelConfigSchema.optional(),
    uboot: UBootConfigSchema.optional(),
    flash: FlashConfigSchema.optional(),
    packages: z.array(z.string()).default([]),
})

export type BSP = z.infer<typeof BSPSchema>

// BSP with path info (after loading)
export interface LoadedBSP extends BSP {
    path: string
}

// Validation function
export function validateBSP(data: unknown): BSP {
    return BSPSchema.parse(data)
}

// Safe validation
export function safeValidateBSP(data: unknown): { success: true; data: BSP } | { success: false; error: z.ZodError } {
    const result = BSPSchema.safeParse(data)
    if (result.success) {
        return { success: true, data: result.data }
    }
    return { success: false, error: result.error }
}

// Load BSP from directory
export async function loadBSP(bspDir: string): Promise<LoadedBSP> {
    const bspFile = join(bspDir, "bsp.json")

    const file = Bun.file(bspFile)
    if (!(await file.exists())) {
        throw new Error(`BSP file not found: ${bspFile}`)
    }

    const data = await file.json()
    const bsp = validateBSP(data)

    return {
        ...bsp,
        path: bspDir,
    }
}

// List available BSPs in a directory
export async function listBSPs(bspBaseDir: string): Promise<string[]> {
    const { readdir } = await import("fs/promises")
    try {
        const entries = await readdir(bspBaseDir, { withFileTypes: true })
        const bsps: string[] = []

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const bspJson = join(bspBaseDir, entry.name, "bsp.json")
                const file = Bun.file(bspJson)
                if (await file.exists()) {
                    bsps.push(entry.name)
                }
            }
        }

        return bsps
    } catch {
        return []
    }
}
