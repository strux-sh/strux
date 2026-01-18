
/***
 *
 *
 *  Introspection Schema
 *
 */
import { z } from "zod"

// Type definition for a single type (Go and TypeScript representations)
export const TypeDefSchema = z.object({
    goType: z.string(),
    tsType: z.string(),
})
export type TypeDef = z.infer<typeof TypeDefSchema>;

// Field definition for struct fields
export const FieldDefSchema = z.object({
    name: z.string(),
    goType: z.string(),
    tsType: z.string(),
})
export type FieldDef = z.infer<typeof FieldDefSchema>;

// Parameter definition for method parameters
export const ParamDefSchema = z.object({
    name: z.string().optional(),
    goType: z.string(),
    tsType: z.string(),
})
export type ParamDef = z.infer<typeof ParamDefSchema>;

// Method definition
export const MethodDefSchema = z.object({
    name: z.string(),
    params: z.array(ParamDefSchema),
    returnTypes: z.array(TypeDefSchema),
    hasError: z.boolean(),
})
export type MethodDef = z.infer<typeof MethodDefSchema>;

// Struct definition
export const StructDefSchema = z.object({
    fields: z.array(FieldDefSchema),
})
export type StructDef = z.infer<typeof StructDefSchema>;

// App info - the main application struct
export const AppInfoSchema = z.object({
    name: z.string(),
    packageName: z.string(),
    fields: z.array(FieldDefSchema),
    methods: z.array(MethodDefSchema),
})
export type AppInfo = z.infer<typeof AppInfoSchema>;

// Extension method info
export const ExtensionMethodSchema = z.object({
    name: z.string(),
    paramCount: z.number(),
    paramTypes: z.array(z.string()),
})
export type ExtensionMethod = z.infer<typeof ExtensionMethodSchema>;

// Extension sub-namespace
export const ExtensionSubNamespaceSchema = z.object({
    methods: z.array(ExtensionMethodSchema),
})
export type ExtensionSubNamespace = z.infer<typeof ExtensionSubNamespaceSchema>;

// Full introspection output schema
export const IntrospectionOutputSchema = z.object({
    app: AppInfoSchema,
    structs: z.record(z.string(), StructDefSchema),
    extensions: z.record(
        z.string(),
        z.record(z.string(), ExtensionSubNamespaceSchema)
    ).optional(),
})
export type IntrospectionOutput = z.infer<typeof IntrospectionOutputSchema>;

// Validation functions
export function validateIntrospection(data: unknown): IntrospectionOutput {
    return IntrospectionOutputSchema.parse(data)
}

export function safeValidateIntrospection(data: unknown): {
  success: boolean;
  data?: IntrospectionOutput;
  error?: z.ZodError;
} {
    const result = IntrospectionOutputSchema.safeParse(data)
    if (result.success) {
        return { success: true, data: result.data }
    }
    return { success: false, error: result.error }
}
