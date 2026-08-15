import { expect, test } from "bun:test"
import { StruxYamlSchema, type StruxProfile } from "../types/main-yaml"
import { resolveProfile } from "./profile"

const profiles: StruxProfile[] = [
    {
        name: "touch",
        label: "Touch display",
        bsp: ["qemu", "panel-a"],
    },
    {
        name: "wallboard",
        label: "Wallboard",
        bsp: ["qemu", "panel-b"],
    },
]

test("resolveProfile preserves projects without profiles", async () => {
    expect(await resolveProfile({ bspName: "qemu", interactive: false })).toBeNull()
})

test("resolveProfile automatically selects the sole BSP match", async () => {
    const selected = await resolveProfile({ profiles, bspName: "panel-a", interactive: false })
    expect(selected?.name).toBe("touch")
})

test("resolveProfile accepts an override outside the profile BSP list", async () => {
    const selected = await resolveProfile({
        profiles,
        bspName: "panel-a",
        override: "wallboard",
        interactive: false,
    })
    expect(selected?.name).toBe("wallboard")
})

test("resolveProfile prompts only with matching profiles when a BSP has multiple matches", async () => {
    let offered: string[] = []
    const selected = await resolveProfile({
        profiles,
        bspName: "qemu",
        interactive: true,
        prompt: async (choices) => {
            offered = choices.map((profile) => profile.name)
            return "wallboard"
        },
    })

    expect(offered).toEqual(["touch", "wallboard"])
    expect(selected?.name).toBe("wallboard")
})

test("resolveProfile prompts with every profile when the BSP has no match", async () => {
    let offered: string[] = []
    const selected = await resolveProfile({
        profiles,
        bspName: "unknown-board",
        interactive: true,
        prompt: async (choices) => {
            offered = choices.map((profile) => profile.name)
            return "touch"
        },
    })

    expect(offered).toEqual(["touch", "wallboard"])
    expect(selected?.name).toBe("touch")
})

test("resolveProfile requires --profile when an interactive choice is unavailable", async () => {
    await expect(resolveProfile({ profiles, bspName: "qemu", interactive: false }))
        .rejects.toThrow("Re-run with --profile <name>")
    await expect(resolveProfile({ profiles, bspName: "unknown-board", interactive: false }))
        .rejects.toThrow("Re-run with --profile <name>")
})

test("resolveProfile rejects an unknown override", async () => {
    await expect(resolveProfile({ profiles, bspName: "qemu", override: "missing", interactive: false }))
        .rejects.toThrow("Unknown profile \"missing\"")
})

test("profile schema requires unique names and BSPs within each profile", () => {
    const result = StruxYamlSchema.safeParse({
        project_version: "1.0.0",
        name: "example",
        bsp: "qemu",
        profiles: [
            { name: "touch", label: "Touch", bsp: ["qemu", "qemu"] },
            { name: "touch", label: "Other", bsp: ["panel-a"] },
        ],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
        expect(result.error.issues.map((issue) => issue.message)).toContain("Profile name must be unique: touch")
        expect(result.error.issues.map((issue) => issue.message)).toContain("BSP may only appear once in a profile: qemu")
    }
})
