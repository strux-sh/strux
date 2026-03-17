/***
 *
 *  Update Checker
 *
 */

import { Logger } from "./utils/log"
import { STRUX_VERSION } from "./version"

const PACKAGE_JSON_URL = "https://raw.githubusercontent.com/strux-sh/strux/main/package.json"

function isNewerVersion(remote: string, current: string): boolean {
    const parse = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0)
    const r = parse(remote)
    const c = parse(current)
    for (let i = 0; i < Math.max(r.length, c.length); i++) {
        const rn = r[i] ?? 0
        const cn = c[i] ?? 0
        if (rn > cn) return true
        if (rn < cn) return false
    }
    return false
}

export class UpdateCheckerClass {

    async checkForUpdates(): Promise<void> {
        try {
            const response = await fetch(PACKAGE_JSON_URL)
            if (!response.ok) return
            const pkg = (await response.json()) as { version?: string }
            const remoteVersion = pkg?.version
            if (!remoteVersion) return
            if (isNewerVersion(remoteVersion, STRUX_VERSION)) {
                // Newer version available - can notify user when wired up
                Logger.warning(`A new version of Strux is available: ${remoteVersion}`)
            }
        } catch {
            // Silently do nothing on network errors or parse failures
        }
    }

}

export const UpdateChecker = new UpdateCheckerClass()