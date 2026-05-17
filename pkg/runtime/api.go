package runtime

import "github.com/strux-dev/strux/pkg/runtime/api"

// RegisterCustomExtension registers a process-wide custom BSP extension under window.strux.<name>.
// It panics on invalid or duplicate registrations because it is intended for BSP init() functions.
func RegisterCustomExtension(name string, instance interface{}) {
	if err := RegisterExtension("strux", name, instance); err != nil {
		panic(err)
	}
}

// RegisterDisplayProvider registers the active BSP implementation for strux.display.
// It panics on invalid or duplicate registrations because it is intended for BSP init() functions.
func RegisterDisplayProvider(provider DisplayProvider) {
	api.RegisterDisplayProvider(provider)
}
