package runtime

import (
	"github.com/strux-dev/strux/pkg/runtime/api"
)

// ----------------------------------------------------------------------------
// Define New Extensions Here ------------------------------------------------
// ----------------------------------------------------------------------------
// Boot returns Strux-owned boot and system management APIs.
func (rt *Runtime) Boot() *api.BootService {
	return &api.BootService{}
}

// Display returns Strux-owned display APIs backed by the active BSP.
func (rt *Runtime) Display() *api.DisplayService {
	return &api.DisplayService{}
}

// Dev returns Strux-owned dev-mode control APIs.
func (rt *Runtime) Dev() *api.DevService {
	return &api.DevService{}
}

// Network returns Strux-owned generic network APIs backed by the active BSP.
func (rt *Runtime) Network() *api.NetworkService {
	return &api.NetworkService{}
}

// Project returns Strux project image metadata APIs.
func (rt *Runtime) Project() *api.ProjectService {
	return &api.ProjectService{}
}

// System returns Strux-owned device and system information APIs.
func (rt *Runtime) System() *api.SystemService {
	return &api.SystemService{}
}

// Update returns Strux-owned system update state APIs.
func (rt *Runtime) Update() *api.UpdateService {
	return &api.UpdateService{}
}

// WiFi returns Strux-owned Wi-Fi APIs backed by the active BSP.
func (rt *Runtime) WiFi() *api.WiFiService {
	return &api.WiFiService{}
}

// Audio returns Strux-owned audio APIs backed by the active BSP.
func (rt *Runtime) Audio() *api.AudioService {
	return &api.AudioService{}
}

// Capabilities returns Strux-owned capabilities APIs backed by the active BSP.
func (rt *Runtime) Capabilities() *api.CapabilitiesService {
	return &api.CapabilitiesService{}
}

//----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// BSPs Call these to register their implementation of a Strux standard API capability.
// ----------------------------------------------------------------------------
func RegisterDisplayProvider(provider DisplayContract) {
	api.RegisterDisplayProvider(provider)
}

func RegisterNetworkProvider(provider NetworkContract) {
	api.RegisterNetworkProvider(provider)
}

func RegisterWiFiProvider(provider WiFiContract) {
	api.RegisterWiFiProvider(provider)
}

func RegisterAudioProvider(provider AudioContract) {
	api.RegisterAudioProvider(provider)
}

// ----------------------------------------------------------------------------

// registerBuiltinExtensions registers all built-in Strux framework extensions
func (rt *Runtime) registerBuiltinExtensions() {

	// Define New Extensions Here ------------------------------------------------
	rt.registerStruxAPI(api.BootNamespace, rt.Boot())
	rt.registerStruxAPI(api.DevNamespace, rt.Dev())
	rt.registerStruxAPI(api.DisplayNamespace, rt.Display())
	rt.registerStruxAPI(api.NetworkNamespace, rt.Network())
	rt.registerStruxAPI(api.ProjectNamespace, rt.Project())
	rt.registerStruxAPI(api.SystemNamespace, rt.System())
	rt.registerStruxAPI(api.UpdateNamespace, rt.Update())
	rt.registerStruxAPI(api.WiFiNamespace, rt.WiFi())
	rt.registerStruxAPI(api.AudioNamespace, rt.Audio())
	rt.registerStruxAPI(api.CapabilitiesNamespace, rt.Capabilities())

	// ----------------------------------------------------------------------------

	// DO NOT REMOVE ------------------------------------------------------------
	// Replay custom BSP extension registrations captured from package init() hooks.
	rt.registerProcessExtensions()
	// ----------------------------------------------------------------------------
}
