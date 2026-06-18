# Caching

A full Strux build compiles a browser stack and assembles a Debian system — that can take a long time. The build cache makes every build after the first fast by skipping steps whose inputs haven't changed. This page explains how the cache decides, where it lives, and how to control it.

## The mental model

Every [build step](/concepts/build-pipeline.html) declares its **dependencies** — the files, directories, and configuration keys that affect its output. Before running a step, the CLI hashes all of them (SHA256-style content hashes) and compares against the hashes recorded the last time the step ran. Same hashes, artifacts still on disk, nothing upstream rebuilt → the step is skipped and you see:

```txt
✓ cached: frontend (no changes detected)
```

There are no timestamps involved in dependency comparison — only content hashes. Touching a file without changing it won't trigger a rebuild; changing one character will.

## What gets hashed

Each step has its own dependency list. A few examples of dependency kinds:

| Kind | Example | How it's hashed |
|------|---------|-----------------|
| Directory | `frontend/` for the frontend step | Every file inside, recursively, combined into one hash. `node_modules`, `.git`, `.DS_Store`, and `*.log` are always ignored. |
| File | `bsp/{bsp}/configs/kernel.config` for the kernel step | File contents. A missing file gets a stable "missing" hash, so deleting it also triggers a rebuild. |
| YAML key | `bsp.rootfs.packages` in `bsp.yaml` for rootfs-post | The value at that dot-notation path, serialized and hashed — so editing an unrelated key in the same file doesn't invalidate the step. |
| YAML-referenced file | The DTS file named in `bsp.boot.kernel.device_tree.dts` | The referenced file's contents. The cache follows paths *inside* YAML values, so editing your device tree source reruns the kernel step even though `bsp.yaml` itself didn't change. |
| Internal asset | The embedded build script for the step | See below. |

Steps also declare which other steps they depend on. `rootfs-post` depends on frontend, application, cage, wpe, client, kernel, and rootfs-base — if any of those ran more recently than the last `rootfs-post` run, it rebuilds too. That's how a one-line frontend change correctly cascades into a new rootfs without rebuilding the kernel.

Independently of dependency hashes, a step also reruns if any of its declared **output artifacts** is missing from disk — so deleting something from `dist/cache/` regenerates it instead of breaking the build.

## The manifest

All cache state lives in one JSON file per board:

```txt
dist/cache/{bsp}/.build-cache.json
```

For each step it records when it last ran, the hash of every dependency, and the artifacts it produced; BSP scripts get their own entries (see below). It also stores the current Docker image hash. The file is plain JSON — peeking inside is a good way to debug a step that rebuilds when you think it shouldn't (the CLI also logs the exact reason in debug output, e.g. `Rebuilding kernel: dependency changed: file:bsp/qemu/configs/kernel.config`).

Because the manifest is per-BSP, switching between `qemu` and a hardware BSP never invalidates anything — each board keeps its own cache and output directories.

## CLI upgrades invalidate the right steps automatically

The build scripts, the Cage and client sources, the systemd units — all of these are embedded inside the `strux` binary. Each step's dependency list includes the hashes of the embedded assets it uses (the step's build script, at minimum). When you upgrade the CLI and an embedded script changed, the hash changes, and exactly the affected steps rebuild on your next build. No manual cache clearing after upgrades.

The Dockerfile for the strux-builder image is tracked the same way, with a bigger hammer: if the Docker image gets rebuilt, **all** step caches are invalidated, since every step runs inside that image.

## Controlling the cache

Cache behavior is configured under `build.cache` in `strux.yaml`:

```yaml
build:
  cache:
    enabled: true             # default: true — set false to disable caching entirely
    force_rebuild:            # steps that always rebuild, cache or not
      - kernel
    ignore_patterns:          # extra filename patterns ignored when hashing directories
      - "*.tmp"
```

- **`enabled: false`** runs every step, every time.
- **`force_rebuild`** takes step names (`frontend`, `application`, `cage`, `wpe`, `screen`, `client`, `kernel`, `bootloader`, `rootfs-base`, `rootfs-post`) and forces those to run regardless of hashes — useful while iterating on something the cache can't see.
- **`ignore_patterns`** adds to the built-in ignore list for directory hashing, so generated files in watched directories don't cause spurious rebuilds.

And from the command line:

```bash
strux build --clean
```

`--clean` deletes `dist/cache/{bsp}` for the **current BSP only** (other boards' caches survive) and rebuilds everything from scratch.

## BSP script caching

[BSP lifecycle scripts](/bsp/concepts/lifecycle-scripts.html) participate in the same manifest with a declaration-based scheme. In `bsp.yaml`, a script opts into caching by declaring what it produces and what it reads:

```yaml
scripts:
  - location: ./scripts/make-image.sh
    step: make_image
    description: "Create QEMU disk image"
    cached_generated_artifacts:
      - output/rootfs.ext4
    depends_on:
      - cache/rootfs-base.tar.gz
      - cache/rootfs-post.tar.gz
```

The script is skipped when *all* of these hold:

1. Every file in `cached_generated_artifacts` exists.
2. The script file itself hasn't changed since the last run.
3. None of the `depends_on` file hashes changed.

A script that declares no `cached_generated_artifacts` **always runs** — there's no way to know it's safe to skip. Paths resolve per the BSP path rules: `cache/` → `dist/cache/{bsp}/`, `output/` → `dist/output/{bsp}/`, `./` → the BSP directory (see [Path Resolution](/bsp/reference/path-resolution.html)).

## Where to go next

- [Build Pipeline](/concepts/build-pipeline.html) — what each cached step actually does.
- [Artifacts](/concepts/artifacts.html) — the user-editable assets the cache tracks.
- [strux.yaml reference](/reference/strux-yaml.html) — all `build.cache` options.
