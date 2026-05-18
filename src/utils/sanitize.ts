const SHELL_UNSAFE_PATTERNS: { pattern: RegExp; label: string }[] = [
    { pattern: /\$\(/, label: "$(" },
    { pattern: /\$\{/, label: "${" },
    { pattern: /\$/, label: "$" },
    { pattern: /`/, label: "`" },
    { pattern: /[;&|<>]/, label: "shell control operator" },
    { pattern: /[\r\n]/, label: "line break" },
    { pattern: /\0/, label: "null byte" },
]

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/].+/

function describeValue(label: string, value: string): string {
    const preview = value.length > 80 ? `${value.slice(0, 77)}...` : value
    return `${label} "${preview}"`
}

export function assertShellSafeText(value: string, label: string): void {
    for (const { pattern, label: patternLabel } of SHELL_UNSAFE_PATTERNS) {
        if (pattern.test(value)) {
            throw new Error(`${describeValue(label, value)} contains disallowed shell syntax: ${patternLabel}`)
        }
    }
}

export function assertShellSafeEnv(env: Record<string, string | undefined>, label = "environment variable"): void {
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue
        assertShellSafeText(value, `${label} ${key}`)
    }
}

export function assertShellSafeList(values: string[] | undefined, label: string): void {
    if (!values) return

    for (const value of values) {
        assertShellSafeText(value, label)
    }
}

export function assertSafeRelativePath(value: string, label: string): void {
    assertShellSafeText(value, label)

    if (value.trim() !== value || value === "") {
        throw new Error(`${describeValue(label, value)} must be a non-empty relative path without leading or trailing whitespace`)
    }

    if (value.startsWith("/") || WINDOWS_DRIVE_PATH.test(value)) {
        throw new Error(`${describeValue(label, value)} must be relative`)
    }
}

export function splitSafeCommand(command: string): string[] {
    assertShellSafeText(command, "command")

    const args = command.trim().split(/\s+/).filter(Boolean)
    if (args.length === 0) {
        throw new Error("command must not be empty")
    }

    return args
}
