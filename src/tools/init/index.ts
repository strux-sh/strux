/***
 *
 *  Init Command - Initialize a new Strux project
 *
 */

import { join, resolve } from "path"
import { mkdir } from "fs/promises"
import { success, info, warning, newSpinner } from "../../utils/colors"
import { generateTypes } from "../types"

export type TemplateType = "vanilla" | "react" | "vue"
export type ArchType = "arm64" | "x86_64"

export interface InitOptions {
    template: TemplateType
    arch: ArchType
}

/**
 * Detect the host architecture
 */
function detectArch(): ArchType {
    const arch = process.arch
    if (arch === "arm64") {
        return "arm64"
    }
    return "x86_64"
}

/**
 * Initialize a new Strux project
 */
export async function init(projectName: string, options: InitOptions): Promise<void> {
    const projectDir = resolve(process.cwd(), projectName)

    // Check if directory already exists
    const dirExists = await Bun.file(projectDir).exists().catch(() => false)
    if (dirExists) {
        throw new Error(`Directory "${projectName}" already exists`)
    }

    // Check if it's a directory that exists
    try {
        const stat = await Bun.file(projectDir).stat?.()
        if (stat) {
            throw new Error(`"${projectName}" already exists`)
        }
    } catch {
        // Directory doesn't exist, which is what we want
    }

    info(`Creating new Strux project: ${projectName}`)
    info(`Template: ${options.template}`)
    info(`Architecture: ${options.arch}`)

    // Create project directory structure
    await mkdir(projectDir, { recursive: true })
    await mkdir(join(projectDir, "bsp", "qemu"), { recursive: true })
    await mkdir(join(projectDir, "assets"), { recursive: true })
    await mkdir(join(projectDir, "overlay"), { recursive: true })

    // Generate frontend based on template
    await generateFrontend(projectDir, options.template)

    // Generate main.go
    await generateMainGo(projectDir, projectName)

    // Generate go.mod
    await generateGoMod(projectDir, projectName)

    // Generate strux.d.ts by introspecting main.go
    await generateStruxTypes(projectDir)

    // Update TypeScript config to include strux.d.ts
    // Must be done AFTER strux.d.ts is created
    if (options.template !== "vanilla") {
        const frontendDir = join(projectDir, "frontend")
        const struxDtsPath = join(frontendDir, "strux.d.ts")
        // Verify strux.d.ts exists before updating tsconfig
        const struxDtsExists = await Bun.file(struxDtsPath).exists()
        if (!struxDtsExists) {
            throw new Error(`strux.d.ts was not created at ${struxDtsPath}`)
        }
        await updateTypeScriptConfig(frontendDir)
    }

    // Generate strux.json config
    await generateStruxConfig(projectDir, projectName, options)

    // Generate default QEMU BSP
    await generateQemuBSP(projectDir, options.arch)

    // Generate .gitignore
    await generateGitignore(projectDir)

    // Generate placeholder logo
    await generatePlaceholderLogo(projectDir)

    success(`Project "${projectName}" created successfully!`)
    info("")
    info("Next steps:")
    info(`  cd ${projectName}`)
    if (options.template !== "vanilla") {
        info("  cd frontend && npm install")
    }
    info("  strux build qemu")
    info("  strux run")
}

/**
 * Generate frontend based on template type
 */
async function generateFrontend(projectDir: string, template: TemplateType): Promise<void> {
    const frontendDir = join(projectDir, "frontend")

    switch (template) {
        case "vanilla":
            await generateVanillaFrontend(frontendDir)
            break
        case "react":
            await bootstrapReactProject(projectDir)
            break
        case "vue":
            await bootstrapVueProject(projectDir)
            break
    }
}

/**
 * Generate a vanilla HTML/JS frontend
 */
async function generateVanillaFrontend(frontendDir: string): Promise<void> {
    await mkdir(frontendDir, { recursive: true })

    const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Strux App</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            color: #fff;
        }

        .container {
            text-align: center;
            padding: 2rem;
        }

        h1 {
            font-size: 3rem;
            margin-bottom: 1rem;
            background: linear-gradient(90deg, #00d4ff, #7b2ff7);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .demo-section {
            margin-top: 2rem;
            padding: 1.5rem;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            backdrop-filter: blur(10px);
        }

        .demo-section h2 {
            margin-bottom: 1rem;
            font-size: 1.2rem;
            color: #00d4ff;
        }

        button {
            background: linear-gradient(90deg, #00d4ff, #7b2ff7);
            border: none;
            padding: 0.75rem 1.5rem;
            border-radius: 8px;
            color: white;
            font-size: 1rem;
            cursor: pointer;
            margin: 0.5rem;
            transition: transform 0.2s, box-shadow 0.2s;
        }

        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 20px rgba(0, 212, 255, 0.3);
        }

        #output {
            margin-top: 1rem;
            padding: 1rem;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 8px;
            font-family: monospace;
            min-height: 50px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Strux App</h1>
        <p>Your embedded application is ready!</p>

        <div class="demo-section">
            <h2>Go Backend Demo</h2>
            <button onclick="testGreet()">Test Greet</button>
            <button onclick="testAdd()">Test Add</button>
            <div id="output">Click a button to test the Go backend</div>
        </div>
    </div>

        <script type="module">
        window.testGreet = async () => {
            try {
                const result = await window.go.main.App.Greet("World");
                document.getElementById('output').textContent = result;
            } catch (err) {
                document.getElementById('output').textContent = 'Error: ' + err.message;
            }
        };

        window.testAdd = async () => {
            try {
                const result = await window.go.main.App.Add(10, 5);
                document.getElementById('output').textContent = '10 + 5 = ' + result;
            } catch (err) {
                document.getElementById('output').textContent = 'Error: ' + err.message;
            }
        };
    </script>
</body>
</html>
`

    await Bun.write(join(frontendDir, "index.html"), indexHtml)
    success("Created vanilla frontend")
}

/**
 * Bootstrap a React project using npm create vite (non-interactive)
 */
async function bootstrapReactProject(projectDir: string): Promise<void> {
    const spinner = newSpinner("Creating React project...")
    spinner.start()

    try {
        // Use npm create vite with react-ts template
        // The -- separates npm args from create-vite args
        // stdin: "ignore" prevents any interactive prompts from blocking
        // CI=true tells tools to run non-interactively
        const proc = Bun.spawn(
            ["npm", "create", "vite@latest", "frontend", "--", "--template", "react-ts"],
            {
                stdout: "pipe",
                stderr: "pipe",
                stdin: "ignore",
                cwd: projectDir,
                env: {
                    ...process.env,
                    CI: "true",
                    npm_config_yes: "true",
                },
            }
        )

        const exitCode = await proc.exited

        if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text()
            throw new Error(`Failed to create React project: ${stderr}`)
        }

        // Create a vite.config.ts for the project
        const viteConfig = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
    plugins: [react()],
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
    resolve: {
        alias: {
            '@': '/src',
        },
    },
})
`
        const frontendDir = join(projectDir, "frontend")
        await Bun.write(join(frontendDir, "vite.config.ts"), viteConfig)

        // Update package.json to add vite and react plugin
        const packageJsonPath = join(frontendDir, "package.json")
        const packageJson = await Bun.file(packageJsonPath).json()

        packageJson.scripts = {
            ...packageJson.scripts,
            dev: "vite",
            build: "vite build",
            preview: "vite preview",
        }

        packageJson.devDependencies = {
            ...packageJson.devDependencies,
            vite: "^6.0.0",
            "@vitejs/plugin-react": "^4.3.0",
            "@types/react": "^19.0.0",
            "@types/react-dom": "^19.0.0",
        }

        await Bun.write(packageJsonPath, JSON.stringify(packageJson, null, 2))

        spinner.stopWithSuccess("Created React project")
    } catch (err) {
        spinner.stopWithError("Failed to create React project")
        throw err
    }
}

/**
 * Bootstrap a Vue project using npm create vue (non-interactive)
 */
async function bootstrapVueProject(projectDir: string): Promise<void> {
    const spinner = newSpinner("Creating Vue project...")
    spinner.start()

    try {
        // Use npm create vue@latest with TypeScript support
        // The -- separates npm args from create-vue args
        // --ts enables TypeScript support (creates tsconfig.app.json)
        // stdin: "ignore" prevents any interactive prompts from blocking
        // CI=true tells tools to run non-interactively
        const proc = Bun.spawn(
            ["npm", "create", "vue@latest", "frontend", "--", "--ts"],
            {
                stdout: "pipe",
                stderr: "pipe",
                stdin: "ignore",
                cwd: projectDir,
                env: {
                    ...process.env,
                    CI: "true",
                    npm_config_yes: "true",
                },
            }
        )

        const exitCode = await proc.exited

        if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text()
            const stdout = await new Response(proc.stdout).text()
            throw new Error(`Failed to create Vue project: ${stderr}\n${stdout}`)
        }

        // Wait a bit for file system operations to complete
        await new Promise(resolve => setTimeout(resolve, 1000))

        spinner.stopWithSuccess("Created Vue project")
    } catch (err) {
        spinner.stopWithError("Failed to create Vue project")
        throw err
    }
}

/**
 * Generate strux.d.ts type definitions file by introspecting main.go
 */
async function generateStruxTypes(projectDir: string): Promise<void> {
    const mainGoPath = join(projectDir, "main.go")
    const frontendDir = join(projectDir, "frontend")

    // Use the actual type generation function to introspect main.go
    const result = await generateTypes({
        mainGoPath,
        outputDir: frontendDir,
    })

    if (!result.success) {
        throw new Error(`Failed to generate types: ${result.error}`)
    }

    success("Created strux.d.ts type definitions")
}

/**
 * Update TypeScript configuration to include strux.d.ts
 * Works for both Vue and React projects created with Vite
 */
async function updateTypeScriptConfig(frontendDir: string): Promise<void> {
    const tsconfigAppPath = join(frontendDir, "tsconfig.app.json")

    // Wait for tsconfig.app.json to exist (Vite creates it)
    let exists = false
    for (let i = 0; i < 10; i++) {
        exists = await Bun.file(tsconfigAppPath).exists().catch(() => false)
        if (exists) break
        await new Promise(resolve => setTimeout(resolve, 500))
    }

    if (!exists) {
        throw new Error(`tsconfig.app.json not found at ${tsconfigAppPath}`)
    }

    // Read JSON (TypeScript config files support comments, so we need to handle JSONC)
    const fileText = await Bun.file(tsconfigAppPath).text()
    const stripJsonComments = await import("strip-json-comments")
    const cleaned = stripJsonComments.default(fileText)
    const tsconfigApp = JSON.parse(cleaned)

    // Push to include array
    tsconfigApp.include ??= []
    if (!tsconfigApp.include.includes("strux.d.ts")) {
        tsconfigApp.include.push("strux.d.ts")
    }

    // Write JSON
    await Bun.write(tsconfigAppPath, JSON.stringify(tsconfigApp, null, 2) + "\n")
}

/**
 * Generate main.go file
 */
async function generateMainGo(projectDir: string, projectName: string): Promise<void> {
    const mainGo = `package main

import (
	"log"

	"github.com/strux-dev/strux/pkg/runtime"
)

// App is the main application struct
// All public fields and methods are exposed to the frontend
type App struct {
	// Title is displayed in the window
	Title string

	// Counter is a simple state example
	Counter int
}

// Greet returns a greeting message
func (a *App) Greet(name string) string {
	return "Hello, " + name + "!"
}

// Add adds two numbers together
func (a *App) Add(x, y float64) float64 {
	return x + y
}

func main() {
	app := &App{
		Title:   "${projectName}",
		Counter: 0,
	}
	if err := runtime.Start(app); err != nil {
		log.Fatal(err)
	}
}
`

    await Bun.write(join(projectDir, "main.go"), mainGo)
    success("Created main.go")
}

/**
 * Generate go.mod file and fetch runtime dependency
 */
async function generateGoMod(projectDir: string, projectName: string): Promise<void> {
    const goMod = `module ${projectName}

go 1.21
`

    await Bun.write(join(projectDir, "go.mod"), goMod)
    success("Created go.mod")

    // Fetch the Strux runtime dependency
    info("Fetching Strux runtime dependency...")
    const proc = Bun.spawn(["go", "get", "github.com/strux-dev/strux/pkg/runtime"], {
        cwd: projectDir,
        stdout: "pipe",
        stderr: "pipe",
    })

    const exitCode = await proc.exited
    if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text()
        warning(`Failed to fetch runtime dependency: ${stderr}`)
        info("Run 'go get github.com/strux-dev/strux/pkg/runtime' manually")
    } else {
        success("Strux runtime dependency installed")
    }
}

/**
 * Generate strux.json configuration
 */
async function generateStruxConfig(projectDir: string, projectName: string, options: InitOptions): Promise<void> {
    const frontendCmd = options.template !== "vanilla" ? "npm run build --prefix ./frontend" : ""

    const config = {
        v: "0.0.1",
        name: projectName,
        output: "./dist",
        display: {
            resolution: "1920x1080",
            initial_load_color: "000000",
        },
        arch: options.arch,
        bsp: "./bsp/qemu",
        hostname: "strux",
        boot: {
            splash: {
                enabled: true,
                logo: "./assets/logo.png",
            },
            service_files: [],
        },
        rootfs: {
            overlay: "./overlay",
            packages: [],
            deb_packages: [],
        },
        qemu: {
            network: true,
            usb: [],
            flags: [],
        },
        build: {
            host_packages: [],
            frontend_cmd: frontendCmd,
        },
    }

    await Bun.write(join(projectDir, "strux.json"), JSON.stringify(config, null, 2))
    success("Created strux.json")
}

/**
 * Generate default QEMU BSP
 */
async function generateQemuBSP(projectDir: string, arch: ArchType): Promise<void> {
    const bsp = {
        name: "qemu",
        description: "QEMU virtual machine for development and testing",
        arch: arch === "x86_64" ? "amd64" : "arm64",
        artifacts: {
            source: "prebuilt",
        },
        packages: [],
    }

    await Bun.write(join(projectDir, "bsp", "qemu", "bsp.json"), JSON.stringify(bsp, null, 2))
    success("Created QEMU BSP")
}

/**
 * Generate .gitignore
 */
async function generateGitignore(projectDir: string): Promise<void> {
    const gitignore = `# Build output
dist/
*.img

# Dependencies
node_modules/

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS files
.DS_Store
Thumbs.db

# Go
go.sum

# Logs
*.log
`

    await Bun.write(join(projectDir, ".gitignore"), gitignore)
    success("Created .gitignore")
}

/**
 * Generate a placeholder logo
 */
async function generatePlaceholderLogo(projectDir: string): Promise<void> {
    // Create a minimal 1x1 transparent PNG as placeholder
    // This is a valid PNG file
    const transparentPng = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ])

    await Bun.write(join(projectDir, "assets", "logo.png"), transparentPng)
    info("Created placeholder logo (replace with your own)")
}

export { detectArch }
