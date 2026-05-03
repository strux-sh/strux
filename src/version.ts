/***
 *
 *  Strux Version Detection
 *
 */

// @ts-ignore
import packageJson from "../package.json" with { type: "json" }

const envVersion = process.env.STRUX_VERSION?.trim()

// CI sets STRUX_VERSION via --define at compile time; local builds fall back to package.json
export const STRUX_VERSION = envVersion && envVersion.length > 0 ? envVersion : packageJson.version
