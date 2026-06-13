# Backend

Your backend is a plain Go program using the Strux runtime library. It handles everything a browser can't — hardware, files, networking, system control — and exposes it all to your frontend as a typed API, automatically. This page covers the structure of `main.go`, the binding rules, events, the built-in system services, and how the typed frontend API is generated.

## Anatomy of main.go

The template scaffolded by `strux init` looks like this:

```go
package main

import (
	"log"

	"github.com/strux-dev/strux/pkg/runtime"
)

// App is the main application struct
// All public fields and methods are exposed to the frontend
type App struct {
	Title   string
	Counter int
}

// Greet returns a greeting message
func (a *App) Greet(name string) string {
	return "Hello, " + name + "!"
}

func main() {
	app := &App{Title: "my-kiosk", Counter: 0}

	// Init starts the IPC bridge and returns the runtime for event access.
	// Use runtime.Start(app) instead if you don't need events.
	rt, err := runtime.Init(app)
	if err != nil {
		log.Fatal(err)
	}
	defer rt.Stop()

	// Listen for events from the frontend
	rt.On("hello", func(data interface{}) {
		rt.Emit("hello-reply", map[string]string{"message": "Hello from Go!"})
	})

	// Start HTTP server (blocks)
	if err := rt.Serve(); err != nil {
		log.Fatal(err)
	}
}
```

Three pieces:

1. **An app struct** — your state and API surface. Exported fields and methods become the frontend API.
2. **The runtime** — `runtime.Init(app)` starts the IPC bridge (a Unix socket the browser's WebKit extension connects to). If you don't need events, `runtime.Start(app)` does Init + Serve in one blocking call.
3. **The HTTP server** — `rt.Serve()` serves your built frontend (with SPA fallback for client-side routing) and blocks. In production it listens on `127.0.0.1:8080` by default.

## What gets exposed

When the runtime starts, it walks your app struct with reflection and binds:

- **Exported methods** (uppercase first letter, pointer or value receiver) → async functions on `window.App` in the frontend.
- **Exported primitive fields** → live properties; the frontend can read and write them.
- **Exported struct fields** → nested namespaces. A field `Settings *settings.Settings` whose struct has an `Audio` field gives the frontend `window.App.Settings.Audio.SetMasterVolume(...)`. This nests to any depth.

Unexported fields and methods stay private — a lowercase field like `youtube *youtube.YouTube` is invisible to the frontend, which is the standard pattern for internals you expose through wrapper methods.

::: warning Initialize struct pointers before Init
The binding tree is built once, when you call `runtime.Init`/`runtime.Start`. A `nil` pointer field is skipped entirely — so construct your nested structs before handing the app to the runtime.
:::

### Method rules

- Parameters and return values travel as JSON, so use JSON-friendly types: primitives, structs, slices, maps.
- A trailing `error` return is handled for you: on error, the frontend call rejects and the generated TypeScript return type becomes `T | null`.
- Multiple non-error return values arrive in the frontend as an array.

```go
// Frontend sees: SearchYouTube(query: string): Promise<SearchResult[] | null>
func (a *App) SearchYouTube(query string) ([]youtube.SearchResult, error) {
	return a.youtube.SearchYouTube(query)
}
```

## Events

Method calls are always frontend-initiated. To push data the other way — progress updates, hardware state changes — use events:

```go
// Send to all connected frontends
rt.Emit("download:progress", map[string]any{"id": id, "percent": 42})

// Receive from the frontend; On returns an ID you can pass to Off
id := rt.On("video:play", func(data interface{}) {
	log.Printf("play requested: %v", data)
})
rt.Off(id)
```

`Emit` broadcasts to every connected page — useful on multi-monitor setups, where one display can drive another. A common pattern from a real project is relaying an event so all frontends see it:

```go
rt.On("video:play", func(data any) {
	rt.Emit("video:play", data) // control panel → TV display
})
```

The frontend side is `strux.ipc.send` / `strux.ipc.on` — see the [Frontend guide](/guide/frontend.html#events).

## The built-in Strux services

Beyond your own app, the runtime registers system services that the frontend reaches at `window.strux.<namespace>`:

| Service | Namespace | What it does |
|---------|-----------|--------------|
| Boot | `strux.boot` | `HideSplash`, `Reboot`, `Shutdown` |
| Display | `strux.display` | List outputs, change modes/resolution, layout, rotation, scale, backlight |
| Dev | `strux.dev` | Read and change dev-mode configuration on the device, restart the dev service |
| Network | `strux.network` | List interfaces, status, DHCP/static IP configuration |
| Project | `strux.project` | `Info()` — project name, version, BSP, architecture, build time |
| Update | `strux.update` | System update `State()` and `Progress()` |
| WiFi | `strux.wifi` | Scan, connect, known networks, IP configuration |
| Capabilities | `strux.capabilities` | `List()` and `Supports(name)` — discover what this device implements |

Display, Network, and WiFi are **capability-based**: the service is the stable API, but the implementation comes from the BSP, which registers a provider (`runtime.RegisterDisplayProvider`, `RegisterNetworkProvider`, `RegisterWiFiProvider`). On hardware whose BSP hasn't registered a provider, those calls fail — so check `strux.capabilities.Supports("wifi")` before building UI around them. See [Runtime Extensions](/bsp/guide/runtime-extensions.html) for the BSP side.

::: warning Experimental: the update system
`strux.update` reports the state of Strux's A/B dual-rootfs update mechanism, which is experimental in v0.3.0 — the design may change. See [Updates](/guide/updates.html) and [Dual Rootfs](/bsp/concepts/dual-rootfs.html).
:::

BSPs can also add entirely custom APIs under `window.strux.<name>` via `runtime.RegisterCustomExtension` — the [extension system](/bsp/concepts/extension-system.html) covers this.

## How the typed frontend API is generated

The `strux-introspect` tool (bundled with the CLI) parses your Go source — no compilation needed — using Go's AST parser:

1. It parses **every `.go` file in your main package**, so methods defined in other files are picked up.
2. It finds your app struct by locating the value passed to `runtime.Start(...)` or `runtime.Init(...)` (falling back to a struct named `App`).
3. It collects all exported fields and methods, follows struct-typed fields and method parameter/return types, and maps Go types to TypeScript (`string` → `string`, numbers → `number`, slices → arrays, structs → interfaces).
4. It merges in the definitions for the built-in `strux.*` services and any BSP runtime extensions, and writes `frontend/src/strux.d.ts`.

This runs automatically during `strux init` and at the start of every build. After changing your Go API mid-session, regenerate on demand:

```bash
strux types
```

## Developing the backend

In [dev mode](/guide/dev-mode.html), saving a Go file triggers a recompile, and the new binary is pushed to the running device or VM in seconds — no image rebuild. `log.Printf` output from your app streams straight into the dev TUI.

## Where to go next

- [Frontend](/guide/frontend.html) — calling all of this from the browser.
- [Go runtime reference](/reference/go-runtime.html) — the full `pkg/runtime` API.
- [Runtime Extensions](/bsp/guide/runtime-extensions.html) — implementing Display/Network/WiFi providers or custom APIs in a BSP.
