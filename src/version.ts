/***
 *
 *  Strux Version Detection
 *
 */

const envVersion = process.env.STRUX_VERSION?.trim()

// Default to the development version when no build-time override is provided
export const STRUX_VERSION = envVersion && envVersion.length > 0 ? envVersion : "0.0.1"
