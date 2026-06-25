# Environment Variables

Every environment variable Strux sets for BSP scripts, plus the variables the `strux` CLI itself reads from your shell. For when scripts run, see [Build Steps & Lifecycle Hooks](/bsp/reference/build-steps.md).

## Build script variables

Build-time lifecycle scripts (every step except `flash_script_tool` / `flash_script`) run inside the `strux-builder` Docker container with the project mounted at `/project`. They receive:

### Identity and target

| Variable | Value | Description |
| --- | --- | --- |
| `BSP_NAME` | e.g. `qemu` | Name of the BSP being built. |
| `PRESELECTED_BSP` | same as `BSP_NAME` | Alias for `BSP_NAME`. |
| `HOST_ARCH` | `arm64`, `x86_64`, or `armhf` | Architecture of the build machine. |
| `TARGET_ARCH` | `arm64`, `x86_64`, or `armhf` | Architecture of the target device (resolved from `bsp.arch`). |
| `STEP` | e.g. `make_image` | The lifecycle step the script is running at. |
| `STRUX_VERSION` | e.g. `0.3.0` | Version of the Strux CLI. |
| `PROJECT_NAME` | from `strux.yaml` | The project name. |
| `PROJECT_VERSION` | from `strux.yaml` | The project version. |
| `STRUX_UPDATE_ENABLED` | `true` / `false` | Whether the update system is enabled in `strux.yaml` (`update.enabled`). |

### Paths

Inside the container the project root is `/project` (when the CLI itself runs inside the builder container, e.g. in CI, these resolve to the real project path instead).

| Variable | Value | Description |
| --- | --- | --- |
| `PROJECT_DIR` | `/project` | Project root directory. |
| `PROJECT_FOLDER` | `/project` | Alias for `PROJECT_DIR`. |
| `PROJECT_DIST_DIR` | `/project/dist` | The `dist/` directory. |
| `PROJECT_DIST_FOLDER` | `/project/dist` | Alias for `PROJECT_DIST_DIR`. |
| `PROJECT_DIST_ARTIFACTS_FOLDER` | `/project/dist/artifacts` | Shared, user-editable build artifacts. See [Artifacts](/concepts/artifacts.md). |
| `SHARED_CACHE_DIR` | `/project/dist/cache` | Shared cache root, for artifacts reused across BSPs. |
| `BSP_CACHE_DIR` | `/project/dist/cache/{bsp}` | BSP-specific cache directory. |
| `PROJECT_DIST_CACHE_FOLDER` | `/project/dist/cache/{bsp}` | Alias for `BSP_CACHE_DIR`. |
| `PROJECT_DIST_OUTPUT_FOLDER` | `/project/dist/output/{bsp}` | BSP-specific output directory — where final images go. |
| `BSP_FOLDER` | `/project/bsp/{bsp}` | The BSP's own directory. |

### Splash and display (conditional)

Set only when the corresponding configuration exists.

| Variable | Value | Description |
| --- | --- | --- |
| `SPLASH_ENABLED` | `true` / `false` | From `strux.yaml` `boot.splash.enabled`. Only set when `boot.splash` is configured. |
| `SPLASH_LOGO` | path | From `strux.yaml` `boot.splash.logo`. Only set when a logo is configured. |
| `SPLASH_COLOR` | hex color | From `strux.yaml` `boot.splash.color`. Only set when a color is configured. |
| `DISPLAY_WIDTH` | e.g. `1920` | From `bsp.yaml` `display.resolution`. Only set when `display` is configured. |
| `DISPLAY_HEIGHT` | e.g. `1080` | From `bsp.yaml` `display.resolution`. Only set when `display` is configured. |

## Flash script variables

`flash_script_tool` and `flash_script` scripts are run by [`strux flash`](/guide/flashing.md) directly on your **host machine** (not in Docker), with the flash workspace as the working directory. They inherit your shell environment plus `BSP_NAME`, `PRESELECTED_BSP`, `HOST_ARCH`, `TARGET_ARCH`, `STRUX_VERSION`, and the splash/display variables above (`PROJECT_NAME`, `PROJECT_VERSION`, and `STRUX_UPDATE_ENABLED` are **not** set for flash scripts). The path variables point at real host paths:

| Variable | Value | Description |
| --- | --- | --- |
| `PROJECT_DIR` / `PROJECT_FOLDER` | host project path | Project root on your machine. |
| `PROJECT_DIST_DIR` / `PROJECT_DIST_FOLDER` | `{project}/dist` | The `dist/` directory. |
| `PROJECT_DIST_ARTIFACTS_FOLDER` | `{project}/dist/artifacts` | Shared artifacts directory. |
| `SHARED_CACHE_DIR` | `{project}/dist/cache` | Shared cache root. |
| `BSP_CACHE_DIR` / `PROJECT_DIST_CACHE_FOLDER` | `{project}/dist/cache/{bsp}` | BSP-specific cache. |
| `PROJECT_DIST_OUTPUT_FOLDER` | `{project}/dist/output/{bsp}` | BSP-specific output — where the image to flash lives. |
| `BSP_FOLDER` | `{project}/bsp/{bsp}` | The BSP directory. |
| `FLASH_DIR` | `{project}/dist/flash/{bsp}` | Flash workspace — the script's working directory; put downloaded tools here. |
| `PROJECT_DIST_FLASH_FOLDER` | same as `FLASH_DIR` | Alias for `FLASH_DIR`. |
| `STEP` | `flash_script_tool` or `flash_script` | Which flash stage is running. |

See [Flash Scripts](/bsp/guide/flash-scripts.md) for how to structure them.

## Variables the CLI reads

These are read from **your** environment when you run `strux`:

| Variable | Value | Description |
| --- | --- | --- |
| `STRUX_IN_CONTAINER` | `1` | Tells Strux it is already running inside the builder container (CI). Build scripts execute directly instead of spawning Docker, and verbose output is auto-enabled when there is no TTY. |
| `STRUX_VERSION` | version string | Overrides the CLI's reported version (set at compile time in CI; local builds fall back to `package.json`). |
| `STRUX_DEV_SERVER_URL` | URL | Default dev server URL for `strux update` when `--server` is not passed. Falls back to `http://127.0.0.1:8000`. |
| `STRUX_DEV_NO_UI` | `1` | Disables the interactive terminal UI in [`strux dev`](/guide/dev-mode.md), logging plainly instead. |
| `STRUX_GL` | `1` or `0` | Forces GL acceleration on (`1`) or off (any other value) for [`strux run`](/guide/running-qemu.md) QEMU. Unset, Strux auto-detects from the GPU vendor (Intel/AMD on, NVIDIA and unknown off). |

::: warning Values must be shell-safe
Strux validates script environment values before injecting them into the container; values that could break shell quoting are rejected. Keep paths and config values free of quotes and shell metacharacters.
:::
