import { readFileSync, realpathSync } from "node:fs"
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path"
import { Settings } from "../settings"
import { directoryExists, fileExists } from "./path"
import type { DockerMount } from "./run"

interface PackageManifest {
    name?: string
    workspaces?: string[] | { packages?: string[] }
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
}

interface WorkspacePackage {
    directory: string
    manifest: PackageManifest
}

export interface FrontendLayout {
    projectDirectory: string
    frontendDirectory: string
    outputDirectory: string
    installDirectory: string
    workspaceRoot: string | null
    workspacePackage: string | null
    workspacePackageDirectories: string[]
    buildScript: string
    devScript: string
    containerProjectDirectory: string
    containerFrontendDirectory: string
    containerOutputDirectory: string
    containerInstallDirectory: string
    containerNodeModulesDirectories: string[]
    cacheFiles: string[]
    cacheDirectories: string[]
}

const CONTAINER_WORKSPACE_ROOT = "/workspace"
const CONTAINER_PROJECT_ROOT = "/project"

function readPackageManifest(filePath: string, label: string): PackageManifest {
    if (!fileExists(filePath)) {
        throw new Error(`${label} package.json does not exist: ${filePath}`)
    }

    try {
        return JSON.parse(readFileSync(filePath, "utf-8")) as PackageManifest
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`Failed to parse ${label} package.json at ${filePath}: ${reason}`)
    }
}

function isPathWithin(parentPath: string, childPath: string): boolean {
    const relativePath = relative(parentPath, childPath)
    return relativePath === "" || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
}

function requireDirectory(path: string, label: string): string {
    if (!directoryExists(path)) {
        throw new Error(`${label} directory does not exist: ${path}`)
    }

    return realpathSync(path)
}

function containerPath(rootPath: string, hostPath: string, containerRoot: string): string {
    const relativePath = relative(rootPath, hostPath).split(sep).join(posix.sep)
    return relativePath ? posix.join(containerRoot, relativePath) : containerRoot
}

function workspacePatterns(manifest: PackageManifest): string[] {
    if (Array.isArray(manifest.workspaces)) return manifest.workspaces
    return manifest.workspaces?.packages ?? []
}

function discoverWorkspacePackages(workspaceRoot: string, rootManifest: PackageManifest): Map<string, WorkspacePackage> {
    const packages = new Map<string, WorkspacePackage>()

    for (const pattern of workspacePatterns(rootManifest)) {
        const packageJsonPattern = `${pattern.replace(/\/$/, "")}/package.json`
        const glob = new Bun.Glob(packageJsonPattern)

        for (const packageJsonPath of glob.scanSync({ cwd: workspaceRoot, dot: true, onlyFiles: true })) {
            const absolutePackageJsonPath = resolve(workspaceRoot, packageJsonPath)
            const directory = realpathSync(resolve(absolutePackageJsonPath, ".."))

            if (!isPathWithin(workspaceRoot, directory)) continue

            const manifest = readPackageManifest(absolutePackageJsonPath, "workspace")
            if (!manifest.name) continue

            const existing = packages.get(manifest.name)
            if (existing && existing.directory !== directory) {
                throw new Error(`Workspace package name ${manifest.name} is declared by both ${existing.directory} and ${directory}`)
            }

            packages.set(manifest.name, { directory, manifest })
        }
    }

    return packages
}

function packageDependencyNames(manifest: PackageManifest): string[] {
    const sections = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies]
    return sections.flatMap((section) => Object.keys(section ?? {}))
}

function resolveWorkspacePackageClosure(packageName: string, packages: Map<string, WorkspacePackage>): WorkspacePackage[] {
    const resolved: WorkspacePackage[] = []
    const visited = new Set<string>()
    const pending = [packageName]

    while (pending.length > 0) {
        const currentName = pending.shift()!
        if (visited.has(currentName)) continue
        visited.add(currentName)

        const currentPackage = packages.get(currentName)
        if (!currentPackage) {
            if (currentName === packageName) {
                throw new Error(`Frontend workspace package ${packageName} is not declared by the workspace root package.json`)
            }
            continue
        }

        resolved.push(currentPackage)

        for (const dependencyName of packageDependencyNames(currentPackage.manifest)) {
            if (packages.has(dependencyName)) pending.push(dependencyName)
        }
    }

    return resolved
}

function resolveStandaloneLayout(projectDirectory: string, frontendDirectory: string, outputDirectory: string): FrontendLayout {
    const config = Settings.main?.frontend
    const containerFrontendDirectory = containerPath(projectDirectory, frontendDirectory, CONTAINER_PROJECT_ROOT)

    return {
        projectDirectory,
        frontendDirectory,
        outputDirectory,
        installDirectory: frontendDirectory,
        workspaceRoot: null,
        workspacePackage: null,
        workspacePackageDirectories: [],
        buildScript: config?.scripts.build ?? "build",
        devScript: config?.scripts.dev ?? "dev",
        containerProjectDirectory: CONTAINER_PROJECT_ROOT,
        containerFrontendDirectory,
        containerOutputDirectory: containerPath(projectDirectory, outputDirectory, CONTAINER_PROJECT_ROOT),
        containerInstallDirectory: containerFrontendDirectory,
        containerNodeModulesDirectories: [posix.join(containerFrontendDirectory, "node_modules")],
        cacheFiles: [],
        cacheDirectories: [frontendDirectory],
    }
}

export function resolveFrontendLayout(): FrontendLayout {
    const config = Settings.main?.frontend
    const projectDirectory = requireDirectory(Settings.projectPath, "Strux project")
    const frontendDirectory = requireDirectory(resolve(projectDirectory, config?.directory ?? "./frontend"), "Frontend")
    const outputDirectory = resolve(frontendDirectory, config?.output ?? "./dist")

    if (!isPathWithin(projectDirectory, frontendDirectory)) {
        throw new Error(`Frontend directory must be inside the Strux project: ${frontendDirectory}`)
    }

    if (!isPathWithin(projectDirectory, outputDirectory)) {
        throw new Error(`Frontend output directory must be inside the Strux project: ${outputDirectory}`)
    }

    if (!config?.workspace) {
        return resolveStandaloneLayout(projectDirectory, frontendDirectory, outputDirectory)
    }

    const workspaceRoot = requireDirectory(resolve(projectDirectory, config.workspace.root), "Frontend workspace root")
    if (!isPathWithin(workspaceRoot, projectDirectory)) {
        throw new Error(`Frontend workspace root must contain the Strux project: ${workspaceRoot}`)
    }

    const rootPackageJson = join(workspaceRoot, "package.json")
    const rootManifest = readPackageManifest(rootPackageJson, "workspace root")
    const packages = discoverWorkspacePackages(workspaceRoot, rootManifest)
    const packageClosure = resolveWorkspacePackageClosure(config.workspace.package, packages)
    const frontendPackage = packageClosure[0]!

    if (frontendPackage.directory !== frontendDirectory) {
        throw new Error(`Frontend workspace package ${config.workspace.package} resolves to ${frontendPackage.directory}, not ${frontendDirectory}`)
    }

    const packageLockPath = join(workspaceRoot, "package-lock.json")

    const containerProjectDirectory = containerPath(workspaceRoot, projectDirectory, CONTAINER_WORKSPACE_ROOT)
    const containerFrontendDirectory = containerPath(workspaceRoot, frontendDirectory, CONTAINER_WORKSPACE_ROOT)
    const workspacePackageDirectories = packageClosure.map((workspacePackage) => workspacePackage.directory)
    // Shadow existing package node_modules paths so the container install cannot alter
    // host dependencies. Do not add a volume for absent paths: Docker cannot create
    // those mountpoints beneath the workspace bind.
    const workspaceDirectoriesWithNodeModules = [...packages.values()]
        .map((workspacePackage) => workspacePackage.directory)
        .filter((directory) => directoryExists(join(directory, "node_modules")))
    const containerNodeModulesDirectories = [
        posix.join(CONTAINER_WORKSPACE_ROOT, "node_modules"),
        ...workspaceDirectoriesWithNodeModules.map((directory) => posix.join(containerPath(workspaceRoot, directory, CONTAINER_WORKSPACE_ROOT), "node_modules")),
    ]

    return {
        projectDirectory,
        frontendDirectory,
        outputDirectory,
        installDirectory: workspaceRoot,
        workspaceRoot,
        workspacePackage: config.workspace.package,
        workspacePackageDirectories,
        buildScript: config.scripts.build,
        devScript: config.scripts.dev,
        containerProjectDirectory,
        containerFrontendDirectory,
        containerOutputDirectory: containerPath(workspaceRoot, outputDirectory, CONTAINER_WORKSPACE_ROOT),
        containerInstallDirectory: CONTAINER_WORKSPACE_ROOT,
        containerNodeModulesDirectories: [...new Set(containerNodeModulesDirectories)],
        cacheFiles: [rootPackageJson, packageLockPath, join(workspaceRoot, ".npmrc")],
        cacheDirectories: workspacePackageDirectories,
    }
}

export function frontendEnvironment(layout: FrontendLayout, inContainer = false): Record<string, string> {
    return {
        FRONTEND_DIR: inContainer ? layout.frontendDirectory : layout.containerFrontendDirectory,
        FRONTEND_OUTPUT_DIR: inContainer ? layout.outputDirectory : layout.containerOutputDirectory,
        FRONTEND_INSTALL_DIR: inContainer ? layout.installDirectory : layout.containerInstallDirectory,
        FRONTEND_WORKSPACE_PACKAGE: layout.workspacePackage ?? "",
        FRONTEND_BUILD_SCRIPT: layout.buildScript,
        FRONTEND_DEV_SCRIPT: layout.devScript,
    }
}

export function frontendDockerMounts(layout: FrontendLayout): DockerMount[] {
    const mounts: DockerMount[] = []

    if (layout.workspaceRoot && layout.workspaceRoot !== layout.projectDirectory) {
        // npm and Vite operate from the workspace root. Keep it as one bind
        // mount rather than nesting a writable project mount beneath a
        // workspace mount: that mixed mount tree can deadlock the interactive
        // dev process on macOS Docker Desktop. Host node_modules remain
        // isolated by the volume mounts added below.
        mounts.push({ type: "bind", source: layout.workspaceRoot, target: CONTAINER_WORKSPACE_ROOT })
    } else {
        mounts.push({ type: "bind", source: layout.projectDirectory, target: layout.containerProjectDirectory })
    }

    for (const target of layout.containerNodeModulesDirectories) {
        mounts.push({ type: "volume", target })
    }

    // npm's content cache is safe to share and avoids downloading every package on each isolated build.
    mounts.push({ type: "volume", source: "strux-npm-cache", target: "/root/.npm" })

    return mounts
}
