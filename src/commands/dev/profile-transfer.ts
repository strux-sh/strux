import { join } from "path"

export const DEVICE_PROFILE_UPDATE_PATH = "/strux/.profile-update.json"

export interface ProfileTransferPayload {
    data: string
    destPath: string
    removesProfile: boolean
}

/**
 * Creates the component payload used to synchronize profile state to a live
 * development device. A JSON null is an explicit tombstone: the boot script
 * removes stale on-device profile metadata instead of installing it.
 */
export async function createProfileTransferPayload(
    projectPath: string,
    bspName: string
): Promise<ProfileTransferPayload> {
    const profilePath = join(projectPath, "dist", "cache", bspName, "profile.json")
    const profileFile = Bun.file(profilePath)
    const exists = await profileFile.exists()
    const bytes = exists
        ? Buffer.from(await profileFile.arrayBuffer())
        : Buffer.from("null\n")

    return {
        data: bytes.toString("base64"),
        destPath: DEVICE_PROFILE_UPDATE_PATH,
        removesProfile: !exists,
    }
}
