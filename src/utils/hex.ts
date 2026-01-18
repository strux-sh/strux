/***
 *
 *
 *  Hex Utility Functions
 *
 */

export function normalizeHex(id: string): string {
    return id.toLowerCase().replace(/^0x/, "").padStart(4, "0")
}

export function normalizeUSBID(id: string): { primary: string } {
    const trimmed = id.trim()
    return { primary: normalizeHex(trimmed) }
}