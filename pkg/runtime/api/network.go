package api

import (
	"fmt"
	"net"
)

const (
	NetworkNamespace = "network"

	// CapabilityNetwork is implemented by BSPs that provide generic network interface management.
	CapabilityNetwork = "network"
)

// NetworkDefaultInterface identifies the preferred network adapter for a kind.
type NetworkDefaultInterface struct {
	Found         bool   `json:"found"`
	InterfaceName string `json:"interfaceName"`
}

// NetworkInterface describes one managed network interface.
type NetworkInterface struct {
	Name              string `json:"name"`
	Kind              string `json:"kind"`
	HardwareAddress   string `json:"hardwareAddress"`
	Driver            string `json:"driver"`
	State             string `json:"state"`
	Managed           bool   `json:"managed"`
	Enabled           bool   `json:"enabled"`
	Connected         bool   `json:"connected"`
	LinkDetected      bool   `json:"linkDetected"`
	SpeedMbps         int    `json:"speedMbps"`
	Duplex            string `json:"duplex"`
	SupportsWakeOnLAN bool   `json:"supportsWakeOnLAN"`
}

// NetworkIPConfig describes IPv4 settings reported or requested for a network interface.
type NetworkIPConfig struct {
	Mode    string   `json:"mode"`
	Address string   `json:"address"`
	Gateway string   `json:"gateway"`
	Subnet  string   `json:"subnet"`
	DNS     []string `json:"dns"`
}

// NetworkStatus describes current network and IP state for one interface.
type NetworkStatus struct {
	InterfaceName   string          `json:"interfaceName"`
	Kind            string          `json:"kind"`
	Connected       bool            `json:"connected"`
	LinkDetected    bool            `json:"linkDetected"`
	HardwareAddress string          `json:"hardwareAddress"`
	SpeedMbps       int             `json:"speedMbps"`
	Duplex          string          `json:"duplex"`
	IP              NetworkIPConfig `json:"ip"`
}

// NetworkIPConfigRequest applies IP configuration to one interface.
type NetworkIPConfigRequest struct {
	InterfaceName string          `json:"interfaceName"`
	Config        NetworkIPConfig `json:"config"`
}

// NetworkContract supplies BSP-specific generic network interface management.
type NetworkContract interface {
	ListInterfaces() ([]NetworkInterface, error)
	GetDefaultInterface(kind string) (NetworkDefaultInterface, error)
	GetStatus(interfaceName string) (NetworkStatus, error)
	ConfigureIP(req NetworkIPConfigRequest) error
	SetEnabled(interfaceName string, enabled bool) error
	RenewDHCP(interfaceName string) error
}

var Network = DefineCapability[NetworkContract](CapabilitySpec{
	Name:        CapabilityNetwork,
	Namespace:   NetworkNamespace,
	Description: "BSP network interface integration with link status, DHCP/static IPv4 configuration, and interface controls.",
	Methods: []MethodSpec{
		{Name: "ListInterfaces", Description: "Returns every managed network interface exposed by the BSP."},
		{Name: "GetDefaultInterface", Description: "Returns the preferred interface for the requested kind, or any kind when empty."},
		{Name: "GetStatus", Description: "Returns link and IP state for one network interface."},
		{Name: "ConfigureIP", Description: "Applies DHCP, static, or disabled IPv4 settings to one network interface."},
		{Name: "SetEnabled", Description: "Enables or disables one network interface."},
		{Name: "RenewDHCP", Description: "Renews DHCP configuration for one network interface."},
	},
})

func RegisterNetworkProvider(provider NetworkContract) {
	Network.RegisterOrPanic(provider)
}

// NetworkService exposes Strux-standard network tooling to kiosk apps through the IPC bridge.

// These are the methods that are called directly by the frontend or the runtime.
type NetworkService struct{}

// Compile-time guarantee that the service mirrors the contract: add a method to
// NetworkContract and forget it here → the build fails.
var _ NetworkContract = NetworkService{}

func (NetworkService) ListInterfaces() ([]NetworkInterface, error) {
	provider, err := providerOf(Network)
	if err != nil {
		return nil, err
	}
	return provider.ListInterfaces()
}

func (NetworkService) GetDefaultInterface(kind string) (NetworkDefaultInterface, error) {
	if err := validateNetworkKind(kind); err != nil {
		return NetworkDefaultInterface{}, err
	}

	provider, err := providerOf(Network)
	if err != nil {
		return NetworkDefaultInterface{}, err
	}
	return provider.GetDefaultInterface(kind)
}

func (NetworkService) GetStatus(interfaceName string) (NetworkStatus, error) {
	if err := validateNetworkInterfaceName(interfaceName); err != nil {
		return NetworkStatus{}, err
	}

	provider, err := providerOf(Network)
	if err != nil {
		return NetworkStatus{}, err
	}
	return provider.GetStatus(interfaceName)
}

func (NetworkService) ConfigureIP(req NetworkIPConfigRequest) error {
	if err := validateNetworkInterfaceName(req.InterfaceName); err != nil {
		return err
	}
	if err := validateNetworkIPConfig(req.Config); err != nil {
		return err
	}

	provider, err := providerOf(Network)
	if err != nil {
		return err
	}
	return provider.ConfigureIP(req)
}

func (NetworkService) SetEnabled(interfaceName string, enabled bool) error {
	if err := validateNetworkInterfaceName(interfaceName); err != nil {
		return err
	}

	provider, err := providerOf(Network)
	if err != nil {
		return err
	}
	return provider.SetEnabled(interfaceName, enabled)
}

func (NetworkService) RenewDHCP(interfaceName string) error {
	if err := validateNetworkInterfaceName(interfaceName); err != nil {
		return err
	}

	provider, err := providerOf(Network)
	if err != nil {
		return err
	}
	return provider.RenewDHCP(interfaceName)
}

func validateNetworkKind(kind string) error {
	switch kind {
	case "", "ethernet", "wifi", "cellular", "usb", "loopback", "unknown":
		return nil
	default:
		return fmt.Errorf("invalid network interface kind %q", kind)
	}
}

func validateNetworkIPConfig(config NetworkIPConfig) error {
	switch config.Mode {
	case "dhcp", "disabled":
		return nil
	case "static":
	default:
		return fmt.Errorf("network IP mode must be dhcp, static, or disabled")
	}

	if net.ParseIP(config.Address).To4() == nil {
		return fmt.Errorf("invalid static IPv4 address %q", config.Address)
	}
	if config.Gateway != "" && net.ParseIP(config.Gateway).To4() == nil {
		return fmt.Errorf("invalid static IPv4 gateway %q", config.Gateway)
	}
	if config.Subnet != "" && net.ParseIP(config.Subnet).To4() == nil {
		return fmt.Errorf("invalid static IPv4 subnet %q", config.Subnet)
	}
	for _, dns := range config.DNS {
		if net.ParseIP(dns).To4() == nil {
			return fmt.Errorf("invalid static IPv4 DNS server %q", dns)
		}
	}

	return nil
}
