# Strux OS Documentation — TODO

Working plan for the documentation site (VuePress 2, `docs/`). Check items off as pages land.

## 0. Infrastructure (blocking)

- [ ] **Fix GitHub CI** — `docs.yml` fails with `Error: No pnpm version is specified.`
  - Workflow was copied from a VuePress template that assumes pnpm at the repo root.
  - Problems: no `packageManager` field / pnpm lockfile anywhere, docs uses npm (`package-lock.json`), and the workflow never sets `working-directory: docs`.
  - Proposal: switch docs to **Bun** (project is Bun-first), use `oven-sh/setup-bun` in CI, `working-directory: docs`, build with `bun run docs:build`.
- [ ] Remove leftover `docs/.github/workflows/deploy-docs.yml` (relic from standalone-repo days; the real workflow is `.github/workflows/docs.yml`)
- [ ] Stop tracking `docs/docs/.vuepress/.temp/` build artifacts; add `.temp/` and `.cache/` to `.gitignore`
- [ ] Build docs on PRs too (build-only check, deploy only on `main`) so broken docs can't merge
- [ ] Decide canonical URL / GitHub Pages setup (custom domain? `docs.strux.sh`?)
- [ ] All sidebar entries in `config.js` currently point to pages that don't exist — create stubs first so the site builds clean, then fill in

## 1. Guide (the user journey, in order)

- [ ] `/guide/introduction` — What is Strux? Who is it for (kiosks, embedded, signage, appliances)? The stack in one diagram: Go backend + web frontend → Cage/WPE WebKit → custom Debian-based image
- [ ] `/guide/installation` — Install the `strux` binary; prerequisites (Docker, QEMU for local testing); supported host platforms (macOS/Linux, arm64/x86_64); builder image (GHCR pull vs `--local-builder`)
- [ ] `/guide/getting-started` — Quick start: `strux init` → `strux build` → `strux run`. 10 minutes to a booting kiosk in QEMU
- [ ] `/guide/project-structure` — Anatomy of a Strux project: `strux.yaml`, `main.go`, `frontend/`, `bsp/`, `overlay/`, `assets/`, `settings/`, `dist/` (artifacts vs cache vs output)
- [ ] `/guide/frontend` — Frontend development: templates (vanilla/react/vue), Vite, talking to the Go backend, generated TypeScript types (`strux types`)
- [ ] `/guide/backend` — Backend development: `main.go`, the Strux runtime, exposing methods/state to the frontend, Go ↔ frontend bridge
- [ ] `/guide/dev-mode` — `strux dev`: the TUI, hot reload (Go recompile + push, Vite HMR), `--remote` for real hardware, mDNS discovery, WebKit inspector, USB networking
- [ ] `/guide/building` — `strux build`: what happens, `--clean`, `--dev` images, reading build output, cache behavior day-to-day
- [ ] `/guide/running-qemu` — `strux run`: QEMU config in strux.yaml (memory/flags/network), `--debug`, `--headless`, USB passthrough (`strux usb add|list`)
- [ ] `/guide/flashing` — `strux flash`: getting an image onto real hardware, per-BSP flash scripts
- [ ] `/guide/updates` — OTA updates: `strux update gen-keypair` → `bundle` → `send`; signing model (RSA-PSS/SHA-512), `update.enabled`/`auto_bundle`, what happens on-device
- [ ] `/guide/customizing-the-os` — rootfs overlay, extra packages (apt + local .deb), hostname, boot splash (logo, background color)

## 2. Concepts (how it works)

- [ ] `/concepts/overview` — High-level architecture: CLI → Docker builder → bootable image; on-device stack (systemd → strux client → Cage → WPE WebKit → your app)
- [ ] `/concepts/build-pipeline` — The step graph: frontend → application → cage → wpe → client → kernel → bootloader → rootfs-base → rootfs-post → bundle → make_image; what each step produces
- [ ] `/concepts/caching` — SHA256 dependency tracking, cache manifest, internal-hash invalidation on CLI upgrades, `force_rebuild` / `ignore_patterns`, when to use `--clean`
- [ ] `/concepts/bsp` — What a Board Support Package is, how a project selects one, what it owns (arch, kernel, bootloader, scripts, packages, runtime extensions)
- [ ] `/concepts/lifecycle-scripts` — before_*/after_* hooks for every step, Docker execution environment, script caching (`cached_generated_artifacts`, `depends_on`)
- [ ] `/concepts/runtime-extensions` — The new extension system: BSP-provided Go providers (display/network/wifi), `strux_bsp_runtime_extensions.go`, `compatible_strux_api`
- [ ] `/concepts/display-stack` — Cage compositor, WPE WebKit, multi-monitor config (`display.monitors`: paths, output names, input device mapping, transforms)
- [ ] `/concepts/artifacts` — `dist/artifacts/` write-once model: embedded assets copied out, then user-editable; how CLI upgrades interact with edited artifacts
- [ ] `/concepts/update-system` — Update bundles (`.struxb`), signature verification, rootfs replacement; (future: A/B dual rootfs — note as roadmap, don't document as shipped)

## 3. Reference (exhaustive, generated-where-possible)

- [ ] `/reference/cli` — Every command + option: global flags (`--verbose`, `--local-builder`, `--remote-builder`), `init`, `build`, `dev`, `run`, `flash`, `update` (gen-keypair/bundle/send), `usb` (add/list), `kernel` (menuconfig/clean), `types`
- [ ] `/reference/strux-yaml` — Full schema from `src/types/main-yaml.ts`: project_version, name, bsp, hostname, boot.splash, update, display.monitors, rootfs, qemu, build (host_packages, cache), dev (server, inspector, usb)
- [ ] `/reference/bsp-yaml` — Full schema from `src/types/bsp-yaml.ts`: bsp metadata, display, cage, scripts, boot.kernel (defconfig/fragments/patches/device_tree), boot.bootloader (types, boot_method, blobs), rootfs, runtime.extensions
- [ ] `/reference/go-runtime` — `pkg/runtime` API: Runtime services (Boot, Display, Dev, Network, Project, Update, WiFi, Capabilities), events, provider registration
- [ ] `/reference/frontend-api` — Generated TS types (`strux-runtime.ts`), how introspection maps Go structs/methods to the frontend
- [ ] `/reference/build-steps` — Step names + lifecycle hook table (the list currently living as comments in bsp.yaml)
- [ ] `/reference/environment-variables` — BSP script env: `BSP_NAME`, `PROJECT_FOLDER`, `PROJECT_DIST_*`, `TARGET_ARCH`, `HOST_ARCH`, `STEP`, …; plus host-side env (`STRUX_DEV_SERVER_URL`, …)
- [ ] `/reference/path-resolution` — `cache/` → `dist/cache/{bsp}/`, `output/` → `dist/output/{bsp}/`, `./` → BSP dir (for `depends_on` / `cached_generated_artifacts`)

## 4. BSP Development (advanced track)

- [ ] `/bsp-dev/writing-a-bsp` — From-scratch walkthrough: minimal bsp.yaml → boot in QEMU → real board
- [ ] `/bsp-dev/kernel` — Custom kernels: source/version, defconfig + fragments, patches, device trees & overlays, `strux kernel menuconfig --save`, `strux kernel clean`
- [ ] `/bsp-dev/bootloader` — U-Boot/GRUB/systemd-boot/custom, boot methods (extlinux/script/direct), vendor blobs, device trees
- [ ] `/bsp-dev/scripts` — Real-world lifecycle script patterns, caching strategy, debugging scripts in the builder container
- [ ] `/bsp-dev/runtime-extensions` — Writing Go providers for board-specific hardware (display/network/wifi)
- [ ] `/bsp-dev/flash-scripts` — Writing the host-side flash script
- [ ] `/bsp-dev/examples` — Annotated tour of real BSPs: `qemu` (reference), `hd215-rk3576` / `ht109-rk3576s` (Rockchip, custom kernel + U-Boot), `hd215-rk3288`

## 5. Extras / later

- [ ] Troubleshooting / FAQ (Docker issues, QEMU display problems, cache weirdness, arm64-on-x86 cross-build)
- [ ] Sidebar/navbar restructure in `config.js` to match final page list
- [ ] Versioned docs? (probably not until 1.0 — single version tracking `main` for now)
- [ ] Search (built-in `@vuepress/plugin-search` or DocSearch)
- [ ] Update README.md in repo root to link to the docs site

## Open questions

1. Bun vs npm/pnpm for the docs workspace (proposal: Bun, consistent with the repo)
2. Should reference pages (CLI, YAML schemas, runtime API) be **generated** from source (commander defs, Zod schemas, Go AST) instead of hand-written? Hand-written drifts; we already have introspection tooling
3. Does the BSP-dev track deserve its own top-level navbar entry, or live under Guide?
4. Audience assumption: doc for "web dev who's never built an embedded Linux image" or "embedded dev who wants a web UI"? (affects how much Linux/boot background we explain)
5. Is the extension system / dual rootfs stable enough to document now, or mark experimental?
