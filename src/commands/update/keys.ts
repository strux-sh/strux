import { generateKeyPairSync } from "node:crypto"
import { chmod, mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { Settings } from "../../settings"
import { fileExists } from "../../utils/path"

export const DEFAULT_UPDATE_PRIVATE_KEY = "strux-update.key"
export const DEFAULT_UPDATE_PUBLIC_KEY = "strux-update.pub"

export interface GenerateUpdateKeypairOptions {
    privateKey?: string
    publicKey?: string
    force?: boolean
}

export interface GeneratedUpdateKeypair {
    privateKeyPath: string
    publicKeyPath: string
}

function defaultPrivateKeyPath(): string {
    return join(Settings.projectPath, DEFAULT_UPDATE_PRIVATE_KEY)
}

function defaultPublicKeyPath(): string {
    return join(Settings.projectPath, DEFAULT_UPDATE_PUBLIC_KEY)
}

function generateUpdateSigningKeypair(): { privateKey: string, publicKey: string } {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 4096,
        publicExponent: 0x10001,
    })

    return {
        privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    }
}

export async function writeUpdateSigningKeypair(options: GenerateUpdateKeypairOptions = {}): Promise<GeneratedUpdateKeypair> {
    const privateKeyPath = resolve(options.privateKey ?? defaultPrivateKeyPath())
    const publicKeyPath = resolve(options.publicKey ?? defaultPublicKeyPath())

    if (!options.force) {
        if (fileExists(privateKeyPath)) {
            throw new Error(`Update private key already exists: ${privateKeyPath}. Pass --force to overwrite it.`)
        }
        if (fileExists(publicKeyPath)) {
            throw new Error(`Update public key already exists: ${publicKeyPath}. Pass --force to overwrite it.`)
        }
    }

    const keys = generateUpdateSigningKeypair()
    await mkdir(dirname(privateKeyPath), { recursive: true })
    await mkdir(dirname(publicKeyPath), { recursive: true })
    await Bun.write(privateKeyPath, keys.privateKey)
    await chmod(privateKeyPath, 0o600)
    await Bun.write(publicKeyPath, keys.publicKey)

    return { privateKeyPath, publicKeyPath }
}
