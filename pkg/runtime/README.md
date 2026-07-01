# Strux Runtime API

This package is the bridge between the Go backend running on the device and the
JavaScript frontend running in the kiosk browser. It exposes Go methods as
`window.strux.<namespace>.*` calls, lets the backend push events to the frontend,
and lets a BSP plug board-specific implementations into standard Strux APIs.

This README is the implementer's guide. It covers, in order:

1. **Anatomy of a standard API** — the Contract / Capability / Service trio.
2. **Events** — the per-service emitter, and how the contract pins event shapes.
3. **Lifecycle** — the `Start` / `Stop` hooks and shutdown orchestration.
4. **Optional features** — methods a BSP *may* implement, detected at runtime.
5. **Adding a *new* capability** — the framework-side checklist (e.g. Battery, NFC).
6. **Implementing a capability on a BSP** — the board-side checklist.

Audio is the worked example throughout; `network.go`, `wifi.go`, and `display.go`
follow the identical structure (minus lifecycle — only audio currently runs a
background monitor).

---

## 1. Anatomy of a standard API

A standard API (network, wifi, audio, …) is made of three pieces, each with one
job. Using audio:

### `AudioContract` — what the BSP implements

An interface. The list of operations a board must provide, plus the lifecycle
hooks. No behavior; a BSP writes a struct that satisfies it.

```go
type AudioOps interface {
    GetState() (AudioState, error)
    SetVolume(percent int) error
    SetOutput(id string) error
    // ...other operations...
}

type AudioContract interface {
    AudioOps
    // ...other operations...

    Start(ctx context.Context, events AudioEvents) error // lifecycle — see §3
    Stop(ctx context.Context) error                      // lifecycle — see §3
}
```

### `Audio` — the capability (the socket the implementation plugs into)

Created with `DefineCapability[AudioContract](...)`. It holds the single
registered implementation, enforces one-per-capability, and carries the
metadata that powers `strux.capabilities` — name, namespace, **method**
descriptions, and **event** descriptions.

```go
var Audio = DefineCapability[AudioContract](CapabilitySpec{
    Name:      CapabilityAudio,
    Namespace: AudioNamespace,
    Methods:   []MethodSpec{ /* descriptions for introspection */ },
    Events:    []EventSpec{ /* descriptions for introspection */ },
})

// A BSP plugs in its implementation:
func RegisterAudioProvider(provider AudioContract) { Audio.RegisterOrPanic(provider) }
```

### `AudioService` — what the frontend actually calls

This struct is registered into the runtime and reflected to JS as
`strux.audio.*`. Each method looks up the registered implementation, returns a
clean `UnsupportedError` if no BSP provides it, validates input, and forwards.

```go
type AudioService struct {
    Service   // embed -> gives this service an event emitter (see §2)
}

func (AudioService) SetVolume(percent int) error {
    if percent < 0 || percent > 100 { return fmt.Errorf("volume must be 0–100") }
    provider, ok := Audio.Provider()
    if !ok { return UnsupportedError{Capability: CapabilityAudio} }
    return provider.SetVolume(percent)
}
```

The full call path:

```
JS  strux.audio.SetVolume(60)
  -> reflection bridge
  -> AudioService.SetVolume   (validation + "unsupported" handling)
  -> Audio.Provider()         (the registered BSP implementation)
  -> Provider.SetVolume       (the board-specific code)
```

> The Service layer is deliberate boilerplate: it's what gives every BSP free
> input validation, graceful "this board doesn't support X" behavior, and a
> stable reflected surface decoupled from the swappable implementation. The
> verbose `Provider()` lookup above is shown for clarity; real services use the
> `providerOf` helper (§5) to collapse it to one line, and a `var _` assertion to
> guarantee the service mirrors the contract.

---

## 2. Events: per-service, separate from `strux.ipc`

`strux.ipc` (via `rt.Emit` / `strux.ipc.on`) is the **application's** event bus —
reserved for app code. Framework/service events use a **separate channel** so the
two never collide.

Any service that embeds `Service` can emit:

```go
s.Emit("changed", state)   // -> window.strux.audio.on("changed", cb)
```

- The event is **namespaced automatically** by the service's path
  (`strux.audio:changed` on the wire) and delivered only to
  `strux.audio.on(...)` listeners.
- `on` / `off` are **auto-attached to every** `strux.<service>` object — you do
  not write any frontend glue.
- `Emit`, `On`, and `Off` are **reserved**: a service cannot expose methods with
  those names.

Frontend usage:

```js
const state = await strux.audio.GetState()        // pull the current value
const off = strux.audio.on("changed", (s) => {})  // subscribe to updates
// off()  // unsubscribe
```

### The contract pins the event shape; `EventSpec` documents it

A BSP cannot emit "whatever it wants". Events are a **typed interface** the
framework implements and hands to the provider:

```go
type AudioEvents interface {
    Changed(state AudioState)   // method name == event name ("changed")
}
```

The provider is handed a value of this interface type in `Start`. Go interface
values expose **only** the methods declared on the interface, so the provider
*cannot*:

- invent an event name — there is no string-based `Emit` in its hands at all;
- send a wrong payload — `Changed` only accepts `AudioState`, checked at compile time;
- emit another API's events — it holds `AudioEvents`, not `NetworkEvents`.

That is the enforcement. **`EventSpec` is the documentation counterpart** — it
mirrors the interface into `strux.capabilities` so the frontend and tooling can
see that `strux.audio` emits `changed: AudioState`, exactly the way `MethodSpec`
surfaces methods:

```go
Events: []EventSpec{
    {Name: "changed", Description: "Emitted when audio state changes.", Payload: "AudioState"},
},
```

The interface is what the compiler enforces; `EventSpec` is what humans and JS
read. Keep both in sync — every method on `AudioEvents` should have an
`EventSpec` entry.

### How the wiring works (framework-internal)

`audioEvents` implements `AudioEvents` by forwarding to the service's namespaced
emitter — and it is **unexported**, so the BSP never sees the raw `Emit` or the
`"changed"` string:

```go
type audioEvents struct{ emit func(event string, data any) }
func (e audioEvents) Changed(state AudioState) { e.emit("changed", state) }
```

Because every provider-emitted event passes through this forwarder, it is also
the natural place to clamp or normalize a payload (e.g. guard `volume` into
0–100) before it reaches the wire. The type system guarantees the *shape*; the
forwarder is where you'd guarantee *values*.

---

## 3. Lifecycle: `Start` and `Stop`

A capability that owns hardware or a background loop declares two lifecycle hooks
on its contract. The framework drives them; the BSP just implements them.

### `Start(ctx, events) error` — setup, then run

`Start` does one-time setup and then runs the change-monitor loop until `ctx` is
cancelled. The framework runs it in **its own goroutine**, so a plain blocking
loop is fine — the BSP never writes `go`.

The return value carries two meanings:

- **Returns an error *before* `ctx` is done** → setup or the loop failed. The
  framework logs it and leaves the capability degraded; the app does not crash.
- **Returns `nil` after `ctx.Done()`** → a clean stop.

```go
func (p *Provider) Start(ctx context.Context, events AudioEvents) error {
    if err := p.configureCodec(); err != nil {
        return fmt.Errorf("audio setup failed: %w", err) // setup failure
    }
    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()
    for {
        select {
        case <-ctx.Done():
            return nil                                    // clean stop
        case <-ticker.C:
            if changed { events.Changed(p.state()) }      // typed, compile-checked
        }
    }
}
```

> One-time setup folds into the top of `Start` — there is deliberately no
> separate `Setup` hook. `init()` (registration), `Start` (run), `Stop`
> (teardown) is the whole lifecycle.

### `Stop(ctx) error` — deadline-bounded teardown

`Stop` releases hardware on shutdown — e.g. muting amplifiers before power is cut
to avoid a speaker pop. The framework calls it and **waits up to the deadline
carried by `ctx`**, which is why teardown is a separate synchronous hook rather
than just cancelling `Start`'s loop.

```go
func (p *Provider) Stop(ctx context.Context) error {
    p.muteAmps()    // safe teardown, bounded by ctx's deadline
    return nil
}
```

### How the framework drives it

A service that runs a provider loop embeds **`monitor`** (alongside `Service`).
`monitor` owns the identical plumbing — the cancellable context, the goroutine,
the error capture, and the graceful stop — so the service's `start()` / `stop()`
only supply the capability-specific glue:

```go
type AudioService struct {
    Service
    monitor   // -> cancel/done state + run()/stopWith(); no per-service fields
}

// start() — called once at boot by StartService.
func (s *AudioService) start() {
    provider, ok := Audio.Provider()
    if !ok { return }
    s.run("audio", func(ctx context.Context) error {     // monitor.run handles ctx + goroutine + logging
        return provider.Start(ctx, audioEvents{emit: s.Emit})
    })
}

// stop(ctx) — called by StopService on shutdown.
func (s *AudioService) stop(ctx context.Context) error {
    provider, ok := Audio.Provider()
    if !ok { return nil }
    return s.stopWith(ctx, provider.Stop)                 // monitor.stopWith: Stop -> cancel -> wait, bounded by ctx
}
```

`monitor.run` launches the provider in a framework-owned goroutine and logs any
error that isn't our own shutdown cancel (the app never crashes on a provider
fault). `monitor.stopWith` runs the provider's `Stop` first (mute amps), then
cancels the loop and waits for the goroutine — never past `ctx`'s deadline. The
~15 lines of plumbing live once in `monitor` ([`service.go`](api/service.go)),
not in every service.

### Shutdown orchestration

`rt.Stop()` walks every registered service in **reverse registration order**,
calling each teardown hook under a single shared deadline
(`shutdownGracePeriod`, 5s), *before* closing the IPC socket. This is reached
today via `defer rt.Stop()` in the app's `main.go`, and is the same path a
future `strux.system` shutdown call would trigger.

```
rt.Stop()
  -> for each service (reverse order): StopService(ctx, instance)   // ctx = 5s deadline
       -> Provider.Stop(ctx)   // mute amps, release hardware
  -> close IPC socket
```

A service that needs no teardown (network, wifi, display today) simply does not
implement `stop()`, and `StopService` is a no-op for it.

---

## 4. Optional features

§1 covers the **mandatory** contract — the operations every provider must
implement. But some controls only make sense on some boards: headphone-jack
auto-switching needs a detectable jack; microphone control needs a capture path.
Forcing every BSP to stub those — and report success for hardware it doesn't
have — is exactly what optional features avoid.

An **optional feature** is a named group of methods a provider *may* implement,
declared on the capability and detected at runtime. The provider opts in by
satisfying a Go interface; the framework reports per-feature availability through
`strux.capabilities`, and a call to an unimplemented feature returns a clean
`UnsupportedFeatureError`. Audio declares two: `autoSwitch` and `capture`.

### The three pieces of a feature

**1. An interface — what the provider optionally implements.** Kept *out* of the
contract, so a provider can omit it entirely:

```go
// Optional: only boards with a detectable headphone jack implement this.
type AudioAutoSwitch interface {
    SetAutoSwitch(enabled bool) error
    AutoSwitch() (bool, error)
}
```

**2. A `FeatureSpec` — declared on the capability.** `Requires` is that
interface, built with the `InterfaceType[I]()` helper. `Methods`/`Events` are the
introspection metadata for what the feature adds — the same role `MethodSpec`
plays for the mandatory surface:

```go
var Audio = DefineCapability[AudioContract](CapabilitySpec{
    // ...Name, Namespace, mandatory Methods, Events...
    Features: []FeatureSpec{
        {
            Name:        "autoSwitch",
            Description: "Automatic output switching on headphone-jack insertion.",
            Requires:    InterfaceType[AudioAutoSwitch](),   // <- the opt-in interface
            Methods: []MethodSpec{
                {Name: "SetAutoSwitch", Description: "Enables/disables auto switching."},
                {Name: "AutoSwitch",    Description: "Returns whether it is enabled."},
            },
        },
    },
})
```

**3. Service methods — delegated through `featureOf`.** A feature's methods are
*always* on the reflected service surface (so JS can always call them);
`featureOf` resolves the provider, asserts the feature interface, and returns the
right error when it is missing:

```go
func (AudioService) SetAutoSwitch(enabled bool) error {
    feature, err := featureOf[AudioAutoSwitch](Audio)   // UnsupportedError | UnsupportedFeatureError
    if err != nil { return err }
    return feature.SetAutoSwitch(enabled)
}
```

Contrast with a **mandatory** method, which uses `providerOf`:

```go
func (AudioService) SetVolume(percent int) error {
    provider, err := providerOf(Audio)                  // UnsupportedError only
    if err != nil { return err }
    return provider.SetVolume(percent)
}
```

`providerOf` answers *"is this capability present?"*; `featureOf` answers *"is it
present **and** does it implement this feature?"*. Both errors cross the bridge
as structured JSON, so the frontend can distinguish "no audio at all" from
"audio, but no microphone".

### Detecting a feature from the frontend

Two equivalent signals — use whichever fits the moment:

- **Ahead of time** — `strux.capabilities` lists each feature with an `available`
  flag, computed from whether the registered provider satisfies `Requires`:

  ```js
  const audio = (await strux.capabilities.List()).find(c => c.name === "audio")
  const hasMic = audio.features.find(f => f.name === "capture")?.available
  ```

- **In the data** — optional state rides in the state DTO as a pointer field the
  framework fills only when the feature is present, and leaves `null`/absent
  otherwise:

  ```js
  const { autoSwitch, capture } = await strux.audio.GetState()
  if (autoSwitch != null) { /* show the auto-switch toggle */ }
  if (capture)            { /* show mic controls       */ }
  ```

> **Composing optional state.** A provider's `GetState` fills only the **core**
> fields. The framework overlays the optional ones — by asserting the same
> feature interfaces — in a small `enrich…` composer, on *both* the pull path
> (`GetState`) and the push path (the `changed` event), so every snapshot the
> frontend sees is complete and identical in shape. A provider never hand-stuffs
> an optional field.

### Adding a new optional feature — checklist

In `api/<name>.go`, to add feature `FooBar` to capability `Foo`:

1. **Define the interface** (`type FooBar interface { … }`), separate from `…Contract`.
2. **Add a `FeatureSpec`** to the capability's `Features`, with
   `Requires: InterfaceType[FooBar]()` and `Methods`/`Events` descriptions.
3. **Add the delegating service methods**, each resolving via `featureOf[FooBar](Foo)`.
4. **Add a `var _ FooBar = FooService{}`** assertion, so the build fails if the
   service surface forgets a feature method.
5. **If the feature contributes state**, add a pointer field to the state DTO,
   tagged `json:"foo,omitempty" strux:"optional"`, and populate it in the
   `enrich…` composer. The `strux:"optional"` tag is what makes the generated
   TypeScript render the field as `foo?: T` — present only when the feature is —
   so the frontend can detect it from the state shape. (A plain pointer is *not*
   made optional; the tag is the explicit opt-in, scoped to feature state.)
6. **Re-export the interface** (and any new DTOs) from `runtime.go`, so a BSP
   implements `struxruntime.FooBar`.
7. Regenerate the frontend types: `bun run generate:types`.

A BSP then opts in simply by **adding the methods to its provider** — no
registration call, no flag. Omit them and the feature reports unavailable. The
HT109 reference board implements `autoSwitch` (it has a jack) but not `capture`;
see `test/bsp/ht109-rk3576s/runtime/audio/audio.go`.

---

## 5. Adding a *new* capability (framework side)

To add a brand-new standard API — say `battery` or `nfc` — you create **one new
file** and edit **two existing** ones. All three are required: writing only
`api/<name>.go` compiles fine but the capability never reaches `window.strux`,
because nothing registers it. The wiring in `api.go` is the part that's easy to
forget.

| File | What to add |
|---|---|
| `api/<name>.go` *(new)* | DTOs, events interface + forwarder, `…Ops` + `…Contract`, the `Capability`, the `…Service`, `Register…Provider`, and — if it runs a loop — the `start()`/`stop()` hooks |
| `api.go` *(edit — 3 sites)* | the `rt.<Name>()` accessor, the `Register…Provider` re-export, **and** the `rt.registerStruxAPI(...)` call inside `registerBuiltinExtensions()` |
| `runtime.go` *(edit)* | type aliases re-exporting the Contract, DTOs, events interface, and capability const so BSPs import only `struxruntime` |

Audio is the full reference; the steps below build `battery` end-to-end.

### Step 1 — `api/<name>.go`

Define the five pieces, in this order:

```go
package api

import "context"

// 1. Identifiers.
const (
    BatteryNamespace  = "battery"
    CapabilityBattery = "battery"
)

// 2. DTOs — the JSON-tagged structs crossing the bridge.
type BatteryState struct {
    Percent  int    `json:"percent"`
    Charging bool   `json:"charging"`
    Health   string `json:"health"`
}

// 3. Events — the typed surface the BSP emits through (one method per event).
type BatteryEvents interface {
    Changed(state BatteryState)
}

// 4a. Ops — the operation surface, shared by the provider and the service.
//     Splitting this out lets a `var _ BatteryOps = BatteryService{}` assertion
//     enforce that the service mirrors it (see below).
type BatteryOps interface {
    GetState() (BatteryState, error)
}

// 4b. Contract — operations + lifecycle. This is what a BSP implements.
type BatteryContract interface {
    BatteryOps
    Start(ctx context.Context, events BatteryEvents) error
    Stop(ctx context.Context) error
}

// 5. Capability — the socket, with introspection metadata.
var Battery = DefineCapability[BatteryContract](CapabilitySpec{
    Name:        CapabilityBattery,
    Namespace:   BatteryNamespace,
    Description: "BSP battery state with live change events.",
    Methods: []MethodSpec{
        {Name: "GetState", Description: "Returns charge percent, charging flag, and health."},
    },
    Events: []EventSpec{
        {Name: "changed", Description: "Emitted when charge level or charging state changes.", Payload: "BatteryState"},
    },
})

func RegisterBatteryProvider(provider BatteryContract) { Battery.RegisterOrPanic(provider) }
```

Then the **Service** (app-facing surface) — one delegating method per operation,
each returning `UnsupportedError` when no BSP is registered:

```go
type BatteryService struct {
    Service
    monitor   // only if the capability runs a Start/Stop loop (see below)
}

// Compile-time guarantee that the service mirrors the operation surface.
var _ BatteryOps    = BatteryService{}   // split BatteryContract into BatteryOps + lifecycle, as audio does
var _ BatteryEvents = batteryEvents{}

func (BatteryService) GetState() (BatteryState, error) {
    provider, err := providerOf(Battery)   // shared "provider or UnsupportedError" helper
    if err != nil {
        return BatteryState{}, err
    }
    return provider.GetState()
}
```

And, **only if the capability runs a monitor loop**, the events forwarder plus
the `start()` / `stop()` hooks. With `monitor` embedded these are just the typed
glue — swap `Audio`→`Battery` and `audioEvents`→`batteryEvents`:

```go
type batteryEvents struct{ emit func(event string, data any) }
func (e batteryEvents) Changed(state BatteryState) { e.emit("changed", state) }

func (s *BatteryService) start() {
    provider, ok := Battery.Provider()
    if !ok { return }
    s.run("battery", func(ctx context.Context) error {
        return provider.Start(ctx, batteryEvents{emit: s.Emit})
    })
}

func (s *BatteryService) stop(ctx context.Context) error {
    provider, ok := Battery.Provider()
    if !ok { return nil }
    return s.stopWith(ctx, provider.Stop)
}
```

> A purely read-only capability with no events (no `Start`/`Stop`, no monitor)
> drops the `monitor` embed, the events forwarder, and the lifecycle hooks
> entirely — just Contract + Capability + delegating Service.

### Step 2 — `api.go` (wire it into the runtime)

**This is the step that actually exposes the capability — skip it and
`window.strux.battery` is undefined even though `api/battery.go` compiles.**
`api.go` has three labeled sections; add one line to each:

```go
// (1) under "Define New Extensions Here" — the accessor
func (rt *Runtime) Battery() *api.BatteryService { return &api.BatteryService{} }

// (2) under "BSPs Call these to register..." — the provider re-export
func RegisterBatteryProvider(provider BatteryContract) { api.RegisterBatteryProvider(provider) }

// (3) inside registerBuiltinExtensions() — the call that binds + starts the service
rt.registerStruxAPI(api.BatteryNamespace, rt.Battery())
```

The `registerStruxAPI` call is the one that matters at runtime: it reflects the
service onto `window.strux.battery`, wires its event emitter, runs `start()`, and
enrolls it for `Stop` on shutdown. The accessor and re-export are conveniences;
**(3) is what makes the capability live.**

### Step 3 — `runtime.go` (type aliases for BSPs)

Re-export the contract, DTOs, and events interface so BSPs import only
`struxruntime` (see §6):

```go
type BatteryContract = api.BatteryContract
type BatteryEvents   = api.BatteryEvents
type BatteryState    = api.BatteryState
const CapabilityBattery = api.CapabilityBattery
```

That's it — `strux.battery.*` is now a reflected API, `strux.capabilities` lists
it with its methods and events, and any BSP can register a provider.

---

## 6. Implementing a capability on a BSP

A BSP provides a board-specific implementation by:

1. Writing a `Provider` that satisfies the contract (e.g. `AudioContract`).
2. Registering it from `init()`.
3. Listing the package under `runtime.extensions` in `bsp.yaml`.

```go
// bsp/<board>/runtime/audio/audio.go
package audio

import (
    "context"

    struxruntime "github.com/strux-dev/strux/pkg/runtime"
)

type Provider struct{ /* board state */ }

func init() { struxruntime.RegisterAudioProvider(&Provider{}) }

func (p *Provider) GetState() (struxruntime.AudioState, error) { /* ... */ }
func (p *Provider) SetVolume(percent int) error               { /* ... */ }
// ...other operations...

func (p *Provider) Start(ctx context.Context, events struxruntime.AudioEvents) error {
    // setup; then monitor until ctx.Done(), calling events.Changed(state) on change
    return nil
}

func (p *Provider) Stop(ctx context.Context) error {
    // deadline-bounded teardown (e.g. mute amps)
    return nil
}

// Optional feature opt-in (§4): add the methods of an optional interface and the
// framework detects them automatically — no registration call. Omit them and the
// feature reports unavailable. Here the board has a jack, so it offers autoSwitch:
func (p *Provider) SetAutoSwitch(enabled bool) error { /* ... */ return nil }
func (p *Provider) AutoSwitch() (bool, error)        { /* ... */ return false, nil }
```

```yaml
# bsp/<board>/bsp.yaml
runtime:
  extensions:
    - path: runtime/audio
      implements: ["audio", "audio/autoSwitch"]   # what this package provides
      compatible_strux_api: ["0.4"]               # which Strux API versions it targets
```

### Extension config keys

Each entry under `runtime.extensions` takes:

| Key | Purpose |
|---|---|
| `path` *(or `import`)* | The Go package to compile in. `path` is relative to the BSP dir; `import` is an explicit module path. |
| `compatible_strux_api` | Strux API version key(s) (`"0.4"` or `["0.3", "0.4"]`). The extension is compiled in **only** when the runtime being built matches one of them, otherwise it is **skipped and logged**. Lets one BSP carry version-specific packages — e.g. `runtime/v0.3/audio` and `runtime/v0.4/audio` selected automatically. Omit to always include. |
| `implements` | What the extension provides, for build-time validation and tooling: `"<capability>"` / `"<capability>/<feature>"` (e.g. `"audio"`, `"audio/capture"`), or the reserved `"custom"` (used alone) for a custom extension. Two compiled-in extensions implementing the same capability is a build error (one provider per capability). Optional, but recommended. |

> `implements` is a declaration, not an enforcement — the build checks its
> *format* and uses it to catch capability collisions, but does not yet verify it
> against what the Go code actually registers. It's also a stable, machine-readable
> record of a board's capabilities (e.g. for a BSP catalog) that can be read
> straight from `bsp.yaml` without compiling.

A BSP only ever imports `struxruntime` (the runtime re-exports the DTOs,
contracts, and `Register…Provider` functions). It never imports
`pkg/runtime/api` directly, and never sees `Service`, `Emit`, or the event
transport.

A complete board example (RK809 codec + Awinic aw87xxx amps) lives in the
separate `test` module at `test/bsp/ht109-rk3576s/runtime/audio/audio.go`.

---

## File map

| File | Role |
|---|---|
| `api/main.go` | `DefineCapability`, `Capability[T]`, `providerOf`, `featureOf`, `InterfaceType`, `UnsupportedError`/`UnsupportedFeatureError`, `MethodSpec`, `EventSpec`, `FeatureSpec`, `CapabilitySpec`/`CapabilityInfo`/`FeatureInfo` |
| `api/service.go` | `Service` (per-service emitter), `monitor` (shared Start/Stop plumbing), `BindService`, `StartService`/`StopService` (lifecycle), reserved names |
| `api/network.go`, `api/wifi.go`, `api/display.go`, `api/audio.go` | the standard APIs (Contract + Capability + Service); audio also has `Start`/`Stop` |
| `api.go` | runtime accessors (`rt.Audio()`), built-in registration, `Register…Provider` re-exports |
| `runtime.go` | the IPC bridge, `registerStruxAPI` (binds + starts services), `rt.Stop()` shutdown orchestration, type re-exports for BSPs |
| `events.go` | `Emit` (app bus) and `emitSystem` (per-service channel) |
| `registry.go` | reflection of Go methods into frontend bindings |

> Naming note: the interfaces are `…Contract` (the obligations) and the BSP's
> implementing struct is conventionally `Provider`. The pre-rename names
> (`…Provider` interfaces) remain as deprecated aliases for compatibility.
