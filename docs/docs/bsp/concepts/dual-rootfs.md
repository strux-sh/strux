# Dual Rootfs & A/B Updates

This page explains how Strux applies a full-system update on a device without risking a brick: two root filesystem slots, A and B. An update is written to the slot you're *not* running, and the bootloader switches over only if the new slot boots. If it doesn't, the device falls back to the old one.

::: warning Experimental
The A/B update system is new in v0.3.0 and still hardening. The **on-device contract described here** — partition labels, kernel cmdline keys, boot-environment format, and state-file locations — is what a BSP must honor today, and these pages document it so BSP authors can ship compatible builds. But the design may still change in a future release. Treat the conventions below as required for v0.3.0 builds, and expect to revisit them when you upgrade Strux.
:::

## The mental model

A normal embedded device has one root filesystem. Updating it in place is dangerous: lose power halfway through writing the new OS and the device won't boot. The fix is **two slots**:

```txt
                 ┌──────────────────────────────────────┐
   running ────▶ │  strux-rootfs-a   (active)           │
                 ├──────────────────────────────────────┤
   update ─────▶ │  strux-rootfs-b   (inactive ← write) │
                 ├──────────────────────────────────────┤
                 │  strux-data       (boot state, FAT32)│
                 └──────────────────────────────────────┘
```

You boot from slot A. An update writes the new OS into slot B while A keeps running. The device then marks B as *pending*, reboots, and the bootloader tries B. If B boots cleanly, it becomes the new active slot. If B fails to boot, the bootloader exhausts its retry count and falls back to A — the device is never left without a working OS.

A third partition, `strux-data`, is a small FAT32 volume holding the boot-selection state. It survives updates (neither rootfs write touches it) and is readable by both U-Boot and Linux.

## Who builds what

This is the key thing to understand. The work is split between **Strux core** and the **BSP**:

| Strux core provides | The BSP author provides |
| --- | --- |
| The bundle format (`.struxb`) and signing | The A/B partition layout (image generation) |
| The on-device updater (in the strux client) | The U-Boot boot script that selects a slot |
| The slot-selection *contract* (labels, cmdline, state files) | A boot config that installs the update public key |
| Signature verification on device | Wiring all of the above into the build via scripts |

The updater that applies a bundle is shipped by Strux and compiled into every image — a BSP author does **not** write update logic. What a BSP author must do is lay out partitions and configure the bootloader so they match the contract the updater expects. Get the labels and cmdline right and updates "just work"; get them wrong and the updater can't find its slots.

## The bundle: `.struxb`

An update is distributed as a signed bundle, produced by [`strux update bundle`](/reference/cli.md#strux-update-bundle) (or automatically when `update.auto_bundle` is set — see [Updates](/guide/updates.md)). It is a gzip-compressed tar archive containing:

- `manifest.json` — metadata: schema (`dev.strux.update.bundle.v1`), target BSP, version, and a `payload` block describing the rootfs image with its size and SHA-256.
- `manifest.sig` — an RSA-PSS / SHA-512 signature over `manifest.json`, base64-encoded.
- `rootfs.img` — the full root filesystem image.

The payload is a **full rootfs**, not a delta. The signature covers the manifest, and the manifest pins the payload's SHA-256 — so verifying the manifest signature and then checking the payload hash proves the whole bundle is authentic and intact.

Bundles are signed with a 4096-bit RSA key you generate with [`strux update gen-keypair`](/reference/cli.md#strux-update-gen-keypair). The private key (`strux-update.key`) signs; the public key (`strux-update.pub`) is embedded in the image and used on-device to verify. See [Updates](/guide/updates.md) for the signing workflow.

## The on-device contract

These are the conventions a BSP must implement so the Strux updater can do its job. They are fixed strings — the updater hard-codes them.

### Partition labels

The updater locates slots by **partition label** via `/dev/disk/by-partlabel/`:

| Label | Filesystem | Role |
| --- | --- | --- |
| `strux-rootfs-a` | ext4 | Root filesystem slot A |
| `strux-rootfs-b` | ext4 | Root filesystem slot B |
| `strux-data` | FAT32 | Boot-selection state |

Both rootfs slots must be the same size (an update written to either must fit). The filesystem label of each slot is expected to match its partition label; the updater relabels a freshly written slot with `e2label` to keep them in sync.

### Kernel command line

The bootloader must tell the running system which slot it booted from, by adding to the kernel command line:

```txt
strux.slot=A          # or B
strux.data=PARTLABEL=strux-data
```

On boot, the updater reads `/proc/cmdline`, finds `strux.slot=`, and that tells it which slot is active — and therefore which slot (the other one) to write the next update into. Typical full bootargs also set `root=PARTLABEL=strux-rootfs-a rootfstype=ext4 rw rootwait` for the selected slot.

### The `strux-data` partition layout

The FAT32 data partition is mounted at `/strux-data`, and the boot state lives under a `strux/` subfolder:

| Path (on the device) | Purpose |
| --- | --- |
| `/strux-data/strux/BOOTENV.TXT` | Primary boot environment |
| `/strux-data/strux/BOOTBAK.TXT` | Backup copy (used if the primary is corrupt) |
| `/strux-data/strux/update-state.json` | Update state mirrored for the runtime/UI |
| `/strux-data/strux/boot.scr` | Compiled U-Boot boot script (optional placement) |

`BOOTENV.TXT` is a plain `key=value` file the bootloader and the updater both read and write:

```txt
strux_active=A
strux_pending=
strux_tries=0
strux_generation=1
```

| Key | Meaning |
| --- | --- |
| `strux_active` | The slot to boot normally (`A` or `B`) |
| `strux_pending` | A slot being trialed after an update; empty when none |
| `strux_tries` | Boot attempts remaining for the pending slot before fallback |
| `strux_generation` | Counter incremented on each successful switch |

Two copies (`BOOTENV.TXT` + `BOOTBAK.TXT`) give crash resilience: if power is lost mid-write, the bootloader can fall back to the backup.

### The update public key

The signing public key must be installed in the rootfs at:

```txt
/etc/strux/update.pub
```

The updater loads this PEM key, requires it to be RSA ≥ 4096 bits, and verifies every bundle's manifest signature against it before writing anything. A BSP's boot-config step is responsible for copying the project's `strux-update.pub` to this path when updates are enabled.

## How an update plays out

Putting the contract in motion, here is the full sequence when a bundle is applied:

1. **Verify.** The updater opens the `.struxb`, extracts `manifest.json` + `manifest.sig`, and verifies the signature with `/etc/strux/update.pub` (RSA-PSS / SHA-512). It checks the schema and that the bundle's target BSP matches the installed one.
2. **Pick the inactive slot.** It reads `strux.slot=` from `/proc/cmdline` and chooses the opposite slot's device by partlabel.
3. **Write & hash.** It streams `rootfs.img` straight onto the inactive slot's block device, computing SHA-256 as it goes and comparing against the manifest. It relabels the slot's filesystem to match.
4. **Mark pending.** It updates the boot environment: `strux_pending` = the just-written slot, `strux_tries` = 3, and bumps `strux_generation`, writing both `BOOTENV.TXT` and `BOOTBAK.TXT`.
5. **Reboot.** The device reboots. The bootloader sees a pending slot with tries remaining, decrements the counter, and boots it.
6. **Confirm or fall back.** If the pending slot boots successfully, the updater promotes it: `strux_active` = pending, `strux_pending` cleared, tries reset. If it fails to boot, the bootloader's retry logic exhausts `strux_tries` and reverts to `strux_active` — the old, known-good slot.

The bootloader half of steps 5–6 is the part a BSP author writes (a U-Boot boot script that reads `BOOTENV.TXT` and implements the try/fallback logic). The rest is the Strux client.

## What a BSP author must deliver

To support A/B updates on a board, a BSP needs all of the following, gated on updates being enabled for the build:

1. **An A/B partition image.** An image-generation config (e.g. genimage) defining `strux-rootfs-a`, `strux-rootfs-b` (equal-size ext4), and `strux-data` (FAT32), plus the board's fixed bootloader blob offsets. A non-update build can use a simpler single-rootfs layout.
2. **An image build script** that, when updates are enabled, produces the two-slot image and pre-populates `strux-data` with an initial `BOOTENV.TXT` (active = A, no pending).
3. **A U-Boot boot script** that reads `BOOTENV.TXT` from `strux-data`, selects active-vs-pending with the tries/fallback logic, loads the kernel from the chosen slot's partlabel, and sets the `strux.slot=` / `strux.data=` bootargs.
4. **A boot-config step** that installs `/etc/strux/update.pub` from the project key and adds the `strux-data` mount to `fstab`.

The real Rockchip BSPs under `test/bsp/` (notably `hd215-rk3576`) implement all four and are the reference to copy from — see [BSP Examples](/bsp/guide/examples.md).

## Current limitations

Because the system is experimental, note what it does **not** do yet in v0.3.0:

- **Full images only** — there are no delta/incremental updates; each bundle carries a complete rootfs.
- **No built-in update server or scheduling** — bundles are delivered out of band (today, pushed via the dev server with [`strux update send`](/reference/cli.md#strux-update-send)); there's no OTA check-in/availability protocol.
- **Limited field testing** — the boot-validation and fallback paths are implemented but new; validate them on your hardware before relying on them in production.

## Where to go next

- [Updates](/guide/updates.md) — generating keys, building, and sending bundles.
- [BSP Examples](/bsp/guide/examples.md) — the reference A/B BSP to copy from.
- [bsp.yaml reference](/bsp/reference/bsp-yaml.md) — bootloader and script configuration.
