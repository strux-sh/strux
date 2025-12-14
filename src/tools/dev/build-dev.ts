/***
 *
 *  Dev Build Tool - Builds dev-specific image
 *
 */

import { join } from "path"
import { mkdir, rm, readdir, stat, copyFile } from "fs/promises"
import { Readable } from "stream"
import { spawn } from "child_process"
import { type Config } from "../../types/config"
import { loadBSP, type LoadedBSP } from "../../types/bsp"
import {
    info,
    success,
    warning,
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
import { compileApp, loadConfig } from "../build"

const CACHE_DIR = "dist"
const BASE_CACHE_PATH = "dist/.cache/rootfs-base.tar.gz"

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

// loadConfig is imported from build module below

/**
 * Build Docker builder image
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
 * Generate dev OS image
 */
async function generateDevImage(config: Config): Promise<void> {
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

    // Determine frontend path - check for Vite/bundler output in frontend/dist
    let frontendPath = "./frontend"
    const viteDist = join(cwd, "frontend", "dist")
    try {
        const viteDistStat = await stat(viteDist)
        if (viteDistStat.isDirectory()) {
            frontendPath = "./frontend/dist"
            info("Using Vite build output: frontend/dist")
        }
    } catch {
        // frontend/dist doesn't exist, use frontend directly
    }
    const splashEnabled = config.boot.splash.enabled ? "true" : "false"
    const initialLoadColor = config.display.initial_load_color
    const resolution = config.display.resolution
    const overlayPath = config.rootfs.overlay

    const initScript = INIT_SCRIPT()
    const networkScript = NETWORK_SCRIPT
    const buildScript = POST_ROOTFS_BUILD_SCRIPT(config, true) // devMode = true
    const struxScript = STRUX_SCRIPT(true) // isDev = true for dev build

    const fullScript = `
export FRONTEND_PATH="${frontendPath}"
export SPLASH_ENABLED="${splashEnabled}"
export INITIAL_LOAD_COLOR="${initialLoadColor}"
export DISPLAY_RESOLUTION="${resolution}"
export STRUX_OVERLAY_PATH="${overlayPath}"
export STRUX_DEV_MODE=1
export STRUX_IS_DEV=1
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

    await runWithProgress(
        "docker",
        [
            "run", "--rm", "--privileged",
            "-v", `${cwd}:/project`,
            "strux-builder",
            "/bin/sh", "-c", fullScript,
        ],
        {},
        "Generating dev OS image...",
        "Dev OS image generated"
    )

    // Copy kernel and initrd with dev prefix (or reuse production if same)
    try {
        const vmlinuz = join(cwd, "dist", "vmlinuz")
        const initrd = join(cwd, "dist", "initrd.img")
        const devVmlinuz = join(cwd, "dist", "dev-vmlinuz")
        const devInitrd = join(cwd, "dist", "dev-initrd.img")

        // Copy kernel if it exists
        try {
            await stat(vmlinuz)
            await copyFile(vmlinuz, devVmlinuz)
            info("Copied kernel to dev-vmlinuz")
        } catch {
            warning("Kernel not found, dev image may need kernel")
        }

        // Copy initrd if it exists (should be created by build script)
        try {
            await stat(devInitrd)
            info("Dev initrd ready: dev-initrd.img")
        } catch {
            // Try copying production initrd as fallback
            try {
                await stat(initrd)
                await copyFile(initrd, devInitrd)
                info("Copied production initrd to dev-initrd.img")
            } catch {
                warning("Initrd not found, dev image may need initrd")
            }
        }
    } catch (err) {
        warning(`Error copying kernel/initrd: ${err}`)
    }
}

/**
 * Main dev build function
 */
export async function buildDevImage(bspName: string, clean = false): Promise<void> {
    if (clean) {
        info("Cleaning dev build cache...")
        try {
            await rm(CACHE_DIR, { recursive: true, force: true })
            success("Dev build cache cleaned")
        } catch (err) {
            throw new Error(`Failed to clean dev cache: ${err}`)
        }
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

    // Step 1: Build Docker Image
    await buildDockerImage(config)

    // Step 2: Compile User Application (for dev mount)
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
            warning("Custom packages configured - run 'strux dev --clean' if packages changed")
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

    // Step 9: Generate Dev OS Image
    await generateDevImage(config)

    complete("Dev build complete!")
    info("Output: ./dist/dev-rootfs.ext4, ./dist/dev-vmlinuz, ./dist/dev-initrd.img")
    if (bsp.uboot?.enabled) {
        info("U-Boot: ./dist/uboot/")
    }
}

