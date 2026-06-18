import { expect, test } from "bun:test"
import { normalizeBuilderTag, SettingsConfig } from "./settings"

test("normalizeBuilderTag converts branch names into Docker tag fragments", () => {
    expect(normalizeBuilderTag("feature/v0.3.0")).toBe("feature-v0.3.0")
    expect(normalizeBuilderTag("Bugfix/Docker Publish")).toBe("bugfix-docker-publish")
    expect(normalizeBuilderTag("--Feature///Remote Builder--")).toBe("feature-remote-builder")
})

test("builderImage uses the remote builder tag override when set", () => {
    const settings = new SettingsConfig()
    settings.struxVersion = "0.3.0"

    expect(settings.builderImage).toBe("ghcr.io/strux-sh/strux-builder:0.3.0")

    settings.remoteBuilderTag = normalizeBuilderTag("feature/v0.3.0")

    expect(settings.builderImage).toBe("ghcr.io/strux-sh/strux-builder:feature-v0.3.0")
})
