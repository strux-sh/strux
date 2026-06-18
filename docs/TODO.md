# Strux OS Documentation — TODO

Working plan for the documentation site (VuePress 2, `docs/`). Page tree mirrors the sidebar in `docs/docs/.vuepress/config.js`. Check items off as pages land.

**Decisions locked in:** docs stay **npm**-based; BSP Development is its own top-level track with its own Guide / Concepts / Reference; audience is dual (web dev new to embedded **and** embedded dev new to web) — teach concepts on first use (see `docs/STYLE.md`); runtime extension system documented as stable; dual rootfs documented as **experimental** but with the required v0.3.0 BSP conventions.

## 0. Infrastructure

- [x] **Fix GitHub CI** — `docs.yml` rewritten: npm + `cache-dependency-path`, builds on PRs (verify-only) and deploys on push; later extended with versioned/preview deploys + version switcher
- [x] Remove leftover `docs/.github/workflows/deploy-docs.yml`
- [x] Untrack `.vuepress/.temp/`; add `.temp/` `.cache/` `dist/` to `.gitignore`
- [x] Sidebar/navbar restructured in `config.js` (Guide / Concepts / BSP Development / Reference)
- [x] Site builds clean (`npm run docs:build` → 40 pages, no dead links)
- [ ] Decide canonical URL / Pages custom domain (CI currently publishes per-branch previews + versioned releases)
- [ ] Add search (`@vuepress/plugin-search` or DocSearch)

## 1. Guide  (`/guide/`)

- [x] `introduction` — what Strux is, the on-device stack, who it's for
- [x] `getting-started` — init → dev → build → run, ~10 min
- [x] `installation`
- [x] `project-structure`
- [x] `frontend`
- [x] `backend`
- [x] `dev-mode`
- [x] `building`
- [x] `running-qemu`
- [x] `flashing`
- [ ] `customizing-the-os` — rootfs overlay, extra packages (apt + local .deb), hostname, boot splash (logo + bg color)
- [ ] `updates` — `update gen-keypair` → `bundle` → `send`; signing model; `update.enabled`/`auto_bundle`; links to dual-rootfs concept

## 2. Concepts  (`/concepts/`)

- [ ] `overview` — high-level architecture (CLI → Docker builder → image; on-device boot chain)
- [ ] `build-pipeline` — the step graph and what each step produces
- [ ] `caching` — SHA256 dep tracking, manifest, internal-hash invalidation, `force_rebuild`/`ignore_patterns`, `--clean`
- [ ] `bsp` — what a BSP is and how a project selects one (gateway into the BSP track)
- [ ] `artifacts` — `dist/artifacts/` write-once model
- [ ] `display-stack` — Cage + WPE WebKit, multi-monitor config
- [ ] `update-system` — bundle format + on-device flow at a high level (links to BSP dual-rootfs for the contract)

## 3. BSP Development  (`/bsp/`)

### Guide  (`/bsp/guide/`)
- [ ] `introduction` — what board bring-up means, the BSP track overview
- [ ] `writing-a-bsp` — from-scratch: minimal bsp.yaml → boot in QEMU → real board
- [ ] `kernel` — custom kernels: source/version, defconfig+fragments, patches, device trees/overlays, `strux kernel menuconfig --save`/`clean`
- [ ] `bootloader` — U-Boot/GRUB/systemd-boot/custom, boot methods, vendor blobs, device trees
- [x] `scripts` — real-world lifecycle script patterns, caching, debugging in the builder container
- [x] `runtime-extensions` — writing Go providers/extensions for board hardware
- [x] `flash-scripts` — writing the host-side flash script
- [x] `examples` — annotated tour of real BSPs (qemu, hd215-rk3576, ht109-rk3576s, hd215-rk3288)

### Concepts  (`/bsp/concepts/`)  ← **section complete**
- [x] `lifecycle-scripts` — the before_*/after_* hook model, Docker exec env, script caching semantics
- [x] `extension-system` — runtime extension model (declaration → codegen → init/Register → IPC bridge), providers vs generic, `compatible_strux_api`
- [x] `dual-rootfs` — **experimental**; A/B slots, bundle format, on-device contract (partlabels, cmdline, BOOTENV.TXT, update.pub), what a BSP author must deliver

### Reference  (`/bsp/reference/`)
- [x] `bsp-yaml` — full schema from `src/types/bsp-yaml.ts`
- [x] `build-steps` — pipeline step + lifecycle hook table
- [x] `environment-variables` — BSP script env + host-side env
- [x] `path-resolution` — `cache/` `output/` `./` resolution for `depends_on`/`cached_generated_artifacts`

## 4. Reference  (`/reference/`)

- [x] `cli` — every command + option from `src/index.ts`
- [x] `strux-yaml` — full schema from `src/types/main-yaml.ts`
- [ ] `go-runtime` — `pkg/runtime` API: services (Boot, Display, Dev, Network, Project, Update, WiFi, Capabilities), events, provider registration
- [ ] `frontend-api` — generated TS types (`strux-runtime.ts`), how introspection maps Go → frontend

## 5. Extras / later

- [ ] Troubleshooting / FAQ (Docker, QEMU display, cache weirdness, arm64-on-x86 cross-build)
- [ ] Landing page (`README.md`) — review hero copy/feature list once pages exist
- [ ] Update repo-root `README.md` to link to the docs site

## Remaining open questions

1. Should the reference pages (CLI, YAML schemas, runtime API) eventually be **generated** from source (commander defs, Zod schemas, Go AST) instead of hand-written? Hand-written will drift; introspection tooling already exists. (Current call: hand-write v1, revisit generation later.)
2. How much overlap between `/concepts/update-system` (high-level) and `/bsp/concepts/dual-rootfs` (contract)? Keep the concept page short and link down, or fold together?
