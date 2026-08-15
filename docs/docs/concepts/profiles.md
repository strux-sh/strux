# Device Profiles

A device profile tells your web app **which product experience this image should show**. It gives the frontend a stable name such as `kiosk` or `wallboard`, without making the frontend understand hardware-specific BSP names.

Profiles are useful when one Strux project supports several kinds of device. For example, the same Vue or React app might render a touch-first checkout screen on one device and a read-only status display on another.

## Profiles and BSPs solve different problems

A **BSP** describes hardware: the CPU architecture, kernel, bootloader, display defaults, device drivers, and image format.

A **profile** describes the application experience: which layout, navigation, controls, or feature presentation the frontend should use.

Keeping these separate matters because the relationship is not always one-to-one:

- Several BSPs can produce the same kind of product, so they can share one profile.
- One flexible BSP can be used for several products, so it can appear in more than one profile.
- The frontend can use a clear name like `kiosk` instead of checking for board names such as `rk3576-panel-v2`.

Profiles do not replace BSP capabilities. Use `strux.capabilities` to ask whether the hardware implements Wi-Fi, display backlight, audio, or another BSP-provided API. Use a profile to choose the product experience.

## Define profiles in strux.yaml

```yaml
bsp: qemu

profiles:
  - name: kiosk
    label: Self-service kiosk
    bsp:
      - qemu
      - rk3576-touch-panel

  - name: wallboard
    label: Production wallboard
    bsp:
      - qemu
      - rk3588-signage
```

Each profile has three fields:

- `name` is the stable value used by application code. Profile names must be unique.
- `label` is a human-readable name for CLI menus and other user interfaces.
- `bsp` is the non-empty list of BSP names that normally use this profile.

The `profiles` section itself is optional. Existing projects without profiles continue to work as before.

## How a build chooses a profile

When you run a build, Strux compares the selected BSP with every profile's `bsp` list:

| Match result | What Strux does |
| --- | --- |
| Exactly one profile matches | Selects it automatically. |
| More than one profile matches | Opens a menu containing the matching profiles. |
| No profile matches | Opens a menu containing every declared profile. |
| No `profiles` section exists | Builds without profile metadata. |

For scripts and CI jobs, pass the profile explicitly so the build never needs an interactive menu:

```bash
strux build rk3576-touch-panel --profile kiosk
```

An explicit `--profile` is an override. It may select any profile declared in `strux.yaml`, even when the current BSP is not listed under that profile. This is helpful when testing a product experience against QEMU or bringing up a new board.

Use the same flag with the local development workflow:

```bash
strux dev --profile wallboard
```

The dev TUI's **Rebuild Strux Components and Transfer To Device** action also synchronizes the selected profile. It stages the new metadata alongside the rebuilt components and applies it before the backend starts after reboot. If profiles were removed from `strux.yaml`, the same workflow removes the old profile file so the device cannot keep stale profile state.

::: tip Building several profiles for one BSP
Build outputs remain grouped by BSP under `dist/output/<bsp>/`. If you build the same BSP again with a different profile, the new build replaces that BSP's previous output. Copy or publish the first image before building the next one if you need to keep both.
:::

## Read the profile in the frontend

The selected profile is part of the image, so the frontend reads the same value after every boot:

```ts
const profile = await strux.profiles.GetProfile()

if (profile?.name === "kiosk") {
  showTouchCheckout()
} else if (profile?.name === "wallboard") {
  showProductionDashboard()
} else {
  showDefaultExperience()
}
```

`GetProfile()` returns:

```ts
interface Profile {
  name: string
  label: string
}
```

It returns `null` when the project was built without a `profiles` section. Read the profile during application startup and keep it in your normal frontend state store if several components need it.

## What is stored in the image

Strux writes only the selected profile's `name` and `label` to:

```txt
/etc/strux/profile.json
```

The BSP matching lists remain build-time configuration in `strux.yaml`; they are not copied into the device image. The Go runtime reads the file for `strux.profiles.GetProfile()`.

For BSP developers, this means a profile does not change the BSP package, kernel, bootloader, or runtime providers. It is application metadata added while Strux assembles the final image. Changing the selected profile invalidates the root filesystem post-processing cache so the next image contains the new value.

## Where to go next

- [strux.yaml reference](/reference/strux-yaml.md#profiles) — exact schema and validation rules.
- [Building](/guide/building.md#selecting-a-device-profile) — day-to-day build commands.
- [Frontend](/guide/frontend.md#choosing-a-device-specific-view) — using the profile in web application code.
- [Frontend API reference](/reference/frontend-api.md) — the complete `window.strux` interface.
