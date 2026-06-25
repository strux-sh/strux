# Runtime Extensions

A runtime extension is a Go package inside your BSP that gives the Strux runtime board-specific hardware control — backlight, network management, Wi-Fi, or anything custom to your board. This page shows you how to write one, declare it in `bsp.yaml`, and call it from both Go and the frontend, with fully typed JavaScript bindings generated for free.

## When you need one

The Strux runtime ships a set of standard APIs under `window.strux.*` (display, network, Wi-Fi, boot, update, and more — see the [Go Runtime reference](/reference/go-runtime.md)). Some of those APIs can't work generically: how you set a backlight or manage Wi-Fi depends on the board and on what's installed in the image. That's where runtime extensions come in. There are two kinds:

1. **A provider for a Strux standard capability.** Strux owns the API shape (`strux.wifi.Scan(...)`, `strux.display.SetBacklight(...)`); your BSP supplies the hardware implementation by satisfying a Go interface. Apps written against the standard API work on every BSP that provides it.
2. **A custom BSP API.** For hardware Strux doesn't standardize (GPIO, a vendor sensor, a relay board), your BSP registers its own namespace under `window.strux.<name>` with whatever methods it wants.

The standard capabilities a BSP can provide today:

| Capability | Go interface | What you implement |
|---|---|---|
| `display` | `runtime.DisplayProvider` | `GetBacklight`, `SetBacklight`. Everything else on `strux.display` (modes, layout, rotation) is implemented by the runtime itself. |
| `network` | `runtime.NetworkProvider` | `ListInterfaces`, `GetDefaultInterface`, `GetStatus`, `ConfigureIP`, `SetEnabled`, `RenewDHCP` |
| `wifi` | `runtime.WiFiProvider` | `ListInterfaces`, `GetDefaultInterface`, `GetStatus`, `Scan`, `Connect`, `ConnectKnown`, `Disconnect`, `ListKnownNetworks`, `Forget`, `SetKnownNetworkPriority`, `ConfigureIP` |

If a capability has no registered provider, its methods return a "capability not supported by the active BSP" error — apps can check support at runtime instead of crashing (see [step 5](#_5-call-it-from-the-app-and-the-frontend)).

## 1. Write the provider package

By convention, extension packages live in a `runtime/` folder inside the BSP, one package per capability:

```txt
bsp/my-board/
├── bsp.yaml
└── runtime/
    ├── network/
    │   └── network.go
    └── wifi/
        └── wifi.go
```

The package registers its provider in `init()`. This example is trimmed from a real Wi-Fi provider (`test/bsp/ht109-rk3576s/runtime/wifi/wifi.go` in the Strux repository) that drives NetworkManager's `nmcli`:

```go
package wifi

import (
	"os/exec"
	"strings"

	struxruntime "github.com/strux-dev/strux/pkg/runtime"
)

type Provider struct{}

func init() {
	struxruntime.RegisterWiFiProvider(&Provider{})
}

func (p *Provider) ListInterfaces() ([]struxruntime.WiFiInterface, error) {
	out, err := exec.Command("nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status").Output()
	if err != nil {
		return nil, err
	}

	var interfaces []struxruntime.WiFiInterface
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		fields := strings.Split(line, ":")
		if len(fields) < 3 || fields[1] != "wifi" {
			continue
		}
		interfaces = append(interfaces, struxruntime.WiFiInterface{
			Name:         fields[0],
			State:        fields[2],
			Managed:      fields[2] != "unmanaged",
			SupportsScan: true,
		})
	}
	return interfaces, nil
}

// ...implement the remaining WiFiProvider methods the same way.
// The interface requires all eleven; the compiler will tell you
// which ones are missing.
```

A few things to notice:

- The data types (`WiFiInterface`, `WiFiStatus`, `NetworkIPConfig`, ...) are defined by Strux and re-exported from `github.com/strux-dev/strux/pkg/runtime`, so your provider and every app speak the same shapes.
- Registration happens in `init()`. The build wires your package into the app binary (see [step 4](#_4-how-it-gets-compiled-into-the-app)), so `init()` runs at process start — before the runtime is created.
- Registering the same capability twice panics at startup. One provider per capability, per image.
- If the board needs extra software for the provider to work (this example needs NetworkManager), add it to `bsp.rootfs.packages` in `bsp.yaml`.

### Custom BSP APIs

For board-specific methods that don't fit a standard capability, register a custom extension instead:

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

This appears in the frontend as `strux.gpio.Write(...)` and `strux.gpio.Read(...)`. Every exported method becomes callable from JavaScript; keep parameters and return values JSON-friendly (strings, numbers, booleans, slices, maps, structs), and return an `error` as the last return value to reject the JavaScript promise.

## 2. Declare it in bsp.yaml

Add the packages under `bsp.runtime.extensions`:

```yaml
bsp:
  runtime:
    extensions:
      - path: runtime/network
      - path: runtime/wifi
```

Each entry takes `path`, `import`, or both:

| Key | Type | Description |
|---|---|---|
| `path` | string | Local path to the Go package. Relative paths resolve from the BSP directory (`bsp/<name>/`). |
| `import` | string | Explicit Go import path. Optional for packages inside the project — Strux derives it from the `module` line in your project's `go.mod`. Required when `path` points outside the project, or when the package comes from a Go module dependency with no local path at all. |

## 3. Declare API compatibility

A BSP can record which Strux runtime API versions it was written against:

```yaml
bsp:
  runtime:
    compatible_strux_api:
      - "0.3"
```

`compatible_strux_api` accepts a single string or a list. When it is set, Strux reads the `github.com/strux-dev/strux` version from the project's `go.mod`, reduces it to `major.minor` (for example `0.3`), and aborts the build with a clear message if that key isn't in the list. When the key is omitted, no check runs. This protects users from silently building a project against a BSP that was never tested with their runtime version — and since providers are ordinary Go interfaces, a genuinely breaking API change also fails at compile time.

## 4. How it gets compiled into the app

You never import the extension packages yourself. When you run `strux build` (or `strux types`), the CLI:

1. Reads `bsp.runtime.extensions` for the selected BSP and resolves each entry to a Go import path.
2. Writes `strux_bsp_runtime_extensions.go` at the project root — a generated file containing only blank imports:

```go
// Code generated by Strux; DO NOT EDIT.

package main

import (
	_ "my-kiosk/bsp/my-board/runtime/network"
	_ "my-kiosk/bsp/my-board/runtime/wifi"
)
```

3. Compiles `main.go` as usual. The blank imports pull your packages into the binary, so their `init()` registrations run at startup.

The file is regenerated whenever the frontend or application build steps run for the active BSP (and deleted when the BSP declares no extensions), which is how switching BSPs swaps hardware implementations without touching your app code. The project template gitignores it — don't edit or commit it. The build cache tracks `bsp/<name>/runtime/` and the `bsp.runtime.extensions` key, so editing an extension or the YAML re-runs the application step automatically.

## 5. Call it from the app and the frontend

Frontend code calls the API like any other Strux binding — `strux build` and `strux types` regenerate `frontend/src/strux.d.ts`, including types for your custom extension packages:

```ts
// Standard capability, implemented by your provider:
const networks = await strux.wifi.Scan("wlan0")
await strux.display.SetBacklight("DSI-1", 80)

// Custom BSP API:
await strux.gpio.Write(17, true)
```

Apps that must run on multiple BSPs can check support before calling:

```ts
if (await strux.capabilities.Supports("wifi")) {
    const networks = await strux.wifi.Scan("wlan0")
}
const all = await strux.capabilities.List()
```

The same services are available to Go code through the runtime object your `main.go` already creates:

```go
rt, err := runtime.Init(app)
if err != nil {
    log.Fatal(err)
}

value, err := rt.Display().GetBacklight("DSI-1")
```

## Where to go next

- [The Extension System](/bsp/concepts/extension-system.md) — how registration, the capability registry, and type generation work under the hood.
- [bsp.yaml Reference](/bsp/reference/bsp-yaml.md) — every key, including `runtime.extensions` and `compatible_strux_api`.
- [Writing a BSP](/bsp/guide/writing-a-bsp.md) — the full BSP walkthrough this page slots into.
- [Backend guide](/guide/backend.md) — how app-level Go methods (as opposed to BSP extensions) are exposed to the frontend.
