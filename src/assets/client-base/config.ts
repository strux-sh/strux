/***
 *
 *
 *  Dev Client Config Schema
 *
 */
import { z } from "zod"

// Fallback host configuration
export const FallbackHostSchema = z.object({
    host: z.string().min(1, "Host must be a non-empty string"),
    port: z.number().int().min(1).max(65535, "Port must be between 1 and 65535"),
})
export type FallbackHost = z.infer<typeof FallbackHostSchema>

// Dev client configuration schema
export const DevClientConfigSchema = z.object({
    clientKey: z.string(),
    useMDNS: z.boolean(),
    fallbackHosts: z.array(FallbackHostSchema).min(0),
})
export type DevClientConfig = z.infer<typeof DevClientConfigSchema>

// Validation functions
export function validateDevClientConfig(data: unknown): DevClientConfig {
    return DevClientConfigSchema.parse(data)
}

export function safeValidateDevClientConfig(data: unknown): {
    success: boolean
    data?: DevClientConfig
    error?: z.ZodError
} {
    const result = DevClientConfigSchema.safeParse(data)
    if (result.success) {
        return { success: true, data: result.data }
    }
    return { success: false, error: result.error }
}

