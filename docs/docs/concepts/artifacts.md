# Artifacts

Strux embeds a lot of source inside the CLI binary itself: the on-device startup scripts, systemd services, the Cage compositor's C source, the Strux client's Go source, and more. On your first build, these are copied out into `dist/artifacts/` in your project — and from then on, **those copies are yours to edit**. This page explains the write-once model and how it interacts with CLI upgrades.

## The mental model

Most build tools hide their internals; Strux deliberately exposes them. Everything that ends up running on your device is materialized as readable, editable source in your project:

```txt
dist/artifacts/
├── scripts/
│   ├── init.sh               # initramfs init script
│   ├── strux.sh              # main startup script (starts backend, client, Cage)
│   ├── strux-network.sh      # network bring-up
│   └── strux-run-cog.sh      # per-display browser launcher (customize Cog flags here)
├── systemd/
│   ├── strux.service         # the unit that runs the whole UI stack
│   ├── strux-network.service
│   └── 20-ethernet.network
├── plymouth/                 # boot splash theme (theme, script, daemon config)
├── client/                   # Strux client Go source (main.go, cage.go, socket.go, ...)
├── cage/                     # Cage Wayland compositor C source (Strux fork)
├── wpe-extension/            # the window.strux browser bridge, C source
├── screen/                   # screen capture daemon C source
├── patches/                  # internal patches — always overwritten, don't edit
├── not-configured.html       # page shown on monitors with no configured route
└── logo.png                  # your boot splash logo, resolved from strux.yaml
```

The copy rule is simple: **if the file already exists, it is not overwritten.** The CLI ships the defaults; the copy in `dist/artifacts/` is the live version every build actually uses. Want a different `cog` flag per display? Edit `scripts/strux-run-cog.sh`. Need an extra systemd dependency? Edit `systemd/strux.service`. Curious how dev-mode discovery works? Read `client/hosts.go` — and change it.

::: tip Source vs. artifacts
If you're hacking on Strux itself, edit the sources in the CLI repository, not `dist/artifacts/` — artifacts are per-project copies. For your own project, `dist/artifacts/` is exactly the right place to customize.
:::

## When files get copied

Two moments:

1. **At the start of every build**, the CLI ensures the always-needed artifacts exist: the init/startup scripts, systemd units, Plymouth theme, `not-configured.html`, and `logo.png`. Each file is written only if missing.
2. **When a step first runs**, source-heavy directories are populated: the Cage sources before the cage step, the WPE extension before the wpe step, the client Go sources before the client step, the screen daemon sources before the screen step.

Two exceptions to pure write-once, both verifiable in `src/commands/build/artifacts.ts`:

- **`patches/` is always overwritten.** These are internal build patches (currently the Cog autoplay backport), not meant for customization.
- **`logo.png` is re-copied when your configured logo changes.** It mirrors the file referenced by `boot.splash.logo` in `strux.yaml`; if the source image's hash differs from the copy, it's refreshed. If the configured file is missing, a default logo is used with a warning.

Additionally, when the CLI adds a *new* file to a directory you already have (say, a new `.go` file in the client), it fills in just the missing file without touching your edited ones. In a couple of cases where an old client file would be incompatible with the current CLI, the file is refreshed if it lacks a known marker string — the log tells you when this happens (`Refreshing update.go in client base artifacts...`).

## Your edits are part of the build cache

The [cache](/concepts/caching.md) hashes the relevant `dist/artifacts/` directories as dependencies of their build steps. Edit `dist/artifacts/client/socket.go` and the client step rebuilds on your next `strux build`; edit `systemd/strux.service` or anything in `scripts/` or `plymouth/` and the rootfs-post step reruns. No special command needed — edited artifacts behave exactly like project source.

On the very first build, before anything has been copied out, the cache falls back to hashing the CLI's embedded versions, so first builds are tracked correctly too.

## CLI upgrades and edited artifacts

Because of write-once, **upgrading the CLI never overwrites your edited artifacts** — your customized `strux.sh` survives every upgrade. The flip side: it also means your copies don't pick up improvements shipped in newer CLI versions. The embedded *build scripts* (which run inside Docker and are not in `dist/artifacts/`) always come from the CLI and auto-invalidate the cache when they change, so the pipeline itself stays current; only the materialized assets stay frozen at your version.

When you do want the latest defaults, reset the artifacts: dev mode's configuration panel has a *restore artifacts* action that deletes `dist/artifacts/` and rewrites every file from the current CLI's built-in versions. Deleting individual files (or the whole directory) by hand works too — anything missing is recreated on the next build. Either way, your modifications to the restored files are lost, so keep meaningful customizations in version control.

::: warning dist/ is generated — but artifacts may be worth committing
Most of `dist/` (cache, output) should stay out of git. If you've customized files under `dist/artifacts/`, commit those specific files — otherwise a fresh clone silently falls back to the defaults.
:::

## Where to go next

- [Customizing the OS](/guide/customizing-the-os.md) — practical recipes that use these files.
- [Caching](/concepts/caching.md) — how artifact edits trigger rebuilds.
- [Architecture Overview](/concepts/overview.md) — where each artifact runs on the device.
