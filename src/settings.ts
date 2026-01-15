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
export type ArchType = "arm64" | "x86_64" | "armhf"


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

    // To show debug information from the QEMU system when it is running
    qemuSystemDebug = false


    constructor() {

        // Default Verbosity
        this.verbose = false

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