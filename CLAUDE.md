# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Is This

Strux OS is a CLI framework for building kiosk-style Linux operating systems. The CLI (`strux`) is written in TypeScript, compiled to a single binary via Bun. It orchestrates Docker-based builds to produce bootable OS images with a Go backend + web frontend running in a Cage Wayland compositor via WPE WebKit.

## Development Commands

```bash
bun install              # Install dependencies
bun run build            # Compile to single binary: bun build src/index.ts --compile --outfile strux
bun run build:go         # Build Go introspection binary: go build -o strux-introspect ./cmd/strux/main.go
bun run generate:types   # Generate runtime TS types from Go: go run ./cmd/gen-runtime-types
bun run lint             # ESLint (eslint src/)
bun run typecheck        # TypeScript check (tsc --noEmit)
bun test                 # Run tests
```

## Bun-First Rules

- Use `bun` instead of `node`, `npm`, `pnpm`, `yarn` for all operations
- Use `Bun.file` over `node:fs` readFile/writeFile
- Use `Bun.$` instead of `execa` for shell commands
- Bun automatically loads `.env` — don't use `dotenv`

## Architecture

### CLI Entry Point and Commands

Entry: `src/index.ts` — uses `commander` to register commands. Each command sets fields on the `Settings` singleton (`src/settings.ts`) then calls its implementation function.

Commands in `src/commands/`:
- **build/** — Full build pipeline orchestrator (the largest and most complex command)
- **dev/** — Dev mode: builds, starts QEMU, Vite dev server (Docker), WebSocket dev server (`Bun.serve`), file watcher (chokidar), and React TUI (Ink)
- **init/** — Scaffolds a new project from template assets
- **run/** — Launches built image in QEMU
- **types/** — Go AST introspection → TypeScript `.d.ts` generation
- **usb/** — USB passthrough management for QEMU
- **kernel/** — Kernel menuconfig/clean

### Build System (`src/commands/build/`)

Key files:
- `index.ts` — Pipeline orchestrator. Steps run in order: frontend → application → cage → wpe → client → kernel → bootloader → rootfs-base → rootfs-post → bundle → make_image
- `cache.ts` + `cache-deps.ts` — Smart caching via SHA256 hashes. Each step declares file/directory/YAML key dependencies. Cache manifest stored at `dist/cache/{bsp}/.build-cache.json`
- `bsp-scripts.ts` — Runs BSP lifecycle scripts (before_*/after_* hooks) inside Docker
- `artifacts.ts` — Copies embedded assets to `dist/artifacts/` (write-once, then user-editable)
- `internal-hashes.ts` — Hashes all bundled assets so CLI upgrades auto-invalidate affected build steps

Build steps run inside the `strux-builder` Docker container via `Runner.runScriptInDocker()`.

### Asset Embedding

All shell scripts, Dockerfiles, Go source, C source, and template files are **embedded at compile time** using Bun's import attributes:
```typescript
import script from "../../assets/scripts-base/strux-build-frontend.sh" with { type: "text" }
import logo from "../../assets/template-base/logo.png" with { type: "file" }
```

Asset directories in `src/assets/`:
- `scripts-base/` — Dockerfile, build shell scripts, systemd services, init scripts
- `template-base/` — Project scaffold (strux.yaml, bsp.yaml, main.go, make-image.sh)
- `client-base/` — Go source for on-device strux client binary
- `cage-base/` — Cage Wayland compositor C source
- `wpe-extension-base/` — WPE WebKit extension C source

### Key Utilities

- `src/utils/run.ts` — `Runner` class: shell command execution via `Bun.spawn`, Docker image management, `runScriptInDocker()` for build steps. Supports progress markers (`STRUX_PROGRESS:`) and verbose mode.
- `src/utils/log.ts` — `Logger` (with sink pattern for TUI routing) + `Spinner` (wraps `ora`)
- `src/settings.ts` — Global singleton storing CLI options, loaded YAML configs, and build state

### Type System

- `src/types/bsp-yaml.ts` — Zod schema for `bsp.yaml`
- `src/types/main-yaml.ts` — Zod schema for `strux.yaml`
- `src/types/introspection.ts` — Schema for Go AST introspection output
- YAML is validated with Zod v4 (`z.object(...)`) and parsed with `Bun.YAML.parse()` or `yaml` package

### Go Components (`cmd/`, `pkg/`)

- `cmd/strux/main.go` — `strux-introspect`: Go AST analyzer that extracts struct fields/methods from user's `main.go`
- `cmd/gen-runtime-types/` — Generates `src/types/strux-runtime.ts` from Go runtime package
- `pkg/runtime/` — Go runtime library used by end-user projects

### Dev Mode (`src/commands/dev/`)

Uses Ink (React TUI) with tabbed interface. Starts:
1. WebSocket dev server on port 8000 (`Bun.serve`)
2. Vite dev server inside Docker
3. QEMU instance (unless `--remote`)
4. chokidar file watcher for Go/YAML changes → recompile + binary push
5. mDNS discovery via `bonjour-service`

### BSP Script Environment

BSP scripts run in Docker with standardized env vars: `BSP_NAME`, `PROJECT_FOLDER=/project`, `PROJECT_DIST_CACHE_FOLDER=/project/dist/cache/{bsp}`, `PROJECT_DIST_OUTPUT_FOLDER=/project/dist/output/{bsp}`, `TARGET_ARCH`, `HOST_ARCH`, `STEP`, etc.

Path resolution in `cached_generated_artifacts`/`depends_on`: `cache/` → `dist/cache/{bsp}/`, `output/` → `dist/output/{bsp}/`, `./` → relative to BSP dir.
