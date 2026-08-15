import prompts from "prompts"
import type { StruxProfile } from "../types/main-yaml"

export interface ResolveProfileOptions {
    profiles?: StruxProfile[]
    bspName: string
    override?: string | null
    interactive?: boolean
    prompt?: (profiles: StruxProfile[], message: string) => Promise<string | undefined>
}

async function promptForProfile(profiles: StruxProfile[], message: string): Promise<string | undefined> {
    const response = await prompts({
        type: "select",
        name: "profileName",
        message,
        choices: profiles.map((profile) => ({
            title: profile.label,
            description: profile.name,
            value: profile.name,
        })),
    }, {
        onCancel: () => false,
    })

    return typeof response.profileName === "string" ? response.profileName : undefined
}

/**
 * Resolves the profile to bake into an image.
 *
 * An explicit override wins regardless of BSP membership. Otherwise a sole
 * matching profile is automatic, while zero or multiple matches require a
 * user choice. Projects without a profiles section retain the old behavior.
 */
export async function resolveProfile(options: ResolveProfileOptions): Promise<StruxProfile | null> {
    const profiles = options.profiles ?? []
    const override = options.override?.trim()

    if (profiles.length === 0) {
        if (override) {
            throw new Error(`Profile "${override}" was requested, but strux.yaml does not define profiles.`)
        }
        return null
    }

    if (override) {
        const selected = profiles.find((profile) => profile.name === override)
        if (!selected) {
            const available = profiles.map((profile) => profile.name).join(", ")
            throw new Error(`Unknown profile "${override}". Available profiles: ${available}`)
        }
        return selected
    }

    const matches = profiles.filter((profile) => profile.bsp.includes(options.bspName))
    if (matches.length === 1) return matches[0]!

    const choices = matches.length > 1 ? matches : profiles
    const reason = matches.length > 1
        ? `BSP "${options.bspName}" matches multiple profiles.`
        : `BSP "${options.bspName}" does not match a profile.`

    const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)
    if (!interactive) {
        throw new Error(`${reason} Re-run with --profile <name>.`)
    }

    const prompt = options.prompt ?? promptForProfile
    const selectedName = await prompt(
        choices,
        matches.length > 1
            ? `Select a profile for BSP ${options.bspName}`
            : `Select a profile to use for BSP ${options.bspName}`
    )
    const selected = choices.find((profile) => profile.name === selectedName)
    if (!selected) throw new Error("Profile selection was cancelled.")

    return selected
}
