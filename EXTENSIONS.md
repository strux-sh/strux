# Strux Runtime Extensions

This guide covers three runtime API paths:

- Defining a new Strux-owned default API.
- Defining a custom BSP API.
- Filling in a Strux-owned API from a BSP provider.

Runtime APIs are exposed to JavaScript under `window.strux`. The TypeScript declarations are generated from Go source so the runtime shape, app Go APIs, and BSP APIs stay aligned.

## Runtime API Model

There are two kinds of runtime APIs.

**Strux-owned default APIs** are part of Strux itself. They live in `pkg/runtime/api` and are registered by the runtime. Examples are `strux.boot`, `strux.display`, and `strux.capabilities`.

**BSP custom APIs** are owned by a BSP. They are normal Go packages imported into the app build. They register themselves during package init and appear under `window.strux.<name>`.

Default APIs may also expose a **BSP provider hook**. In that case Strux owns the public API shape, but the BSP supplies hardware-specific behavior. `strux.display.GetBacklight` and `strux.display.SetBacklight` use this pattern.

## Defining A New Default API

Default APIs are Strux source changes. Add one file under `pkg/runtime/api`, for example `pkg/runtime/api/device.go`.

The file should define:

- A namespace constant named `<Name>Namespace`.
- Optional data structs used by API methods.
- Optional provider interface and capability metadata.
- A `<Name>Service` type with exported methods.

Example:

```go
package api

const (
	DeviceNamespace = "device"

	CapabilityDevice = "device"
)

type DeviceInfo struct {
	Model  string `json:"model"`
	Serial string `json:"serial"`
}

type DeviceProvider interface {
	Info() (DeviceInfo, error)
}

var Device = DefineCapability[DeviceProvider](CapabilitySpec{
	Name:        CapabilityDevice,
	Namespace:   DeviceNamespace,
	Description: "BSP-provided device identity.",
	Methods: []MethodSpec{
		{Name: "Info", Description: "Returns device identity data."},
	},
})

func RegisterDeviceProvider(provider DeviceProvider) {
	Device.RegisterOrPanic(provider)
}

type DeviceService struct{}

func (DeviceService) Info() (DeviceInfo, error) {
	provider, ok := Device.Provider()
	if !ok {
		return DeviceInfo{}, UnsupportedError{Capability: CapabilityDevice}
	}
	return provider.Info()
}
```

Then register the service in `Runtime.registerBuiltinExtensions()`:

```go
rt.registerStruxAPI(api.DeviceNamespace, rt.Device())
```

Add the runtime accessor:

```go
func (rt *Runtime) Device() *api.DeviceService {
	return &api.DeviceService{}
}
```

If the API has a BSP provider hook, re-export the provider contract from `pkg/runtime/runtime.go` or `pkg/runtime/api.go` as needed:

```go
const CapabilityDevice = api.CapabilityDevice

type DeviceProvider = api.DeviceProvider

func RegisterDeviceProvider(provider DeviceProvider) {
	api.RegisterDeviceProvider(provider)
}
```

Finally regenerate the bundled runtime API metadata:

```sh
bun run generate:types
```

That updates `src/types/strux-runtime.ts`. The generated file contains JSON metadata, not final app declarations. Final app declarations are produced later by `strux-introspect`.

## Defining A Custom BSP API

Use a custom BSP API when the method is specific to one board, one product family, or one hardware integration that Strux should not standardize yet.

Create a Go package in the BSP. A common layout is:

```txt
bsp/rpi5/runtime/gpio/gpio.go
```

Example:

```go
package gpio

import struxruntime "github.com/strux-dev/strux/pkg/runtime"

type GPIO struct{}

func init() {
	struxruntime.RegisterCustomExtension("gpio", &GPIO{})
}

func (g *GPIO) Write(pin int, value bool) error {
	// board-specific implementation
	return nil
}

func (g *GPIO) Read(pin int) (bool, error) {
	// board-specific implementation
	return false, nil
}
```

Add the runtime package to the BSP config:

```yaml
bsp:
  runtime:
    extensions:
      - path: runtime/gpio
```

Relative `path` values are resolved from the BSP directory. If the package is outside the app module, provide an explicit import path:

```yaml
bsp:
  runtime:
    extensions:
      - path: /absolute/path/to/gpio
        import: example.com/acme/bsp/runtime/gpio
```

Strux uses this entry for two things:

- It generates `strux_bsp_runtime_extensions.go` with a blank import so the package `init()` runs in the app binary.
- It passes the local package directory to `strux-introspect main.go --runtime-dts ...` so the frontend gets types for `strux.gpio`.

The generated frontend type will look like:

```ts
strux.gpio.Write(pin: number, value: boolean): Promise<void>
strux.gpio.Read(pin: number): Promise<boolean | null>
```

## Filling In A Default API From A BSP

Use a provider when Strux owns the public API, but the BSP owns the hardware implementation.

For the current display provider contract:

```go
type DisplayProvider interface {
	GetBacklight(displayName string) (int, error)
	SetBacklight(displayName string, value int) error
}
```

A BSP implementation can live in a runtime package:

```go
package display

import struxruntime "github.com/strux-dev/strux/pkg/runtime"

type Display struct{}

func init() {
	struxruntime.RegisterDisplayProvider(&Display{})
}

func (d *Display) GetBacklight(displayName string) (int, error) {
	// read from sysfs, ioctl, vendor tool, etc.
	return 100, nil
}

func (d *Display) SetBacklight(displayName string, value int) error {
	// validate/apply board-specific backlight level
	return nil
}
```

Add it to `bsp.yaml`:

```yaml
bsp:
  runtime:
    extensions:
      - path: runtime/display
```

The JavaScript API already exists because Strux owns `strux.display`:

```ts
await strux.display.SetBacklight("eDP-1", 80)
const value = await strux.display.GetBacklight("eDP-1")
```

If no BSP provider is registered, provider-backed methods return an unsupported capability error from Go. Apps can inspect support at runtime:

```ts
const supported = await strux.capabilities.Supports("display")
const capabilities = await strux.capabilities.List()
```

The same API is available to Go code through the runtime object:

```go
rt, err := runtime.Init(app)
if err != nil {
	return err
}

value, err := rt.Display().GetBacklight("eDP-1")
```

## Type Generation Flow

The final `frontend/src/strux.d.ts` is produced by `strux-introspect`, not by importing Strux source during app builds.

The flow is:

```txt
Strux development:
  cmd/gen-runtime-types parses pkg/runtime/api
  -> src/types/strux-runtime.ts contains built-in runtime JSON

App build / strux types:
  TypeScript CLI passes built-in runtime JSON to strux-introspect
  strux-introspect parses main.go
  strux-introspect parses local BSP runtime package dirs
  strux-introspect writes the complete .d.ts
```

This keeps installed Strux builds independent from the Strux source tree. Local BSP APIs only require local BSP source paths listed in `bsp.yaml`.

## Compatibility

BSPs can declare the Strux API versions they were checked against:

```yaml
bsp:
  runtime:
    compatible_strux_api:
      - "0.3"
      - "0.4"
```

This is a BSP authoring signal. If a Strux default API changes in a breaking way, provider interfaces such as `DisplayProvider` will also fail at Go compile time when the BSP no longer satisfies the Strux-owned contract.

## Practical Rules

- Put Strux-owned APIs in `pkg/runtime/api`.
- Put custom BSP APIs in BSP runtime packages and register them with `RegisterCustomExtension`.
- Use provider registration only when Strux owns the API shape.
- Keep custom BSP method parameters and return values JSON-friendly.
- Export every method that should be callable from JavaScript.
- Add BSP runtime packages to `bsp.yaml` so they are both imported into the app binary and included in generated TypeScript types.
