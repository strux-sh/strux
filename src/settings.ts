/***
 *
 *
 *  Settings Store
 *
 */

import path from "path"
import { directoryExists } from "./utils/path"
import { STRUX_VERSION } from "./version"
import type { StruxYaml } from "./types/main-yaml"
import type { BSPYaml } from "./types/bsp-yaml"

export type TemplateType = "vanilla" | "react" | "vue"
export type ArchType = "arm64" | "x86_64" | "armhf" | "host"

export function normalizeBuilderTag(value: string): string {
    const tag = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, "-")
        .replace(/^-+/g, "")
        .replace(/-+$/g, "")
        .replace(/-+/g, "-")

    return tag || "unknown"
}


export class SettingsConfig {

    verbose: boolean
    template: TemplateType
    arch: ArchType
    targetArch: ArchType
    projectName: string
    projectPath: string
    struxVersion: string
    clean: boolean
    projectVersion: string

    main: StruxYaml | null = null
    bsp: BSPYaml["bsp"] | null = null

    bspName: string | null = null

    isDevMode = false

    isRemoteOnly = false

    // Skip the initial build in dev mode (use existing artifacts)
    noRebuild = false

    // Skip file permission fixing (chown) after builds
    noChown = false

    // To show debug information from the QEMU system when it is running
    qemuSystemDebug = false

    // To show debug information from the dev server (log streams)
    devDebug = false

    // To show Vite dev server output
    devViteDebug = false

    // To show app output in dev mode (defaults to true)
    devAppDebug = true

    // Path to local strux repo for using local runtime during builds
    // When set, injects a go.mod replace directive and mounts the repo into Docker
    localRuntime: string | null = null

    // Whether strux is running inside the builder container (detected from STRUX_IN_CONTAINER env var)
    inContainer = false

    // Force local Docker image build instead of pulling from GHCR
    localBuilder = false

    // GHCR builder tag override, useful for testing branch-scoped CI images locally
    remoteBuilderTag: string | null = null

    // The GHCR image reference for the builder
    get builderImage(): string {
        return `ghcr.io/strux-sh/strux-builder:${this.remoteBuilderTag ?? this.struxVersion}`
    }


    constructor() {

        // Default Verbosity
        this.verbose = false

        // Detect if running inside the builder container
        if (process.env.STRUX_IN_CONTAINER === "1") {
            this.inContainer = true
            // Auto-enable verbose in container (CI environments want full output)
            if (!process.stdout.isTTY) {
                this.verbose = true
            }
        }

        // Default Template
        this.template = "vanilla"

        // Default Architecture (based on the host architecture)
        if (process.arch === "arm64") {
            this.arch = "arm64"
        } else if (process.arch === "arm") {
            this.arch = "armhf"
        } else {
            this.arch = "x86_64"
        }

        // Default Target Architecture (will be read from the project configuration, for now it will be the same as the host architecture)
        this.targetArch = this.arch

        // Default Project Name
        this.projectName = ""

        // Default Project Path
        // If a directory with projectName exists in current directory, use that
        // Otherwise, use the current working directory
        this.projectPath = this.calculateProjectPath()

        this.struxVersion = STRUX_VERSION

        this.projectVersion = "0.0.1"

        // Default Clean Flag
        this.clean = false
    }

    public calculateProjectPath() {

        const projectDirPath = path.join(process.cwd(), this.projectName)
        if (this.projectName && directoryExists(projectDirPath)) {
            this.projectPath = projectDirPath
        } else {
            this.projectPath = process.cwd()
        }

        return this.projectPath

    }


}


export const Settings = new SettingsConfig()
