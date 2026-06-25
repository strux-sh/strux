# Display Stack

This page explains how your web app gets onto physical screens: the Cage compositor, the Cog browser, and the `display` configuration in `strux.yaml` that maps URL paths to monitors, touchscreens to outputs, and handles rotated panels.

## What's a compositor, anyway?

On a desktop, a window manager juggles overlapping windows. A kiosk doesn't need any of that — it needs exactly one app, full-screen, forever. A **Wayland compositor** is the Linux component that owns the displays and input devices and decides what gets drawn; **Cage** is a tiny one built for the kiosk case: it shows a single maximized application per output and nothing else. No taskbar, no alt-tab, nothing to escape into.

Strux ships a modified fork of Cage (the source is in your project at `dist/artifacts/cage/` — see [Artifacts](/concepts/artifacts.md)). The fork adds what kiosks need: rendering the boot splash itself for a seamless logo-to-app transition, spawning one browser per monitor, per-output rotation, and mapping touchscreens to the right screen.

Inside Cage runs **Cog**, a minimal browser shell around WPE WebKit — all of the rendering engine, none of the browser UI. For web developers: think of each Cog instance as one full-screen, chromeless browser tab pointed at your backend.

## From YAML to pixels

Displays are configured in `strux.yaml`. Here's a real two-monitor setup — a built-in DSI touch panel showing the main UI, and an HDMI output showing a different page of the same app:

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
      names:
        - HDMI-A-1
        - Virtual-2
```

What each key does (schema: `DisplaySchema` in `src/types/main-yaml.ts`):

| Key | Type | Description |
|-----|------|-------------|
| `path` | string (required) | URL path appended to your backend's base URL (`http://localhost:8080`). This monitor loads `http://localhost:8080` + `path`. |
| `resolution` | `WIDTHxHEIGHT` | Mode to set on this output (applied via `wlr-randr` before the browser starts). |
| `transform` | see below | Rotation/flip for this output. |
| `names` | string[] | Output names this entry matches — list several to cover hardware and QEMU. |
| `input_devices` | string[] | Input device name substrings (e.g. the touch controller's name) bound to this output. |

::: tip Where do output names come from?
The kernel names each video connector: `DSI-1` for a ribbon-cable panel, `HDMI-A-1` for the first HDMI port, `Virtual-1`/`Virtual-2` in QEMU. Listing both a hardware name and a `Virtual-*` name in `names` lets the same config work on the device and in `strux dev`.
:::

The plumbing between that YAML and the screen:

1. At build time, the CLI writes the monitor list to `.display-config.json` and the input mappings to `.input-map`, and the rootfs-post step installs them as `/strux/.display-config.json` and `/strux/.input-map` on the device.
2. At boot, the Strux client reads the config and writes a display map file, then launches Cage with `--display-map` and `--input-map`. Cage always runs in *per-view* mode: each app window is confined to its own output.
3. For every output it finds, Cage looks up the matching entry by name and spawns a Cog instance through `/strux/strux-run-cog.sh` — a user-editable script (in `dist/artifacts/scripts/`), so you can customize browser flags per output or even swap Cog for something else.
4. Each Cog loads your backend URL plus that monitor's `path`. Your frontend reads `location.pathname` and renders the right view — one app, one backend, multiple screens.

A connected output with no matching entry isn't left black: Cage points it at a built-in "not configured" page (`/strux/.not-configured.html`, also user-editable), so a misnamed output is immediately visible and self-explanatory.

```txt
strux.yaml display.monitors
        │ build
        ▼
/strux/.display-config.json ──▶ strux client ──▶ cage --display-map ... --input-map ...
                                                   ├─ output DSI-1    → strux-run-cog.sh → cog → localhost:8080/
                                                   └─ output HDMI-A-1 → strux-run-cog.sh → cog → localhost:8080/tv
```

If you configure nothing, you still get a working single display: the build falls back to one monitor at `path: /` using the BSP's `display.resolution`.

## Touch input mapping

With one screen, touch "just works." With two, the compositor has to know *which* screen a touch event belongs to — otherwise tapping the panel might click things on the HDMI output. That's what `input_devices` solves: each listed string is matched as a substring against input device names, and matching devices have their coordinates mapped to that monitor's first listed output. In the example above, the ILITEK touch controller is bound to `DSI-1`, so touches always land on the panel's UI regardless of how the outputs are arranged.

Devices with no mapping fall back to the first output. To find your touch device's name, check the kernel log or `/proc/bus/input/devices` on the device.

## Rotation transforms

Many tablet-style panels are physically portrait but mounted landscape. The `transform` key rotates an output in the compositor — the panel still scans out portrait, but everything you render (splash included) appears correctly rotated, and touch coordinates are rotated to match.

Accepted values: `normal`, `0`, `90`, `180`, `270`, `flipped`, `flipped-90`, `flipped-180`, `flipped-270` (the numeric ones can be written without quotes). Per-monitor in `strux.yaml`:

```yaml
display:
  monitors:
    - path: /
      transform: 90
      names:
        - DSI-1
```

A BSP can also set a board-wide default by exporting `STRUX_OUTPUT_TRANSFORM` in `bsp.cage.env` — that's how the some tablet BSPs rotate their portrait panel for every project built on it. A per-monitor `transform` in `strux.yaml` takes precedence over the environment value.

## What the BSP contributes

Two compositor-related knobs live in `bsp.yaml` rather than `strux.yaml`, because they're properties of the hardware:

```yaml
bsp:
  display:
    resolution: 1920x1080   # panel's native mode; default when strux.yaml has no display section
  cage:
    hide_cursor: true       # touch-only kiosk: never show a mouse cursor
    env:                    # environment for Cage and everything it spawns
      - WLR_DRM_NO_MODIFIERS=1
```

`cage.env` entries are baked into `/strux/.cage-env` at build time — typically wlroots/driver workarounds (`WLR_DRM_NO_MODIFIERS=1` appears in every shipped BSP) or the `STRUX_OUTPUT_TRANSFORM` default above. `hide_cursor: true` keeps the cursor hidden even when a pointer device is present.

## Where to go next

- [Frontend](/guide/frontend.md) — routing different paths to different views in your app.
- [Architecture Overview](/concepts/overview.md) — where the display stack sits in the boot chain.
- [bsp.yaml reference](/bsp/reference/bsp-yaml.md) — the `display` and `cage` keys in full.
- [strux.yaml reference](/reference/strux-yaml.md) — the `display.monitors` schema in full.
