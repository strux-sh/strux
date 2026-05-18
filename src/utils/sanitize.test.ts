import { expect, test } from "bun:test"
import { StruxYamlSchema } from "../types/main-yaml"
import { BSPYamlSchema } from "../types/bsp-yaml"
import {
    assertSafeRelativePath,
    assertShellSafeEnv,
    assertShellSafeText,
    splitSafeCommand
} from "./sanitize"

test("rejects shell command substitution syntax", () => {
    expect(() => assertShellSafeText("hello $(touch /tmp/pwned)", "value")).toThrow("disallowed shell syntax")
    expect(() => assertShellSafeText("hello `touch /tmp/pwned`", "value")).toThrow("disallowed shell syntax")
    expect(() => assertShellSafeText("hello ${USER}", "value")).toThrow("disallowed shell syntax")
})

test("rejects shell control operators in command strings", () => {
    expect(() => splitSafeCommand("echo ok; touch /tmp/pwned")).toThrow("disallowed shell syntax")
    expect(() => splitSafeCommand("echo ok && touch /tmp/pwned")).toThrow("disallowed shell syntax")
    expect(() => splitSafeCommand("echo ok | sh")).toThrow("disallowed shell syntax")
})

test("rejects unsafe environment values", () => {
    expect(() => assertShellSafeEnv({ SPLASH_LOGO: "./assets/$(touch pwned).png" })).toThrow("SPLASH_LOGO")
})

test("rejects unsafe relative paths", () => {
    expect(() => assertSafeRelativePath("./scripts/$(touch pwned).sh", "script")).toThrow("disallowed shell syntax")
    expect(() => assertSafeRelativePath("/tmp/script.sh", "script")).toThrow("must be relative")
})

test("strux yaml rejects unsafe qemu flags", () => {
    const result = StruxYamlSchema.safeParse({
        project_version: "0.3.0",
        name: "test",
        bsp: "qemu",
        qemu: {
            enabled: true,
            network: true,
            flags: ["-m 2G", "$(touch /tmp/pwned)"]
        }
    })

    expect(result.success).toBe(false)
})

test("bsp yaml accepts multiline config fragments", () => {
    const result = BSPYamlSchema.safeParse({
        strux_version: "0.3.0",
        bsp: {
            name: "qemu",
            description: "QEMU virtual machine for testing",
            display: { resolution: "1920x1080" },
            arch: "host",
            hostname: "qemu",
            boot: {
                bootloader: {
                    enabled: true,
                    fragments: [
                        "CONFIG_SILENT_CONSOLE=n\nCONFIG_CMD_SYSBOOT=y\nCONFIG_BMP_24BPP=y\n"
                    ]
                },
                kernel: {
                    custom_kernel: true,
                    fragments: [
                        "CONFIG_USB_GADGET=y\nCONFIG_USB_LIBCOMPOSITE=y\nCONFIG_USB_CONFIGFS=y\n"
                    ]
                }
            }
        }
    })

    expect(result.success).toBe(true)
})
