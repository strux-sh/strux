# Repository Guidelines

## Project Context
- Strux OS builds kiosk-style Linux images with a Go backend and TypeScript CLI; targets ARM64/x86_64 and supports BSPs, QEMU testing, and frontend bundles (React/Vue/vanilla).
- Dockerized build pipeline coordinates frontend bundling, Go compilation, compositor/WebKit pieces, and disk image assembly; alpha-stage APIs may shift.

## Project Structure & Module Organization
- `src/` TypeScript CLI implementation (`index.ts` entrypoint), runtime helpers in `utils/`, tooling in `tools/`, and generated runtime types under `types/`.
- `cmd/` Go commands (`cmd/strux/main.go` builds `strux-introspect`; `cmd/gen-runtime-types` emits TS runtime types).
- `pkg/` Go libraries shared across commands.
- `samples/` example artifacts; `test/` contains the sample Strux project used for end-to-end flow checks (bsp, frontend, overlay, etc.).
- Top-level binaries produced in the repo root (`strux`, `strux-introspect`); config at `tsconfig.json`, lint rules in `eslint.config.mjs`.

## Build, Test, and Development Commands
- `bun run dev` – run the TypeScript CLI directly for rapid iteration.
- `bun run build` – bundle and compile the CLI to a native binary `strux`.
- `bun run build:go` – build the Go helper binary `strux-introspect`.
- `bun run generate:types` – regenerate TypeScript runtime types from Go structs into `src/types/strux-runtime.ts`.
- `bun run lint` / `bun run typecheck` – lint and TS type-check the CLI code.
- `bun test` – execute the Bun test suite; uses fixtures under `test/`.

## Coding Style & Naming Conventions
- TypeScript: 4-space indentation, double quotes, no semicolons, Unix line endings, spaced braces (`{ foo: bar }`), avoid trailing spaces and multiple blank lines.
- Prefer explicit, descriptive names; CLI commands and options should stay lower-kebab-case; exported helpers in TS use `camelCase`; Go packages stick to lower_snake for files and lowerCamel for identifiers.
- Follow existing ESLint configuration (`eslint.config.mjs`) and keep new code type-safe; allow `_`-prefixed unused params only where intentional.

## Testing Guidelines
- Default test runner is Bun (`bun test`); place new tests alongside subject files in `src/**` or under `test/` when using fixtures.
- Name tests after behavior (`parses-config-from-file`, `builds-qemu-image`) and assert both happy-path and failure modes.
- When touching Go helpers, add unit tests with Go’s standard library (`go test ./...`) where practical before invoking from TS; ensure TS and Go expectations stay aligned.

## Commit & Pull Request Guidelines
- Commit messages: short imperative summary (e.g., `fix windows installer path`, `add qemu bsp fixtures`); keep body lines wrapped and include rationale when non-obvious.
- PRs: describe scope, link related issues, call out breaking changes or platform impacts (ARM64 vs x86_64), and include before/after behavior or screenshots/log snippets when relevant.
- Add reproduction or verification steps for CLI changes (`bun run dev ...`) and note whether docs/examples (`samples/`, `README.md`) were updated.

# Rules
- Always ask questions for certain developer decisions and the shape of things. Confirm what changes you are going to make before changing them.
- For changes to `kernel-source` or `bootloader-source`, never hand-edit the `.diff` patch file directly. Make the change in the actual checked-out source tree first, generate the patch from that source tree with `git diff`, write that output to the BSP patch file, then run `git reset --hard HEAD` inside the source tree afterward. Leave unrelated untracked files alone unless explicitly told otherwise.
