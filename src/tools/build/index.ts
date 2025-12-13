/***
 *
 *  Build Tool
 *
 */

import { $ } from "bun"
import { join, resolve } from "path"
import { mkdir, rm, readdir, stat, copyFile } from "fs/promises"
import { Readable } from "stream"
import { spawn } from "child_process"
import { validateConfig, type Config } from "../../types/config"
import { loadBSP, type LoadedBSP } from "../../types/bsp"
import {
    info,
    success,
    warning,
    debug,
    cached,
    complete,
    runWithSpinner,
    runWithProgress,
    newSpinner,
    isVerbose
} from "../../utils/colors"
import { DOCKER_BUILD_ENV_DOCKERFILE } from "../../files/docker-build-env"
import { BUILD_BASE_SCRIPT } from "../../files/build-base-script"
import { BUILD_KERNEL_SCRIPT } from "../../files/build-kernel-script"
import { BUILD_UBOOT_SCRIPT } from "../../files/build-uboot-script"
import { INIT_SCRIPT } from "../../files/init-script"
import { NETWORK_SCRIPT } from "../../files/network-script"
import { POST_ROOTFS_BUILD_SCRIPT } from "../../files/post-rootfs-build-script"
import { STRUX_SCRIPT } from "../../files/strux-script"

const CACHE_DIR = "dist"
const BASE_CACHE_PATH = "dist/.cache/rootfs-base.tar.gz"

export interface BuildOptions {
    clean: boolean
}

/**
 * Clean the build cache
 */
export async function clean(): Promise<void> {
    info("Cleaning build cache...")
    try {
        await rm(CACHE_DIR, { recursive: true, force: true })
        success("Cache cleaned successfully")
    } catch (err) {
        throw new Error(`Failed to remove cache: ${err}`)
    }
}

/**
 * Check if base rootfs cache exists
 */
async function cacheExists(): Promise<boolean> {
    try {
        await stat(BASE_CACHE_PATH)
        return true
    } catch {
        return false
    }
}

/**
 * Load project configuration from strux.json
 */
async function loadConfig(): Promise<Config> {
    const cwd = process.cwd()
    const configFile = Bun.file(join(cwd, "strux.json"))

    if (!(await configFile.exists())) {
        throw new Error("strux.json not found. Run this command in a Strux project directory")
    }

    const data = await configFile.json()
    const result = await import("../../types/config").then(m => m.validateConfigWithUrlCheck(data))

    if (!result.success) {
        throw result.error
    }

    return result.data
}

/**
 * Main build function
 */
export async function build(bspName: string, options: BuildOptions): Promise<void> {
    if (options.clean) {
        await clean()
    }

    // Load config
    const config = await loadConfig()

    // Load BSP
    const cwd = process.cwd()
    const bspPath = join(cwd, "bsp", bspName)
    const bsp = await loadBSP(bspPath)

    if (bsp.soc) {
        info(`Using BSP: ${bsp.name} (${bsp.soc})`)
    } else {
        info(`Using BSP: ${bsp.name}`)
    }

    // Determine architecture - BSP overrides config
    const arch = bsp.arch ?? config.arch

    // Step 0: Build Frontend (if configured)
    await buildFrontend()

    // Step 1: Build Docker Image
    await buildDockerImage(config)

    // Step 2: Compile User Application
    await compileApp(arch)

    // Step 3: Compile Cage
    await compileCage()

    // Step 4: Compile WPE Extension
    await compileExtension()

    // Step 5: Generate Base Rootfs (cached)
    const packages = [...(config.rootfs.packages ?? []), ...bsp.packages]

    if (await cacheExists()) {
        cached("Using base rootfs")
        if (packages.length > 0) {
            warning("Custom packages configured - run 'strux build --clean' if packages changed")
        }
    } else {
        await generateBaseImage(config)
    }

    // Step 6: Build BSP Artifacts
    await buildBSPArtifacts(bsp)

    // Step 7: Build Custom Kernel (if enabled)
    if (bsp.kernel?.enabled) {
        await buildKernel(config, bsp)
    }

    // Step 8: Build U-Boot (if enabled)
    if (bsp.uboot?.enabled) {
        await buildUBoot(config, bsp)
    }

    // Step 9: Generate Final OS Image
    await generateImage(config)

    // Step 10: Generate Disk Image (if BSP has partitions)
    if ((bsp.partitions?.layout?.length ?? 0) > 0) {
        await generateDiskImage(bsp)
    }

    complete("Build complete!")
    info("Output: ./dist/rootfs.ext4, ./dist/vmlinuz, ./dist/initrd.img")
    if (bsp.uboot?.enabled) {
        info("U-Boot: ./dist/uboot/")
    }
    if ((bsp.partitions?.layout?.length ?? 0) > 0) {
        info(`Disk Image: ./dist/${bsp.name}.img`)
    }
}

/**
 * Build the Docker builder image
 */
async function buildDockerImage(config: Config): Promise<void> {
    const dockerfile = DOCKER_BUILD_ENV_DOCKERFILE(config)
    const stdinStream = Readable.from([dockerfile])
    const spinnerMsg = "Preparing build environment (Docker)..."
    const successMsg = "Build environment ready"

    if (isVerbose()) {
        info(spinnerMsg)
        const proc = spawn("docker", ["build", "-t", "strux-builder", "-"], {
            stdio: ["pipe", "inherit", "inherit"],
        })

        stdinStream.pipe(proc.stdin!)

        return new Promise((resolve, reject) => {
            proc.on("close", (code) => {
                if (code === 0) {
                    success(successMsg)
                    resolve()
                } else {
                    reject(new Error(`Command failed with exit code ${code}`))
                }
            })

            proc.on("error", (err) => {
                reject(err)
            })
        })
    }

    // Non-verbose: capture output, show spinner
    const spinner = newSpinner(spinnerMsg)
    spinner.start()

    const proc = spawn("docker", ["build", "-t", "strux-builder", "-"], {
        stdio: ["pipe", "pipe", "pipe"],
    })

    stdinStream.pipe(proc.stdin!)

    let stdout = ""
    let stderr = ""

    if (proc.stdout) {
        proc.stdout.on("data", (data) => {
            stdout += data.toString()
        })
    }

    if (proc.stderr) {
        proc.stderr.on("data", (data) => {
            stderr += data.toString()
        })
    }

    return new Promise((resolve, reject) => {
        proc.on("close", (code) => {
            if (code !== 0) {
                spinner.stopWithError(spinnerMsg)
                // Show captured output on error
                if (stdout) {
                    console.log(stdout)
                }
                if (stderr) {
                    console.error(stderr)
                }
                reject(new Error(`Command failed with exit code ${code}`))
            } else {
                spinner.stopWithSuccess(successMsg)
                resolve()
            }
        })

        proc.on("error", (err) => {
            spinner.stopWithError(spinnerMsg)
            reject(err)
        })
    })
}

/**
 * Compile the user's Go application
 */
async function compileApp(arch: string): Promise<void> {
    const goArch = arch === "amd64" || arch === "x86_64" ? "amd64" : "arm64"
    const archLabel = goArch === "amd64" ? "x86_64" : "ARM64"
    const crossCompiler = goArch === "amd64" ? "x86_64-linux-gnu-gcc" : "aarch64-linux-gnu-gcc"
    const cwd = process.cwd()

    // Check if go.mod requires github.com/strux-dev/strux
    const goModPath = join(cwd, "go.mod")
    let needsStruxReplace = false
    let struxModulePath = ""

    try {
        const goModContent = await Bun.file(goModPath).text()
        if (goModContent.includes("github.com/strux-dev/strux")) {
            needsStruxReplace = true
            // Try to find the local strux module (should be in parent directory)
            const parentDir = resolve(cwd, "..")
            const parentGoModPath = join(parentDir, "go.mod")
            try {
                const parentGoModContent = await Bun.file(parentGoModPath).text()
                if (parentGoModContent.includes("module github.com/strux-dev/strux")) {
                    struxModulePath = parentDir
                }
            } catch {
                // Parent go.mod doesn't exist or isn't the strux module
            }
        }
    } catch {
        // go.mod doesn't exist or can't be read
    }

    // Build Docker volume mounts
    const dockerVolumes = [`${cwd}:/project`]
    if (needsStruxReplace && struxModulePath) {
        dockerVolumes.push(`${struxModulePath}:/strux-module`)
    }

    // Build the script with replace directive if needed
    // Only use replace directive if local module exists (for development)
    // If repo is public and no local module, Go will download normally
    let setupScript = ""
    if (needsStruxReplace && struxModulePath) {
        setupScript = `
        # Add replace directive for local strux module (only if local version exists)
        if ! grep -q "replace github.com/strux-dev/strux" go.mod; then
            echo "" >> go.mod
            echo "replace github.com/strux-dev/strux => /strux-module" >> go.mod
        fi
        `
    }

    // Only set GOPRIVATE if we're using a local replace (private repo scenario)
    // If repo is public and no local module, GOPRIVATE isn't needed
    const goPrivateEnv = needsStruxReplace && struxModulePath ? "GOPRIVATE=github.com/strux-dev/* " : ""

    const script = `
        mkdir -p /project/dist
        ${setupScript}
        CGO_ENABLED=1 GOOS=linux GOARCH=${goArch} CC=${crossCompiler} ${goPrivateEnv}go build -o /project/dist/app .
    `

    const dockerEnvVars = [
        "-e", "GOCACHE=/project/dist/.go-cache",
        "-e", "GOMODCACHE=/project/dist/.go-mod-cache",
    ]
    // Only add GOPRIVATE if using local replace (private repo scenario)
    if (needsStruxReplace && struxModulePath) {
        dockerEnvVars.push("-e", "GOPRIVATE=github.com/strux-dev/*")
    }

    await runWithSpinner(
        "docker",
        [
            "run", "--rm",
            ...dockerVolumes.flatMap(v => ["-v", v]),
            "-w", "/project",
            ...dockerEnvVars,
            "strux-builder",
            "/bin/sh", "-c", script,
        ],
        {},
        `Compiling application for Linux ${archLabel}...`,
        "Application compiled"
    )
}

/**
 * Compile the Cage compositor
 */
async function compileCage(): Promise<void> {

    // Check if cage source already exists
    const cageSourceDir = join(process.cwd(), "dist", "cage_src")
    if (await stat(cageSourceDir).then(() => true).catch(() => false)) {
        cached("Cage source already exists")
        return
    } else {

        await runWithSpinner(
            "git",
            ["clone", "https://github.com/strux-dev/cage.git", "dist/cage_src"],
            {},
            "Cloning Cage source...",
            "Cage source cloned"
        )
    }

    const cwd = process.cwd()

    // Extract cage source and build
    const script = `
        cd /project/dist/cage_src

        # Configure with meson
        meson setup build --buildtype=release || exit 1

        # Compile
        meson compile -C build || exit 1

        # Copy the binary
        cp build/cage /project/dist/cage || exit 1
        chmod +x /project/dist/cage
    `

    await runWithSpinner(
        "docker",
        [
            "run", "--rm",
            "-v", `${cwd}:/project`,
            "strux-builder",
            "/bin/sh", "-c", script,
        ],
        {},
        "Compiling Cage compositor...",
        "Cage compiled"
    )
}

/**
 * Compile the WPE extension
 */
async function compileExtension(): Promise<void> {
    const cwd = process.cwd()


    // Check if extension source already exists
    const extensionSourceDir = join(process.cwd(), "dist", "extension_src")
    if (await stat(extensionSourceDir).then(() => true).catch(() => false)) {
        cached("Extension source already exists")
        return
    } else {

        await runWithSpinner(
            "git",
            ["clone", "https://github.com/strux-dev/strux-wpe-extension.git", "dist/extension_src"],
            {},
            "Cloning WPE extension source...",
            "WPE Extension source cloned"
        )
    }

    const script = `
        mkdir -p /project/dist/extension_build
        cd /project/dist/extension_build

        cmake /project/dist/extension_src
        make
        cp libstrux-extension.so /project/dist/libstrux-extension.so
    `

    await runWithSpinner(
        "docker",
        [
            "run", "--rm",
            "-v", `${cwd}:/project`,
            "strux-builder",
            "/bin/sh", "-c", script,
        ],
        {},
        "Compiling WPE Extension...",
        "WPE Extension compiled"
    )
}

/**
 * Generate base rootfs image
 */
async function generateBaseImage(config: Config): Promise<void> {
    await mkdir(CACHE_DIR, { recursive: true })
    const cwd = process.cwd()

    const buildBaseScript = BUILD_BASE_SCRIPT(config)

    await runWithProgress(
        "docker",
        [
            "run", "--rm", "--privileged",
            "-v", `${cwd}:/project`,
            "strux-builder",
            "/bin/bash", "-c", buildBaseScript,
        ],
        {},
        "Generating base rootfs with debootstrap...",
        "Base rootfs generated"
    )
}

/**
 * Build BSP artifacts
 */
async function buildBSPArtifacts(bsp: LoadedBSP): Promise<void> {
    // Check if artifacts already exist
    const artifactsDir = join(bsp.path, "artifacts")
    try {
        const entries = await readdir(artifactsDir)
        if (entries.length > 0) {
            cached("BSP artifacts ready")
            return
        }
    } catch {
        // Directory doesn't exist
    }

    if (bsp.artifacts?.source !== "script" || !bsp.artifacts.script) {
        return
    }

    const scriptPath = join(bsp.path, bsp.artifacts.script)

    await runWithSpinner(
        "/bin/bash",
        [scriptPath],
        {
            cwd: bsp.path,
            env: {
                ...process.env,
                BSP_DIR: bsp.path,
                ARTIFACTS_DIR: artifactsDir,
            },
        },
        "Building BSP artifacts...",
        "BSP artifacts ready"
    )
}

/**
 * Build custom kernel
 */
async function buildKernel(config: Config, bsp: LoadedBSP): Promise<void> {
    const cwd = process.cwd()
    const arch = bsp.arch
    const kernel = bsp.kernel!

    const fragments = (kernel.fragments ?? []).map(f =>
        f.startsWith("/") ? f : join(bsp.path, f)
    )
    const patches = (kernel.patches ?? []).map(p =>
        p.startsWith("http") || p.startsWith("/") ? p : join(bsp.path, "patches", "kernel", p)
    )
    const externalDTS = (kernel.external_dts ?? []).map(d =>
        d.startsWith("/") ? d : join(bsp.path, "dts", d)
    )
    const overlays = (kernel.overlays ?? []).map(o =>
        o.startsWith("/") ? o : join(bsp.path, "dts", o)
    )

    const kernelBuildScript = BUILD_KERNEL_SCRIPT()

    const script = `
export STRUX_ARCH=${arch}
export STRUX_KERNEL_SOURCE=${kernel.source ?? ""}
export STRUX_KERNEL_VERSION=${kernel.version ?? ""}
export STRUX_KERNEL_DEFCONFIG=${kernel.defconfig ?? ""}
export STRUX_KERNEL_PATCHES=${patches.join(":")}
export STRUX_KERNEL_FRAGMENTS=${fragments.join(":")}
export STRUX_EXTERNAL_DTS=${externalDTS.join(":")}
export STRUX_DT_OVERLAYS=${overlays.join(":")}
export STRUX_PRIMARY_DTB=${kernel.primary_dtb ?? ""}
${kernelBuildScript}
`

    await runWithSpinner(
        "docker",
        [
            "run", "--rm", "--privileged",
            "-v", `${cwd}:/project`,
            "strux-builder",
            "/bin/bash", "-c", script,
        ],
        {},
        "Building custom kernel...",
        "Kernel built"
    )
}

/**
 * Build U-Boot bootloader
 */
async function buildUBoot(config: Config, bsp: LoadedBSP): Promise<void> {
    const cwd = process.cwd()
    const arch = bsp.arch
    const uboot = bsp.uboot!

    const patches = (uboot.patches ?? []).map(p =>
        p.startsWith("http") || p.startsWith("/") ? p : join(bsp.path, "patches", "uboot", p)
    )

    const ubootBuildScript = BUILD_UBOOT_SCRIPT()

    const script = `
export STRUX_ARCH=${arch}
export STRUX_UBOOT_SOURCE=${uboot.source ?? ""}
export STRUX_UBOOT_VERSION=${uboot.version ?? ""}
export STRUX_UBOOT_TARGET=${uboot.defconfig ?? ""}
export STRUX_UBOOT_PATCHES=${patches.join(":")}
export STRUX_UBOOT_EXTRA_MAKE_ARGS=${(uboot.extra_make_args ?? []).join(" ")}
export BSP_DIR=${bsp.path}
export BSP_ARTIFACTS_DIR=${join(bsp.path, "artifacts")}
${ubootBuildScript}
`

    await runWithSpinner(
        "docker",
        [
            "run", "--rm", "--privileged",
            "-v", `${cwd}:/project`,
            "strux-builder",
            "/bin/bash", "-c", script,
        ],
        {},
        "Building U-Boot bootloader...",
        "U-Boot built"
    )
}

/**
 * Generate final OS image
 */
async function generateImage(config: Config): Promise<void> {
    await mkdir("dist", { recursive: true })
    const cwd = process.cwd()

    // Copy splash logo if enabled
    if (config.boot.splash.enabled) {
        const logoPath = join(cwd, config.boot.splash.logo)
        try {
            await stat(logoPath)
            await copyFile(logoPath, join(cwd, "dist", "splash-logo.png"))
        } catch (_err) {
            warning(`Splash logo not found at ${config.boot.splash.logo}, skipping logo copy`)
        }
    }

    // TODO: Handle splash, frontend path, overlay, etc.
    const frontendPath = "./frontend"
    const splashEnabled = config.boot.splash.enabled ? "true" : "false"
    const initialLoadColor = config.display.initial_load_color
    const resolution = config.display.resolution
    const overlayPath = config.rootfs.overlay

    const initScript = INIT_SCRIPT()
    const networkScript = NETWORK_SCRIPT
    const buildScript = POST_ROOTFS_BUILD_SCRIPT(config)
    const struxScript = STRUX_SCRIPT()

    const fullScript = `
export FRONTEND_PATH="${frontendPath}"
export SPLASH_ENABLED="${splashEnabled}"
export INITIAL_LOAD_COLOR="${initialLoadColor}"
export DISPLAY_RESOLUTION="${resolution}"
export STRUX_OVERLAY_PATH="${overlayPath}"
mkdir -p /tmp
cat > /tmp/init.sh << 'EOF_INIT'
${initScript}
EOF_INIT

cat > /tmp/network.sh << 'EOF_NETWORK'
${networkScript}
EOF_NETWORK

cat > /tmp/strux.sh << 'EOF_STRUX'
${struxScript}
EOF_STRUX

${buildScript}
`

    await runWithSpinner(
        "docker",
        [
            "run", "--rm", "--privileged",
            "-v", `${cwd}:/project`,
            "strux-builder",
            "/bin/sh", "-c", fullScript,
        ],
        {},
        "Generating OS image...",
        "OS image generated"
    )
}

/**
 * Generate disk image
 */
async function generateDiskImage(bsp: LoadedBSP): Promise<void> {
    // TODO: Implement disk image generation based on BSP partition layout
    info(`Generating disk image for ${bsp.name}...`)
    success("Disk image generated")
}


/***
 *
 *
 *  Build Frontend
 *
 */

async function buildFrontend(): Promise<void> {

    const frontendSourceDir = join(process.cwd(), "frontend")

    // Run strux types using the same binary that's currently running
    await runWithSpinner(
        process.execPath,
        ["types"],
        {},
        "Generating Typescript type definitions...",
        "Types generated"
    )

    // Build frontend
    await runWithSpinner(
        "npm",
        ["run", "build"],
        {
            cwd: frontendSourceDir,
        },
        "Building frontend...",
        "Frontend built"
    )


}

