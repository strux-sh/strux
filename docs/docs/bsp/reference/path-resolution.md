# Path Resolution

How Strux resolves the paths you write in a script entry's `cached_generated_artifacts` and `depends_on` in [bsp.yaml](/bsp/reference/bsp-yaml.md#bsp-scripts). Getting these right is what makes [script caching](/bsp/concepts/lifecycle-scripts.md) work.

## The rules

### `cached_generated_artifacts`

Paths describe files your script **generates**:

| Prefix | Resolves to | Example |
| --- | --- | --- |
| `cache/` | `dist/cache/{bsp}/` | `cache/bootloader/u-boot.bin` → `dist/cache/qemu/bootloader/u-boot.bin` |
| `output/` | `dist/output/{bsp}/` | `output/rootfs.ext4` → `dist/output/qemu/rootfs.ext4` |
| anything else | `dist/` | `artifacts/foo.bin` → `dist/artifacts/foo.bin` |

### `depends_on`

Paths describe files your script **reads**. One extra rule, checked first:

| Prefix | Resolves to | Example |
| --- | --- | --- |
| `./` | `bsp/{bsp}/` (the BSP directory) | `./boot/extlinux.conf` → `bsp/qemu/boot/extlinux.conf` |
| `cache/` | `dist/cache/{bsp}/` | `cache/rootfs-post.tar.gz` → `dist/cache/qemu/rootfs-post.tar.gz` |
| `output/` | `dist/output/{bsp}/` | `output/rootfs.ext4` → `dist/output/qemu/rootfs.ext4` |
| anything else | `dist/` | `artifacts/logo.png` → `dist/artifacts/logo.png` |

### `location`

The script path itself is always resolved relative to the BSP directory, with or without a leading `./` — `./scripts/make-image.sh` and `scripts/make-image.sh` are equivalent.

::: tip Inside your script, use the environment variables
These same locations are exposed to scripts as `PROJECT_DIST_CACHE_FOLDER`, `PROJECT_DIST_OUTPUT_FOLDER`, `BSP_FOLDER`, and friends — see [Environment Variables](/bsp/reference/environment-variables.md). Write to `$PROJECT_DIST_CACHE_FOLDER/...` in the script and declare the matching `cache/...` artifact in `bsp.yaml`.
:::

## How caching uses these paths

A script is **skipped** only when all of these hold (and `--clean` was not passed):

1. It declares at least one `cached_generated_artifacts` entry, and every declared artifact exists.
2. The script file itself is unchanged (SHA-style content hash).
3. Every `depends_on` file exists and its hash matches the last run.

A script with no `cached_generated_artifacts` runs on **every** build. See [Caching](/concepts/caching.md) for the wider build cache.

## Worked examples

From the qemu BSP that `strux init` scaffolds (`test/bsp/qemu/bsp.yaml`):

```yaml
scripts:
  - location: ./scripts/make-image.sh        # bsp/qemu/scripts/make-image.sh
    step: make_image
    description: "Create QEMU disk image"
    cached_generated_artifacts:
      - output/rootfs.ext4                   # dist/output/qemu/rootfs.ext4
    depends_on:
      - cache/rootfs-base.tar.gz             # dist/cache/qemu/rootfs-base.tar.gz
      - cache/rootfs-post.tar.gz             # dist/cache/qemu/rootfs-post.tar.gz
```

Read it as: "this script produces `rootfs.ext4` in the BSP output folder; re-run it only if that file is missing, the script changed, or either rootfs tarball changed."

From a real hardware BSP (`test/bsp/hd215-rk3576/bsp.yaml`), mixing BSP-local files and cache artifacts:

```yaml
scripts:
  - location: ./scripts/build-bootloader-rockchip.sh
    step: custom_bootloader
    cached_generated_artifacts:
      - cache/bootloader/u-boot.bin              # dist/cache/hd215-rk3576/bootloader/u-boot.bin
      - cache/bootloader/idbloader.img           # dist/cache/hd215-rk3576/bootloader/idbloader.img
    depends_on:
      - ./dts/rk3288-hd215-uboot-rockchip.dts    # bsp/hd215-rk3576/dts/... (BSP-local source)
      - ./blobs/rk3288_ddr_400MHz_v1.11.bin      # bsp/hd215-rk3576/blobs/... (vendor blob)
      - cache/kernel/rk3576-hd215-linux.dtb      # dist/cache/hd215-rk3576/kernel/... (built by the kernel step)
```

## Common mistakes

- **Pointing `depends_on` at a directory.** Dependency hashing works on regular files only. A directory (e.g. `./overlay/`) can't be hashed, so the script re-runs on every build — caching silently stops working. List the individual files you care about instead.
- **Project-root paths.** There is no rule that resolves to the project root. `strux.yaml` as a dependency resolves to `dist/strux.yaml`, which doesn't exist — the script will just always re-run. Only `./` (BSP dir), `cache/`, `output/`, and `dist/`-relative paths are addressable.
- **Using `./` in `cached_generated_artifacts`.** The `./` rule only applies to `depends_on`. In `cached_generated_artifacts`, `./foo` resolves under `dist/`, not the BSP directory. Generated artifacts belong in `cache/` or `output/` anyway.
- **Omitting `cached_generated_artifacts` and wondering why the script always runs.** No declared artifacts means Strux has nothing to check — the script runs every build by design. Declare what you generate, even if it's just a marker file like `cache/my-step.done`.
- **Forgetting the BSP name is part of the path.** `cache/` and `output/` are per-BSP (`dist/cache/{bsp}/`, `dist/output/{bsp}/`). Artifacts from another BSP's cache are not addressable through these prefixes.

## Related pages

- [bsp.yaml Reference](/bsp/reference/bsp-yaml.md) — the full script entry schema.
- [Build Steps & Lifecycle Hooks](/bsp/reference/build-steps.md) — when scripts run.
- [Lifecycle Scripts](/bsp/concepts/lifecycle-scripts.md) — the concept behind hook scripts and their caching.
