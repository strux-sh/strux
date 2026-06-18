# strux.yaml Reference

Every key in `strux.yaml`, the project configuration file at the root of a Strux project. The file is validated against a strict schema on every command that loads it — invalid values fail fast with a per-key error message. For what each subsystem does, follow the guide links in each section.

Three top-level keys are required: `project_version`, `name`, and `bsp`. Everything else is optional.

::: tip Shell-safe strings
Many string values feed into build scripts, so the schema rejects characters that could be interpreted by a shell: `$`, backticks, `;`, `&`, `|`, `<`, `>`, line breaks, and null bytes. Keys marked **shell-safe string** below enforce this. A **shell-safe relative path** additionally must be non-empty, have no leading or trailing whitespace, and must not be absolute (no leading `/` or Windows drive prefix).
:::

## Top-level keys

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `project_version` | string (semver) | — | **Required.** Your project's version, e.g. `1.2.3` or `1.2.3-beta.1`. Must be valid semver (prerelease and build suffixes allowed). Numbers are coerced to strings before validation. Used as the default version label for update bundles. |
| `name` | shell-safe string | — | **Required.** The project name. |
| `bsp` | shell-safe string | — | **Required.** The default board support package — must match a folder under `bsp/` in your project. Commands like `strux run`, `strux dev`, `strux flash`, and `strux kernel` use this BSP. See [BSPs](/concepts/bsp.html). |
| `hostname` | shell-safe string | — | The device hostname. |
| `boot` | object | — | Boot configuration. See [boot.splash](#boot-splash). |
| `update` | object | — | System update configuration. See [update](#update). |
| `display` | object | — | Monitor layout and routing. See [display.monitors](#display-monitors). |
| `rootfs` | object | — | Root filesystem overlay and packages. See [rootfs](#rootfs). |
| `scripts` | object[] | — | Project build scripts run against the assembled rootfs. See [scripts](#scripts). |
| `qemu` | object | — | QEMU settings for local testing. See [qemu](#qemu). |
| `build` | object | — | Build environment and cache settings. See [build](#build). |
| `dev` | object | — | Dev mode settings. See [dev](#dev). |

## boot.splash

The boot splash screen: the logo shown from power-on until your app takes over. If `boot.splash` is present, all three keys are required. See [Customizing the OS](/guide/customizing-the-os.html).

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `boot.splash.enabled` | boolean | — | **Required.** Whether to enable the boot splash. |
| `boot.splash.logo` | shell-safe relative path | — | **Required.** Path to the splash logo, relative to the project root, e.g. `./assets/logo.png`. |
| `boot.splash.color` | string | — | **Required.** Browser background color as a 6-digit hex value **without** the `#`, e.g. `"000000"`. Must match `[0-9A-Fa-f]{6}`. Makes the splash-to-app transition seamless. |

## update

Enables the signed system update mechanism. See the [Updates guide](/guide/updates.html) and the [update system concept page](/concepts/update-system.html).

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `update.enabled` | boolean | `false` | Enable system updates for this project. |
| `update.auto_bundle` | boolean | `false` | Automatically create a signed update bundle after builds. |

## display.monitors

Maps monitors to frontend routes — each monitor shows your app at a different URL path. If `display` is present, `monitors` must contain at least one entry. See the [display stack concept page](/concepts/display-stack.html).

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `display.monitors[].path` | string | — | **Required.** The frontend route this monitor displays, e.g. `/` or `/tv`. |
| `display.monitors[].resolution` | string | — | Resolution in `WIDTHxHEIGHT` format, e.g. `1920x1080`. Must match `\d+x\d+`. |
| `display.monitors[].transform` | string or number | — | Output rotation/flip: `normal`, `0`, `90`, `180`, `270`, `flipped`, `flipped-90`, `flipped-180`, or `flipped-270`. The numeric values `0`, `90`, `180`, `270` may be written unquoted; all values are normalized to strings. |
| `display.monitors[].names` | string[] | — | Output connector names this entry matches, e.g. `HDMI-A-1`, `DSI-1`, `Virtual-1`. |
| `display.monitors[].input_devices` | string[] | — | Input device names (e.g. a touchscreen controller) bound to this monitor. |

## rootfs

Customizes the root filesystem — the Linux filesystem your image boots from. See [Customizing the OS](/guide/customizing-the-os.html).

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `rootfs.overlay` | shell-safe relative path | — | Folder copied verbatim onto the root filesystem, e.g. `./overlay`. |
| `rootfs.packages` | shell-safe string[] | — | Debian packages to install into the image (package names or locations of `.deb` files). |

## scripts

Project build scripts run against the fully assembled root filesystem. Use these for app-specific image customization that doesn't belong in a shared BSP — installing a tool that isn't packaged, dropping in a binary, or running a one-off `chroot` step. See [Customizing the OS](/guide/customizing-the-os.html#build-scripts).

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `scripts[].location` | shell-safe relative path | — | **Required.** Path to the script, relative to the project root, e.g. `./scripts/install-yt-dlp.sh`. |
| `scripts[].step` | string | `rootfs_post` | Lifecycle step to run at. `rootfs_post` (the only step today) runs after rootfs post-processing and before image bundling. |
| `scripts[].description` | string | — | Human-readable label shown in build logs. |
| `scripts[].depends_on` | string[] | — | Files that invalidate the script's cache when changed. Project-relative when prefixed with `./`, otherwise resolved like generated artifacts (under `dist/`). |
| `scripts[].cached_generated_artifacts` | string[] | — | Files (relative to `dist/`) the script produces. If all exist and no dependency changed, the script is skipped. **Omit to run every build** — ideal for "always fetch the latest" steps. |

A `rootfs_post` script runs with `$ROOTFS_DIR` pointing at the extracted rootfs, the full [build environment](/bsp/reference/environment-variables.html) (`TARGET_ARCH`, `BSP_NAME`, `PROJECT_NAME`, …), and these helper functions: `run_in_chroot` / `strux_chroot`, `strux_install_file <src> <abs-dest> [mode]`, and `strux_progress` / `strux_progress_bar`. The harness repacks the rootfs in place after a successful run, so downstream bundling picks up the changes automatically; a failing script aborts the build. Scripts must be idempotent (overwrite, don't append).

## qemu

Controls how `strux run` and `strux dev` launch the image in QEMU. If `qemu` is present, `enabled` and `network` are required. See [Running in QEMU](/guide/running-qemu.html).

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `qemu.enabled` | boolean | — | **Required.** Whether to use QEMU for local testing. |
| `qemu.network` | boolean | — | **Required.** Whether to enable QEMU networking. |
| `qemu.usb` | object[] | — | USB devices to pass through to the VM. Manage this list with `strux usb` — see the [CLI reference](/reference/cli.html). |
| `qemu.usb[].vendor_id` | string | — | **Required per entry.** USB vendor ID as exactly 4 hex digits, e.g. `"1234"`. |
| `qemu.usb[].product_id` | string | — | **Required per entry.** USB product ID as exactly 4 hex digits, e.g. `"5678"`. |
| `qemu.flags` | shell-safe string[] | — | Extra flags appended to the QEMU command line, e.g. `-m 2G`. |

## build

Build environment and cache configuration. See the [build pipeline](/concepts/build-pipeline.html) and [caching](/concepts/caching.html) concept pages.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `build.host_packages` | shell-safe string[] | — | Packages installed into the `strux-builder` Docker image (repository packages only). |
| `build.cache.enabled` | boolean | `true` | Enable the smart build cache. |
| `build.cache.force_rebuild` | string[] | — | Build steps that always rebuild regardless of cache state. |
| `build.cache.ignore_patterns` | string[] | — | File patterns excluded from cache dependency hashing. |

## dev

Configures `strux dev`: the dev server, the WebKit inspector, and USB networking. See the [Dev Mode guide](/guide/dev-mode.html).

### dev.server

If `dev.server` is present, `use_mdns_on_client` and `client_key` are required.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `dev.server.fallback_hosts` | object[] | — | Hosts the dev server binds to and the dev client tries when mDNS discovery fails. |
| `dev.server.fallback_hosts[].host` | shell-safe string | — | **Required per entry.** Host address, e.g. `10.0.2.2` (the QEMU guest's address for the host machine). |
| `dev.server.fallback_hosts[].port` | integer (positive) | — | **Required per entry.** Port on that host, e.g. `8000`. |
| `dev.server.use_mdns_on_client` | boolean | — | **Required.** Whether the on-device dev client uses mDNS discovery to find the dev server. mDNS lets devices find services on the local network by name, without configuration. |
| `dev.server.client_key` | string | — | **Required.** Shared key the device uses to authenticate against the dev server. Also the default key for `strux update send`. |

### dev.inspector

The WebKit inspector gives you browser devtools for the app running on the device, served over HTTP.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `dev.inspector.enabled` | boolean | `false` | Enable remote debugging — open the inspector URL in any browser. |
| `dev.inspector.port` | integer (positive) | `9223` | Port for the inspector HTTP server. |

### dev.usb

USB networking between your machine and a device connected over a USB cable.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `dev.usb.enabled` | boolean | `true` | Enable USB networking in dev mode. |
| `dev.usb.subnet` | string | `192.168.7.0/24` | Subnet for the USB network link. Must be an IPv4 CIDR with at least two usable addresses (prefix length 0–30), e.g. `192.168.7.0/24`. |

## Full example

A complete, real-world `strux.yaml`. Every key validates against the schema described above.

```yaml
# Required: semver project version — also the default label for update bundles
project_version: 1.1.3

# Required: project name
name: test

# Required: the default BSP (a folder under bsp/)
bsp: ht109-rk3576s

# Device hostname
hostname: test

# Monitor-to-route mapping: each monitor shows a different frontend route
display:
  monitors:
    - path: /                  # main panel shows the root route
      resolution: 1920x1080
      names:
        - DSI-1                # connector name on real hardware
        - Virtual-1            # connector name in QEMU
      input_devices:
        - ILITEK               # touchscreen bound to this monitor
    - path: /tv                # second screen shows the /tv route
      resolution: 1920x1080
      names:
        - HDMI-A-1
        - Virtual-2

boot:
  splash:
    enabled: true
    logo: ./assets/logo.png    # relative path, PNG
    color: "000000"            # 6-digit hex, no leading #

# Signed system updates
update:
  enabled: true
  auto_bundle: true            # bundle automatically after builds

# Root filesystem customization
rootfs:
  overlay: ./overlay           # copied verbatim into the OS filesystem
  packages:                    # Debian packages installed into the image
    - curl
    - wget
    - openssh-server
    - ffmpeg

# Project build scripts run against the assembled rootfs
scripts:
  - location: ./scripts/install-yt-dlp.sh
    step: rootfs_post          # the only step today
    description: "Install latest yt-dlp from GitHub releases"
    # No cached_generated_artifacts → runs every build (always fetches latest)

# QEMU settings for local testing
qemu:
  enabled: true
  network: true
  # usb:                       # managed by `strux usb add` / `strux usb list`
  #   - vendor_id: "1234"
  #     product_id: "5678"
  flags:
    - -m 2G                    # extra QEMU flags

build:
  host_packages:               # extra packages in the builder Docker image
    - curl
    - wget

dev:
  server:
    fallback_hosts:            # tried when mDNS discovery fails
      - host: 10.0.2.2         # the host machine, as seen from the QEMU guest
        port: 8000
    use_mdns_on_client: true
    client_key: X0MPYU5D0DXWY0UHHWPWKCCEHT5EHEPR
  inspector:
    enabled: true              # browser devtools for the on-device app
    port: 9223
```
