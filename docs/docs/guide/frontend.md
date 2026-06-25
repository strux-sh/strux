# Frontend

Your frontend is a normal web app — this page covers the one Strux-specific part: how it talks to your Go backend through an automatically generated, fully typed API. If you can build a Vite app, you can build a Strux frontend.

## It's just a Vite app

`strux init` scaffolds `frontend/` using the standard tooling for your chosen template: `npm create vite` for React and vanilla TypeScript, `npm create vue` for Vue. There's no Strux fork, no plugin, no custom config — your existing knowledge, component libraries, and routing all work as-is.

::: tip What's Vite?
Vite is the standard build tool for modern web apps: it serves your code with instant hot reload during development (called HMR — hot module replacement) and bundles it for production. The scaffolded React/Vue/vanilla templates all use it.
:::

On the device, your frontend runs full-screen in WPE WebKit — a real browser engine built for embedded hardware — composited by Cage. During development it runs in the same place, but served live from a Vite dev server on your machine.

## Talking to the Go backend

Strux injects your backend's API directly into the page as global objects. There's no HTTP client to write and no endpoints to define. Given the template's backend:

```go
type App struct {
	Title   string
	Counter int
}

func (a *App) Greet(name string) string {
	return "Hello, " + name + "!"
}
```

your frontend can do this, fully typed:

```ts
// Methods are async — every call returns a Promise
const greeting = await window.App.Greet("World")  // "Hello, World!"

// Exported fields are live properties — reads and writes go to Go
window.App.Counter = 5
console.log(window.App.Title)
```

`window.App` is also available at `window.go.main.App` (package name, then struct name).

### How it works under the hood

The Strux build compiles a WebKit extension into the browser. When your page loads, the extension asks your Go app for its bindings over a Unix socket (`/tmp/strux-ipc.sock`), then injects a JavaScript object for every exported struct, method, and field. Method calls and field accesses are forwarded to Go as JSON messages, and results come back as resolved Promises (or property values).

::: warning Bindings only exist on the device
The injection happens inside WPE WebKit on the device or QEMU VM. If you open your Vite URL in a desktop browser, `window.App` and `window.strux` won't exist — that's expected. Develop against the QEMU window that `strux dev` opens.
:::

### Nested state

Struct-typed fields on your app become nested objects with their own methods and properties, so a backend like `App.Settings.Audio` is called exactly as you'd hope:

```ts
await window.App.Settings.Audio.SetMasterVolume(80)
```

## Events

Method calls are frontend-initiated. For the other direction — Go pushing to the page — use the event system at `window.strux.ipc`:

```ts
// Listen for events from Go. on() returns an unsubscribe function.
const unsubscribe = strux.ipc.on("hello-reply", (data) => {
  console.log(data.message) // "Hello from Go!"
})

// Send an event to Go
strux.ipc.send("hello", { from: "frontend" })

// Later: stop listening
unsubscribe()
```

The template's `main.go` includes the matching Go side (`rt.On` / `rt.Emit`) — see [Backend](/guide/backend.md#events).

## System APIs: window.strux

Beyond your own app, Strux exposes built-in system services on `window.strux` — `boot`, `display`, `network`, `wifi`, `project`, `update`, `dev`, and `capabilities`. For example:

```ts
await strux.boot.HideSplash()           // dismiss the splash screen
const info = await strux.project.Info() // name, version, BSP, arch, build time
const nets = await strux.wifi.Scan(iface)
```

These are documented in the [Backend guide](/guide/backend.md#the-built-in-strux-services) and the [Frontend API reference](/reference/frontend-api.md).

## Generated types: strux.d.ts

Everything above is typed. Strux introspects your `main.go` and writes `frontend/src/strux.d.ts`, declaring `window.App` (with your real field and method signatures), `window.strux` with all system services, and interfaces for every struct your methods use. A Go method like:

```go
func (a *App) SearchYouTube(query string) ([]youtube.SearchResult, error)
```

becomes:

```ts
SearchYouTube(query: string): Promise<SearchResult[] | null>
```

Regenerate the file whenever you change your Go API:

```bash
strux types
```

It's also regenerated automatically when a project is scaffolded and at the start of every build, so it rarely goes stale. The file is marked `DO NOT EDIT` — your changes would be overwritten.

## The development loop

`strux dev` starts a Vite dev server (inside Docker, on port 5173) and points the device's browser at it. Edit anything under `frontend/` and the page hot-reloads in the QEMU window — or on a real device on your network — instantly. See [Dev Mode](/guide/dev-mode.md) for the full tour, including the WebKit inspector for debugging the page running on the device.

## Production serving

In a built image, your frontend is bundled by Vite and served by your own Go backend's HTTP server from `/strux/frontend`. The server has SPA fallback built in: any path that doesn't match a real file gets `index.html`, so client-side routing with Vue Router or React Router just works.

## Where to go next

- [Backend](/guide/backend.md) — the Go side of everything on this page.
- [Dev Mode](/guide/dev-mode.md) — remote devices, the inspector, USB networking.
- [Frontend API reference](/reference/frontend-api.md) — every injected global, exhaustively.
