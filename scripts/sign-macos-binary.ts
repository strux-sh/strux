import { basename, resolve } from "node:path"

function fail(message: string): never {
    console.error(message)
    process.exit(1)
}

const binaryArgument = process.argv[2]

if (!binaryArgument) {
    fail("Usage: bun run scripts/sign-macos-binary.ts <binary>")
}

if (process.platform !== "darwin") {
    process.exit(0)
}

const binaryPath = resolve(binaryArgument)
const result = Bun.spawnSync(["codesign", "--force", "--sign", "-", binaryPath], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
})

if (result.exitCode !== 0) {
    fail(`Failed to apply an ad-hoc signature to ${basename(binaryPath)}`)
}

const verification = Bun.spawnSync(["codesign", "--verify", "--strict", binaryPath], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
})

if (verification.exitCode !== 0) {
    fail(`The ad-hoc signature for ${basename(binaryPath)} did not verify`)
}
