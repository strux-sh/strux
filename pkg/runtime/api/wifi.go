package api

import (
	"fmt"
	"regexp"
	"strings"
)

const (
	WiFiNamespace = "wifi"

	// CapabilityWiFi is implemented by BSPs that provide Wi-Fi management.
	CapabilityWiFi = "wifi"
)

// WiFiDefaultInterface identifies the preferred Wi-Fi adapter for simple apps.
type WiFiDefaultInterface struct {
	Found         bool   `json:"found"`
	InterfaceName string `json:"interfaceName"`
}

// WiFiInterface describes one Wi-Fi-capable network interface.
type WiFiInterface struct {
	Name            string `json:"name"`
	HardwareAddress string `json:"hardwareAddress"`
	Driver          string `json:"driver"`
	State           string `json:"state"`
	Managed         bool   `json:"managed"`
	SupportsScan    bool   `json:"supportsScan"`
	SupportsAPMode  bool   `json:"supportsAPMode"`
	Supports5GHz    bool   `json:"supports5GHz"`
	Supports6GHz    bool   `json:"supports6GHz"`
}

// WiFiNetwork is one scanned access point.
type WiFiNetwork struct {
	InterfaceName  string `json:"interfaceName"`
	SSID           string `json:"ssid"`
	BSSID          string `json:"bssid"`
	SignalStrength int    `json:"signalStrength"`
	Security       string `json:"security"`
	Channel        int    `json:"channel"`
	IsKnown        bool   `json:"isKnown"`
}

// WiFiIPConfig describes IPv4 settings reported or requested for a Wi-Fi interface.
type WiFiIPConfig struct {
	Mode    string   `json:"mode"`
	Address string   `json:"address"`
	Gateway string   `json:"gateway"`
	Subnet  string   `json:"subnet"`
	DNS     []string `json:"dns"`
}

// WiFiStatus describes the current connection state for one Wi-Fi interface.
type WiFiStatus struct {
	InterfaceName   string       `json:"interfaceName"`
	Connected       bool         `json:"connected"`
	SSID            string       `json:"ssid"`
	BSSID           string       `json:"bssid"`
	SignalStrength  int          `json:"signalStrength"`
	Security        string       `json:"security"`
	HardwareAddress string       `json:"hardwareAddress"`
	IP              WiFiIPConfig `json:"ip"`
}

// WiFiKnownNetwork is a saved Wi-Fi profile.
type WiFiKnownNetwork struct {
	ID            string `json:"id"`
	SSID          string `json:"ssid"`
	InterfaceName string `json:"interfaceName"`
	Priority      int    `json:"priority"`
	AutoConnect   bool   `json:"autoConnect"`
}

// WiFiConnectRequest creates or activates a Wi-Fi connection on one interface.
type WiFiConnectRequest struct {
	InterfaceName string `json:"interfaceName"`
	SSID          string `json:"ssid"`
	Password      string `json:"password"`
	BSSID         string `json:"bssid"`
}

// WiFiKnownNetworkRequest activates a saved Wi-Fi profile on one interface.
type WiFiKnownNetworkRequest struct {
	InterfaceName string `json:"interfaceName"`
	ID            string `json:"id"`
}

// WiFiIPConfigRequest applies IP configuration to the active connection for one interface.
type WiFiIPConfigRequest struct {
	InterfaceName string       `json:"interfaceName"`
	Config        WiFiIPConfig `json:"config"`
}

// WiFiContract supplies BSP-specific Wi-Fi management.
type WiFiContract interface {
	ListInterfaces() ([]WiFiInterface, error)
	GetDefaultInterface() (WiFiDefaultInterface, error)
	GetStatus(interfaceName string) (WiFiStatus, error)
	Scan(interfaceName string) ([]WiFiNetwork, error)
	Connect(req WiFiConnectRequest) error
	ConnectKnown(req WiFiKnownNetworkRequest) error
	Disconnect(interfaceName string) error
	ListKnownNetworks() ([]WiFiKnownNetwork, error)
	Forget(id string) error
	SetKnownNetworkPriority(id string, priority int) error
	ConfigureIP(req WiFiIPConfigRequest) error
}

var WiFi = DefineCapability[WiFiContract](CapabilitySpec{
	Name:        CapabilityWiFi,
	Namespace:   WiFiNamespace,
	Description: "BSP Wi-Fi integration with multi-adapter scanning, connection management, saved profiles, and IP configuration.",
	Methods: []MethodSpec{
		{Name: "ListInterfaces", Description: "Returns every Wi-Fi-capable network interface exposed by the BSP."},
		{Name: "GetDefaultInterface", Description: "Returns the preferred Wi-Fi interface for apps that do not need explicit adapter selection."},
		{Name: "GetStatus", Description: "Returns connection and IP state for one Wi-Fi interface."},
		{Name: "Scan", Description: "Scans for nearby access points on one Wi-Fi interface."},
		{Name: "Connect", Description: "Connects one Wi-Fi interface to an SSID, optionally using a password and BSSID."},
		{Name: "ConnectKnown", Description: "Activates a saved Wi-Fi profile on one Wi-Fi interface."},
		{Name: "Disconnect", Description: "Disconnects one Wi-Fi interface."},
		{Name: "ListKnownNetworks", Description: "Returns saved Wi-Fi connection profiles."},
		{Name: "Forget", Description: "Deletes one saved Wi-Fi connection profile by stable ID."},
		{Name: "SetKnownNetworkPriority", Description: "Sets saved profile autoconnect priority."},
		{Name: "ConfigureIP", Description: "Applies DHCP or static IPv4 settings to the active connection for one Wi-Fi interface."},
	},
})

var validNetworkInterfaceName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$`)

func RegisterWiFiProvider(provider WiFiContract) {
	WiFi.RegisterOrPanic(provider)
}

// WiFiService exposes Strux-standard Wi-Fi tooling to kiosk apps through the IPC bridge.
type WiFiService struct{}

// Compile-time guarantee that the service mirrors the contract: add a method to
// WiFiContract and forget it here → the build fails.
var _ WiFiContract = WiFiService{}

func (WiFiService) ListInterfaces() ([]WiFiInterface, error) {
	provider, err := providerOf(WiFi)
	if err != nil {
		return nil, err
	}
	return provider.ListInterfaces()
}

func (WiFiService) GetDefaultInterface() (WiFiDefaultInterface, error) {
	provider, err := providerOf(WiFi)
	if err != nil {
		return WiFiDefaultInterface{}, err
	}
	return provider.GetDefaultInterface()
}

func (WiFiService) GetStatus(interfaceName string) (WiFiStatus, error) {
	if err := validateWiFiInterfaceName(interfaceName); err != nil {
		return WiFiStatus{}, err
	}

	provider, err := providerOf(WiFi)
	if err != nil {
		return WiFiStatus{}, err
	}
	return provider.GetStatus(interfaceName)
}

func (WiFiService) Scan(interfaceName string) ([]WiFiNetwork, error) {
	if err := validateWiFiInterfaceName(interfaceName); err != nil {
		return nil, err
	}

	provider, err := providerOf(WiFi)
	if err != nil {
		return nil, err
	}
	return provider.Scan(interfaceName)
}

func (WiFiService) Connect(req WiFiConnectRequest) error {
	if err := validateWiFiConnectRequest(req); err != nil {
		return err
	}

	provider, err := providerOf(WiFi)
	if err != nil {
		return err
	}
	return provider.Connect(req)
}

func (WiFiService) ConnectKnown(req WiFiKnownNetworkRequest) error {
	if err := validateWiFiInterfaceName(req.InterfaceName); err != nil {
		return err
	}
	if err := validateWiFiProfileID(req.ID); err != nil {
		return err
	}

	provider, err := providerOf(WiFi)
	if err != nil {
		return err
	}
	return provider.ConnectKnown(req)
}

func (WiFiService) Disconnect(interfaceName string) error {
	if err := validateWiFiInterfaceName(interfaceName); err != nil {
		return err
	}

	provider, err := providerOf(WiFi)
	if err != nil {
		return err
	}
	return provider.Disconnect(interfaceName)
}

func (WiFiService) ListKnownNetworks() ([]WiFiKnownNetwork, error) {
	provider, err := providerOf(WiFi)
	if err != nil {
		return nil, err
	}
	return provider.ListKnownNetworks()
}

func (WiFiService) Forget(id string) error {
	if err := validateWiFiProfileID(id); err != nil {
		return err
	}

	provider, err := providerOf(WiFi)
	if err != nil {
		return err
	}
	return provider.Forget(id)
}

func (WiFiService) SetKnownNetworkPriority(id string, priority int) error {
	if err := validateWiFiProfileID(id); err != nil {
		return err
	}

	provider, err := providerOf(WiFi)
	if err != nil {
		return err
	}
	return provider.SetKnownNetworkPriority(id, priority)
}

func (WiFiService) ConfigureIP(req WiFiIPConfigRequest) error {
	if err := validateWiFiInterfaceName(req.InterfaceName); err != nil {
		return err
	}
	if req.Config.Mode != "dhcp" && req.Config.Mode != "static" {
		return fmt.Errorf("wifi IP mode must be dhcp or static")
	}
	if req.Config.Mode == "static" && req.Config.Address == "" {
		return fmt.Errorf("static wifi IP address is required")
	}

	provider, err := providerOf(WiFi)
	if err != nil {
		return err
	}
	return provider.ConfigureIP(req)
}

func validateWiFiConnectRequest(req WiFiConnectRequest) error {
	if err := validateWiFiInterfaceName(req.InterfaceName); err != nil {
		return err
	}
	if req.SSID == "" {
		return fmt.Errorf("wifi SSID is empty")
	}
	if strings.ContainsRune(req.SSID, '\x00') {
		return fmt.Errorf("wifi SSID contains a NUL byte")
	}
	if strings.ContainsRune(req.Password, '\x00') {
		return fmt.Errorf("wifi password contains a NUL byte")
	}
	if strings.ContainsRune(req.BSSID, '\x00') {
		return fmt.Errorf("wifi BSSID contains a NUL byte")
	}
	return nil
}

func validateWiFiInterfaceName(interfaceName string) error {
	return validateNetworkInterfaceName(interfaceName)
}

func validateNetworkInterfaceName(interfaceName string) error {
	if interfaceName == "" {
		return fmt.Errorf("network interface name is empty")
	}
	if !validNetworkInterfaceName.MatchString(interfaceName) {
		return fmt.Errorf("invalid network interface name %q", interfaceName)
	}
	return nil
}

func validateWiFiProfileID(id string) error {
	if id == "" {
		return fmt.Errorf("known network id is empty")
	}
	if strings.ContainsRune(id, '\x00') {
		return fmt.Errorf("known network id contains a NUL byte")
	}
	return nil
}
