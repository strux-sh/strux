# Dev Mode

`strux dev` is the live development loop: it builds a development image, boots it (in QEMU or connects to a real device using ```--remote```), and keeps your running app in sync with your code as you edit. This page is the full tour — what starts when you run it, how the terminal UI works, how hot reload behaves for each kind of file, and how to develop against real hardware.

## What starts when you run `strux dev`

```bash
strux dev
```

In local mode (the default), Strux always uses your project's `qemu` BSP and brings up five things, in order:

1. **An initial build** of a development image — the same [build pipeline](/concepts/build-pipeline.md) as `strux build`, so the first run is slow and later runs are mostly cached.
2. **The dev server** — a WebSocket server (a persistent two-way connection between your machine and the device) on port 8000. The device connects back to it for log streaming, binary pushes, and remote commands.
3. **mDNS advertising** — the dev server announces itself on your local network as a `_strux-dev._tcp` service so devices can find it without knowing your IP. mDNS (also called Bonjour) is zero-configuration name discovery on a LAN.
4. **A file watcher** plus **the Vite dev server** — Vite runs inside Docker on port 5173 and serves your frontend with hot module replacement (HMR: changed modules are swapped into the running page without a reload).
5. **QEMU** — the development image boots in a virtual machine, and a window opens showing your app exactly as a device would display it.

::: tip Dev images are not production images
A development image enables the dev client, remote control paths, and log streaming. `strux run` refuses to boot one — see [Building](/guide/building.md#dev-images-vs-production-images).
:::

The dev server's port comes from the first entry in `dev.server.fallback_hosts` in `strux.yaml`, and defaults to 8000 if none is set.

## The terminal UI

`strux dev` runs a full-screen terminal UI. The left pane lists resources; the right pane shows the logs of whichever resource is selected:

- **Device** — the connected device's status and IP, with sub-streams: **App** (your Go backend's output), **Cage** (the Wayland compositor), **System Logs**, **Early Logs**, **Screen Logs**, and **Client** (the on-device Strux client).
- **Vite** — frontend dev server output.
- **QEMU** — emulator console output.
- **Watcher** — file change and rebuild activity.
- **Screen** — the remote screen stream daemon.
- **Flash** — only shown if the active BSP defines a `flash_script` (see [Flashing](/guide/flashing.md)).

Keybindings (also shown in the bottom bar):

| Key | Action |
| --- | --- |
| `j`/`k` | Navigate the resource list, or scroll logs when a log pane is focused |
| `Enter` | Focus the selected resource's logs |
| `Esc` | Back to the resource list |
| `Tab` | Switch between list and logs |
| `s` | Open a shell on the connected device (with **Device** selected and connected); `Ctrl-\` detaches, `s` reattaches |
| `p` | Pause/resume the file watcher |
| `c` | Open the config panel |
| `/` | Filter the current log view |
| `q` / `Ctrl-C` | Quit |

The shell opened with `s` is a real `/bin/bash` on the device, tunneled through the dev server's WebSocket connection — no SSH setup required. Detaching keeps the session alive on the device so you can reattach later.

The config panel (`c`) offers one-keystroke maintenance actions: restore Strux artifacts to their built-in versions, rebuild Strux components and transfer them to the device, rebuild the builder Docker image, install the latest [system update bundle](/guide/updates.md), flash the device (if the BSP supports it), restart the Strux service, and reboot the device.

::: tip Running without the TUI
Set `STRUX_DEV_NO_UI=1` to run dev mode with plain log output instead of the terminal UI.
:::

## Hot reload: what happens when you edit

Different files take different paths back to the running device:

- **Frontend files** (`frontend/`) — Vite handles these directly. In dev mode the device loads your frontend from the Vite server on port 5173, not from a compiled bundle, so changes hot-reload in the running page within a second.
- **Go files** (`*.go`, `go.mod`, `go.sum`) — the file watcher recompiles your application and pushes the new binary to the connected device over the WebSocket. The app restarts with the new binary in seconds; no image rebuild, no reboot.
- **`strux.yaml`** — a YAML change triggers a full image rebuild, because configuration can affect any build step. The [build cache](/concepts/caching.md) keeps this fast: only the steps whose inputs actually changed are rebuilt.

The watcher ignores `frontend/` (Vite's job), `dist/`, `assets/`, `bsp/`, `overlay/`, and `.git/`. That means edits to `bsp/` or `overlay/` do **not** trigger a dev rebuild — run a build manually (or restart dev mode) to pick those up. Rapid changes are debounced, and changes made while the watcher is paused (`p`) are replayed when you resume.

## Developing on a real device with `--remote`

Once you have hardware running a development image (see [Flashing](/guide/flashing.md)), you can point dev mode at it instead of QEMU:

```bash
strux dev --remote
```

`--remote` skips the local build and QEMU entirely. It uses the `bsp` field from `strux.yaml` (instead of forcing `qemu`) and just runs the dev server, Vite, the watcher, and the TUI. The device finds and connects to your machine on its own.

How the device finds you is controlled by `dev.server` in `strux.yaml`:

```yaml
dev:
  server:
    fallback_hosts:
      - host: 10.0.2.2
        port: 8000
    use_mdns_on_client: true
    client_key: a-long-random-string
```

- **`use_mdns_on_client`** — when `true`, the on-device client browses the network for the `_strux-dev._tcp` service and tries discovered hosts first.
- **`fallback_hosts`** — explicit `host`/`port` pairs the client tries after (or instead of) mDNS. Put your machine's LAN IP here if mDNS doesn't work on your network. The template's `10.0.2.2` is the address a QEMU guest uses to reach your machine — replace it (or add entries) for real devices.
- **`client_key`** — a shared secret the device presents when connecting. `strux dev` refuses to start without one. `strux init` generates it for you; treat it like a password.

Once connected, everything works the same as with QEMU: log streams, Go binary pushes, the device shell, and frontend hot reload — the device loads the frontend from the Vite server on the host it connected to, port 5173.

If the device can't reach the dev server at boot, it falls back to production mode and runs the app baked into its image.

## The WebKit remote inspector

WPE WebKit ships a remote inspector — the same Web Inspector you know from desktop Safari (console, elements, network, debugger), served over HTTP so you can open it from any browser. Enable it in `strux.yaml`:

```yaml
dev:
  inspector:
    enabled: true
    port: 9223
```

Each monitor gets its own inspector port, assigned sequentially from the base port (monitor one on 9223, monitor two on 9224, and so on). The device reports its assigned ports to the dev server, and the TUI's Device pane shows them.

- **QEMU**: dev mode forwards the inspector ports from your machine into the guest, so open `http://localhost:9223` in a browser.
- **Real device**: open `http://<device-ip>:9223`.

The inspector only runs in development images — production launches without it.

## USB debug networking

For devices with a USB device/OTG port, the dev client can set up a USB network gadget: the device presents itself as a USB Ethernet adapter ("Strux USB Debug") when you connect it to your machine with a cable. This gives you a direct, router-free network link — useful before Wi-Fi is configured, or on locked-down networks.

```yaml
dev:
  usb:
    enabled: true
    subnet: 192.168.7.0/24
```

`enabled` defaults to `true` and `subnet` to `192.168.7.0/24`; your machine gets the first usable address in the subnet via DHCP and the device takes the second. When the USB link is up, the client prefers it for reaching the dev server.

## Command reference

| Flag | Description |
| --- | --- |
| `--remote` | Serve a remote device: skip the local build and QEMU, use the BSP from `strux.yaml` |
| `--clean` | Clean the BSP's build cache before the initial build |
| `--debug` | Show device log streams |
| `--vite` | Show Vite dev server output |
| `--no-app-debug` | Disable app output streaming |
| `--no-rebuild` | Skip the initial image build and reuse existing artifacts (the Go app is still recompiled if its source changed) |
| `--no-chown` | Skip file permission fixing after builds |
| `--local-runtime <path>` | Use a local Strux repo for the Go runtime instead of the published module |

`--no-rebuild` requires an existing image — if `dist/output/<bsp>/` is missing the kernel, initramfs, or root filesystem, dev mode tells you to run without the flag first.

## Where to go next

- [Building](/guide/building.md) — the build pipeline you just triggered, and how caching keeps it fast.
- [Frontend](/guide/frontend.md) and [Backend](/guide/backend.md) — what to actually write inside this loop.
- [Flashing](/guide/flashing.md) — get a development image onto real hardware for `--remote`.
- [Updates](/guide/updates.md) — push full system updates to a connected device.
