# Updates

A kiosk in the field needs a way to receive new software without someone driving out with an SD card. Strux ships an over-the-air (OTA) update system: you build a new image, sign it into a bundle, and push it to devices — which install it onto a spare copy of the OS and roll back automatically if it doesn't boot. This page walks through the whole workflow.

::: warning Experimental
The update system is built on an A/B dual-rootfs layout that is **experimental and may change**. It also requires a BSP that implements the dual-rootfs partition conventions — the bundled QEMU BSP does not, so you need an update-capable BSP for your hardware. See [Update System](/concepts/update-system.html) for how it works and [Dual Rootfs](/bsp/concepts/dual-rootfs.html) for the BSP side. We're currently working on a native way to automatically push updates to devices and help you manage fleets of devices. If you're interested in this, please email [Strux Support](mailto:support@medeirosconsulting.ca).
:::

## How it fits together

An update is a **signed bundle** (a `.struxb` file) containing a complete root filesystem image. The device keeps two copies of the OS — slot A and slot B — and always runs from one while the other sits idle. Installing an update writes the new OS to the idle slot, then reboots into it. If the new version never comes up, the bootloader falls back to the old one. You never brick a device with a bad update.

Updates are signed with an RSA key that only you hold. The matching public key is baked into every image, and devices refuse any bundle that doesn't verify against it.

## 1. Generate a signing keypair (once)

`strux init` already did this for you — look for `strux-update.key` and `strux-update.pub` next to `strux.yaml`. If you need to generate them manually:

```bash
strux update gen-keypair
```

| Flag | Description |
|---|---|
| `--private-key <path>` | Private key output path. Defaults to `./strux-update.key`. |
| `--public-key <path>` | Public key output path. Defaults to `./strux-update.pub`. |
| `-f, --force` | Overwrite existing key files. |

This creates a 4096-bit RSA keypair. The **public key** (`strux-update.pub`) is built into your images — commit it. The **private key** (`strux-update.key`) signs your updates — it's written with owner-only permissions and the generated `.gitignore` already excludes it.

::: danger Keep the private key safe
Anyone with `strux-update.key` can sign updates your devices will install. And devices in the field only trust the public key they were built with — if you lose the private key, you can't ship updates to them anymore. Back it up somewhere secure.
:::

## 2. Enable updates in strux.yaml

```yaml
update:
  enabled: true
  auto_bundle: true
```

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Build an update-capable (A/B) image. Exposed to BSP scripts as `STRUX_UPDATE_ENABLED`. |
| `auto_bundle` | boolean | `false` | Automatically create a signed bundle at the end of every build. |

With `enabled: true`, your BSP builds the dual-slot disk image and bakes `strux-update.pub` into the rootfs. With `auto_bundle: true` you can usually skip step 4 below entirely.

## 3. Build

```bash
strux build
```

An update-enabled build produces, in `dist/output/<bsp>/`:

- the full disk image to flash onto new devices, and
- `rootfs.ext4` — the bare root filesystem image, which is the update payload.

If `auto_bundle` is on, the signed bundle (`rootfs.ext4.struxb`) is created here too, and you can jump to step 5.

## 4. Create a signed bundle

```bash
strux update bundle
```

| Flag | Description |
|---|---|
| `[rootfs-image]` | The rootfs image to bundle. Defaults to `dist/output/<bsp>/rootfs.ext4`. |
| `--private-key <path>` | Signing key. Defaults to `./strux-update.key`. |
| `--bsp <name>` | Target BSP name. Defaults to the BSP from `strux.yaml`. |
| `--version <version>` | Version label. Defaults to `project_version` from `strux.yaml`. |
| `-o, --out <path>` | Output path. Defaults to `dist/output/<bsp>/rootfs.ext4.struxb`. |

This hashes the rootfs image, writes a manifest, and signs it with RSA-PSS/SHA-512 (inside the builder container, so you don't need OpenSSL locally). The result is a single `.struxb` file — the complete, verifiable update.

::: tip Bump the version
Set `project_version` in `strux.yaml` before building a release. The version is recorded in the bundle and reported by devices during installation.
:::

## 5. Send it to a device

With `strux dev` running and a device connected (the device must be running an update-enabled image, so this means real hardware with an update-capable BSP):

```bash
strux update send
```

| Flag | Description |
|---|---|
| `[bundle]` | Path to a `.struxb` file. If omitted, the dev server picks the newest bundle in `dist/output/<bsp>`. |
| `--server <url>` | Dev server URL. Defaults to `STRUX_DEV_SERVER_URL` or `http://127.0.0.1:8000`. |
| `--key <key>` | Auth key. Defaults to `dev.server.client_key` from `strux.yaml`. |

The dev server offers the bundle to the connected device over a one-time download URL; the device streams, verifies, and installs it, reporting progress back into the [dev mode](/guide/dev-mode.html) TUI. The command currently targets a single connected device — sending with multiple devices connected is not yet supported.

A `.struxb` bundle is just a file, and the device verifies it cryptographically regardless of where it came from — the dev server is simply the built-in delivery channel today.

::: tip Update via the Dev TUI
You can also send updates to devices if they are connected to the ```strux dev --remote``` Terminal User Interface (TUI). Simply press ```c``` on your keyboard and select ```Install Latest System Update Bundle``` while your device is connected. A progress bar will display in the main Device window with the progress of the update.
:::

## What happens on the device

1. The device verifies the bundle's manifest signature against the public key baked into the image at `/etc/strux/update.pub`, and rejects bundles built for a different BSP.
2. The new rootfs is streamed onto the **inactive** slot while downloading — it never touches the running system.
3. The written slot is read back and verified (size and SHA-256) against the signed manifest.
4. The bootloader environment is updated: the new slot is marked *pending* with a budget of 3 boot attempts, and the device reboots.
5. If the new OS boots and the Strux client starts, the slot is marked *active* and the update is complete. If it never comes up, the bootloader exhausts the try counter and falls back to the previous OS automatically.

Your frontend can observe all of this: the Go runtime exposes update progress and slot state under the `update` namespace of the generated API — see the [Go runtime reference](/reference/go-runtime.html).

## Where to go next

- [Update System](/concepts/update-system.html) — the bundle format, signing model, and A/B mechanics in depth.
- [Dual Rootfs](/bsp/concepts/dual-rootfs.html) — what a BSP must implement to support updates.
- [Flashing](/guide/flashing.html) — initial installation on new hardware.
