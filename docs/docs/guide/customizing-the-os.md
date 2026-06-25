# Customizing the OS

Your project's `strux.yaml` controls more than the app — it shapes the operating system itself. This page covers the boot splash, adding your own files and packages to the image, the device hostname, and multi-monitor display configuration.

All examples on this page are real keys from the `strux.yaml` schema (`src/types/main-yaml.ts` in the CLI). Run `strux build` after changing any of them — the [build cache](/concepts/caching.md) only rebuilds the steps affected by your change.

## Boot splash

A kiosk should never show a Linux console scrolling text. With the splash enabled, the device shows your logo from early boot until your app takes over:

```yaml
boot:
  splash:
    enabled: true
    logo: ./assets/logo.png
    color: "000000"
```

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | — | Turn the splash on or off. |
| `logo` | path | — | A PNG file, relative to the project root. |
| `color` | string | — | 6-digit hex color, **without** the `#` (e.g. `"1a1a2e"`). |

How it works: at build time your logo is copied into the image, where it's shown twice — first by Plymouth (the Linux boot splash system) during early boot, then by Strux's Cage compositor while the browser engine starts. Your app appears only when it's ready to render, so the user never sees an in-between state.

::: tip Make the hand-off invisible
Set `color` to the background color of your app, and give your app's root element that same background. The splash fades into your UI with no visible transition. The color is also passed to BSP scripts as `SPLASH_COLOR`, so boards that render a bootloader splash can match it too — see [environment variables](/bsp/reference/environment-variables.md).
:::

If the logo file is missing, the build logs an error and falls back to the default Strux logo rather than failing.

## The rootfs overlay

::: tip What's a rootfs?
The **root filesystem (rootfs)** is the entire Linux filesystem of your device — `/etc`, `/usr`, `/home`, everything. Strux assembles a minimal Debian rootfs for you during the build. An **overlay** is a folder in your project whose contents get copied on top of that filesystem, verbatim.
:::

```yaml
rootfs:
  overlay: ./overlay
```

Anything you put in the overlay folder lands at the same path in the image. For example, to ship a custom SSH server configuration:

```txt
overlay/
└── etc/
    └── ssh/
        └── sshd_config    →  becomes /etc/ssh/sshd_config on the device
```

The overlay is applied near the end of the rootfs build with `rsync`, so files overwrite anything already at that path, and permissions (including executable bits) are preserved. If your BSP also defines an overlay, the BSP overlay is applied first and your project overlay second — your files win on conflict.

Common uses: systemd units, udev rules, network configuration, certificates, fonts, and any static files your Go backend reads at runtime.

## Installing packages

Your image is based on Debian, so you can install anything from the Debian package archive — or your own `.deb` files:

```yaml
rootfs:
  packages:
    - curl
    - ffmpeg
    - openssh-server
    - ./packages/my-driver.deb
```

- **Package names** (like `ffmpeg`) are installed with `apt-get install --no-install-recommends` inside the image during the build. Anything available in Debian works.
- **Paths ending in `.deb`** are resolved relative to the project root, copied into the image, and installed with `dpkg -i` (with an automatic `apt-get install -f` to pull in their dependencies). Use this for vendor drivers or your own packaged software.

A missing `.deb` file produces a warning and is skipped, so check the build output if a package doesn't show up on the device.

::: tip BSP packages live in the BSP
Board-specific packages (firmware, hardware tools) belong in the BSP's `bsp.yaml`, not here — they're merged with your project list at build time. See the [bsp.yaml reference](/bsp/reference/bsp-yaml.md).
:::

## Build scripts

The overlay copies files in, and `packages` installs from Debian. But sometimes you need to *run a command* while the image is being built — most often to install a tool that Debian ships too old. A build script lets you do that.

If you've used a `Dockerfile`, this is the same idea as a `RUN` line: a command that runs while the image is being put together, and whatever it leaves behind is baked into the final image. (Never written a Dockerfile? Think of an npm `postinstall` script — a small command that runs automatically during a build — except this one runs against the whole operating system.)

You point at a script file from `strux.yaml`:

```yaml
scripts:
  - location: ./scripts/install-yt-dlp.sh
    step: rootfs_post
    description: "Install latest yt-dlp from GitHub releases"
```

Your script runs after Strux has finished assembling the device's filesystem (the overlay and packages are already in place), and just before it packs everything into the final image file. That moment is called `rootfs_post`, and it's the only `step` available today.

### What your script can use

Right before your script runs, Strux unpacks the device's filesystem into a folder on your build machine, then hands your script a few tools to work with:

- **`$ROOTFS_DIR`** — the path to that folder. Everything inside it *is* the device's filesystem, so `$ROOTFS_DIR/usr/local/bin/` becomes `/usr/local/bin/` on the device. **To add a file to the image, write it somewhere under `$ROOTFS_DIR`.**

- **`run_in_chroot "command"`** — run a command *as if it were running on the device itself*. Use it for device-side setup, like installing something with `apt-get` or enabling a service.

  ::: tip What's a "chroot"?
  Normally a command sees your build machine's filesystem. `chroot` (short for "change root") runs a command with a folder you choose treated as the entire filesystem `/`. So `run_in_chroot "apt-get install -y cowsay"` installs into the *image* you're building, not onto your laptop. `strux_chroot` is an alias for the same thing if you prefer that name.
  :::

- **`strux_install_file <source> <destination> [mode]`** — copy a file from your project into the image, creating any missing folders along the way. For example, `strux_install_file ./assets/config.json /etc/myapp/config.json 0644` puts the file at `/etc/myapp/config.json` on the device. (The `mode` is the file's Unix permissions and defaults to `0644` — readable by everyone, writable by the owner.)

- **`strux_progress "message"`** and **`strux_progress_bar "message" 50`** — print a status line or progress bar so your script's work shows up in the build output like every other step.

Your script also gets the build's environment variables. The handy one is **`$TARGET_ARCH`** — the device's CPU type, like `arm64` — which lets you download the right file for the hardware. There are [more environment variables](/bsp/reference/environment-variables.md) available too.

### A real example

Say you want the newest `yt-dlp` (a video downloader that updates constantly, so the Debian package is almost always out of date). This script downloads the build that matches the device's CPU and drops it into the image:

```bash
#!/bin/bash
set -euo pipefail

# Pick the download that matches the device's CPU.
case "$TARGET_ARCH" in
    arm64)  ASSET="yt-dlp_linux_aarch64" ;;
    x86_64) ASSET="yt-dlp_linux" ;;
esac

strux_progress "Downloading the latest yt-dlp..."
curl -fsSL -o "$ROOTFS_DIR/usr/local/bin/yt-dlp" \
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSET}"
chmod 0755 "$ROOTFS_DIR/usr/local/bin/yt-dlp"

# Run it inside the image to confirm the download actually works.
run_in_chroot "/usr/local/bin/yt-dlp --version"
```

The `curl` writes straight into `$ROOTFS_DIR`, so the binary ends up at `/usr/local/bin/yt-dlp` on the device. The last line is a safety check: if the download was broken, `yt-dlp --version` fails — and when a script fails, Strux stops the whole build, so you catch the problem now instead of shipping a broken image.

### How often it runs

By default, your script runs on **every build** — which is exactly what you want for "always grab the latest." If instead your script does something slow that rarely changes, you can let Strux skip it when nothing relevant has changed: list the files your script creates under `cached_generated_artifacts` (and, optionally, files it depends on under `depends_on`). See [caching](/concepts/caching.md) for the details.

::: warning Write your script so it's safe to run twice
Sometimes Strux runs your script against an image that already contains the result of a previous run (this happens when the build reuses a cached filesystem). So **overwrite instead of adding to**: copying a file into place again is harmless, but a line like `echo "..." >> /etc/some.conf` would add the line a second time. If your script only writes or replaces files — like the example above — you're already safe.
:::

## Hostname

```yaml
hostname: lobby-kiosk
```

The hostname is written to `/etc/hostname` and `/etc/hosts` in the image. It's how the device identifies itself on the network — useful when you have a fleet and want `lobby-kiosk` and `cafe-kiosk` distinguishable in your router's client list.

Resolution order: `hostname` in `strux.yaml`, then `bsp.hostname` in the BSP's `bsp.yaml`, then the default `strux`.

## Multi-monitor displays

A Strux device can drive several screens, each showing a different route of your app. This is one config block doing three jobs: which route goes where, how each screen is oriented, and which touchscreen controls which display.

```yaml
display:
  monitors:
    - path: /
      resolution: 1920x1080
      names:
        - DSI-1
        - Virtual-1
      input_devices:
        - ILITEK
    - path: /tv
      resolution: 1920x1080
      transform: 90
      names:
        - HDMI-A-1
        - Virtual-2
```

| Key | Type | Default | Description |
|---|---|---|---|
| `path` | string | — | The app route to show on this output. Appended to your frontend's base URL — `/tv` loads your app's `/tv` route. |
| `resolution` | string | — | `WIDTHxHEIGHT`, e.g. `1920x1080`. Optional. |
| `transform` | string/number | — | Rotation/flip: `normal`, `90`, `180`, `270`, `flipped`, `flipped-90`, `flipped-180`, `flipped-270`. Optional. |
| `names` | string[] | — | Output connector names this entry applies to. Optional. |
| `input_devices` | string[] | — | Touch/pointer devices bound to this output. Optional. |

With this example, the built-in DSI panel shows your app's home route while the HDMI screen shows the `/tv` route, rotated 90 degrees — each in its own dedicated browser instance, confined to its own output.

A few details worth knowing:

- **`names` are connector names** like `HDMI-A-1`, `DSI-1`, or `eDP-1` — how Linux identifies each physical video output. List several names for the same entry so one config works on both real hardware and QEMU, which calls its outputs `Virtual-1`, `Virtual-2`, and so on.
- **`input_devices` map touchscreens to outputs.** Each entry is a substring of the input device's name (e.g. `ILITEK` matches `ILITEK ILITEK-TP`). A matched device is bound to the first name in `names`, so touches land on the right screen — essential when two touchscreens are connected, and when a rotated display needs its touch coordinates rotated to match.
- **`transform` rotates the output** — `90` is the usual choice for portrait kiosks. Touch input mapped to that output is transformed with it.
- **Unconfigured outputs** show a "not configured" page instead of stretching your app across them.
- **No `display` section at all** is fine: you get a single monitor at `/` using the BSP's display resolution.

If you change `display` settings, rebuild — the config is baked into the image (the device reads it from `/strux/.display-config.json` at boot).

## Where to go next

- [Project Structure](/guide/project-structure.md) — every file in your project, explained.
- [Building](/guide/building.md) — the build command and its options.
- [Display Stack](/concepts/display-stack.md) — how Cage and WPE WebKit put your app on screen.
- [Updates](/guide/updates.md) — ship a new OS version to devices in the field.
