//
// Strux Client - USB Ethernet
//
// Creates a Linux USB Ethernet gadget for dev mode and serves a tiny DHCP
// responder so the host can get a deterministic point-to-point address.
//

package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/insomniacslk/dhcp/dhcpv4"
	"github.com/insomniacslk/dhcp/dhcpv4/server4"
)

const (
	configFSRoot     = "/sys/kernel/config"
	usbGadgetRoot    = "/sys/kernel/config/usb_gadget"
	usbVendorID      = "0x1209"
	usbProductID     = "0x5358"
	usbManufacturer  = "Strux"
	usbProduct       = "Strux USB Debug"
	usbSerialNumber  = "strux-dev"
	usbGadgetName    = "strux"
	usbConfigName    = "c.1"
	usbFunction      = "ecm"
	usbInterface     = "usb0"
	defaultUSBSubnet = "192.168.7.0/24"
	usbDeviceMAC     = "02:53:74:72:75:78"
	usbHostMAC       = "02:53:74:72:75:79"
	usbLeaseSeconds  = 3600
	dhcpServerPort   = 67
)

type usbNetConfig struct {
	VendorID     string
	ProductID    string
	Manufacturer string
	Product      string
	SerialNumber string
	GadgetName   string
	ConfigName   string
	Function     string
	Interface    string
	DeviceIP     string
	HostIP       string
	PrefixLength int
	DeviceMAC    string
	HostMAC      string
	LeaseSeconds int
}

type USBNetManager struct {
	logger *Logger
}

func NewUSBNetManager() *USBNetManager {
	return &USBNetManager{logger: NewLogger("USBNet")}
}

func (m *USBNetManager) Setup(usbConfig USBConfig) (usbNetConfig, error) {
	config, err := fixedUSBNetConfig(usbConfig)
	if err != nil {
		return usbNetConfig{}, err
	}

	if err := validateUSBNetConfig(config); err != nil {
		return usbNetConfig{}, err
	}

	if err := m.configureGadget(config); err != nil {
		return usbNetConfig{}, err
	}

	if err := m.configureInterface(config); err != nil {
		return usbNetConfig{}, err
	}

	server, err := newUSBNetDHCPServer(config, m.logger)
	if err != nil {
		return usbNetConfig{}, err
	}
	go server.Serve()

	return config, nil
}

func fixedUSBNetConfig(config USBConfig) (usbNetConfig, error) {
	if config.Subnet == "" {
		config.Subnet = defaultUSBSubnet
	}
	deviceIP, hostIP, prefixLength, err := deriveUSBSubnetIPs(config.Subnet)
	if err != nil {
		return usbNetConfig{}, err
	}

	return usbNetConfig{
		VendorID:     usbVendorID,
		ProductID:    usbProductID,
		Manufacturer: usbManufacturer,
		Product:      usbProduct,
		SerialNumber: usbSerialNumber,
		GadgetName:   usbGadgetName,
		ConfigName:   usbConfigName,
		Function:     usbFunction,
		Interface:    usbInterface,
		DeviceIP:     deviceIP,
		HostIP:       hostIP,
		PrefixLength: prefixLength,
		DeviceMAC:    usbDeviceMAC,
		HostMAC:      usbHostMAC,
		LeaseSeconds: usbLeaseSeconds,
	}, nil
}

func deriveUSBSubnetIPs(subnet string) (string, string, int, error) {
	ip, ipNet, err := net.ParseCIDR(subnet)
	if err != nil {
		return "", "", 0, fmt.Errorf("invalid USB subnet %q: %w", subnet, err)
	}

	ip = ip.To4()
	if ip == nil {
		return "", "", 0, fmt.Errorf("USB subnet must be IPv4: %q", subnet)
	}

	prefixLength, bits := ipNet.Mask.Size()
	if bits != 32 || prefixLength > 30 {
		return "", "", 0, fmt.Errorf("USB subnet %q must provide at least two usable IPv4 addresses", subnet)
	}

	network := ip.Mask(ipNet.Mask).To4()
	if network == nil {
		return "", "", 0, fmt.Errorf("invalid USB subnet network %q", subnet)
	}

	host := make(net.IP, net.IPv4len)
	device := make(net.IP, net.IPv4len)
	base := binary.BigEndian.Uint32(network)
	binary.BigEndian.PutUint32(host, base+1)
	binary.BigEndian.PutUint32(device, base+2)

	return device.String(), host.String(), prefixLength, nil
}

func validateUSBNetConfig(config usbNetConfig) error {
	if strings.TrimSpace(config.VendorID) == "" {
		return errors.New("USB vendor ID is required")
	}
	if strings.TrimSpace(config.ProductID) == "" {
		return errors.New("USB product ID is required")
	}
	if _, ok := map[string]bool{"ecm": true, "ncm": true, "rndis": true}[config.Function]; !ok {
		return fmt.Errorf("unsupported USB Ethernet function %q", config.Function)
	}
	if net.ParseIP(config.DeviceIP).To4() == nil {
		return fmt.Errorf("invalid USB device IP %q", config.DeviceIP)
	}
	if net.ParseIP(config.HostIP).To4() == nil {
		return fmt.Errorf("invalid USB host IP %q", config.HostIP)
	}
	if config.PrefixLength <= 0 || config.PrefixLength > 32 {
		return fmt.Errorf("invalid USB prefix length %d", config.PrefixLength)
	}
	if _, err := net.ParseMAC(config.DeviceMAC); err != nil {
		return fmt.Errorf("invalid USB device MAC %q: %w", config.DeviceMAC, err)
	}
	if _, err := net.ParseMAC(config.HostMAC); err != nil {
		return fmt.Errorf("invalid USB host MAC %q: %w", config.HostMAC, err)
	}
	return nil
}

func (m *USBNetManager) configureGadget(config usbNetConfig) error {
	if err := ensureConfigFSMounted(); err != nil {
		return err
	}

	gadgetPath := filepath.Join(usbGadgetRoot, config.GadgetName)
	udcPath := filepath.Join(gadgetPath, "UDC")
	boundUDC := ""
	if value, err := readFileIntoString(udcPath); err == nil {
		boundUDC = strings.TrimSpace(value)
	}
	if boundUDC != "" {
		m.logger.Info("USB gadget already bound to %s, refreshing descriptor config", boundUDC)
		if err := writeConfigFSFile(udcPath, "\n"); err != nil {
			return fmt.Errorf("failed to unbind USB gadget from %s: %w", boundUDC, err)
		}
	}

	m.logger.Info("Configuring USB gadget %s (%s:%s)", config.GadgetName, config.VendorID, config.ProductID)

	if err := os.MkdirAll(gadgetPath, 0755); err != nil {
		return fmt.Errorf("failed to create USB gadget: %w", err)
	}

	writes := map[string]string{
		"idVendor":  config.VendorID,
		"idProduct": config.ProductID,
		"bcdDevice": "0x0100",
		"bcdUSB":    "0x0200",
	}
	for name, value := range writes {
		if err := writeConfigFSFile(filepath.Join(gadgetPath, name), value); err != nil {
			return err
		}
	}

	stringsPath := filepath.Join(gadgetPath, "strings", "0x409")
	if err := os.MkdirAll(stringsPath, 0755); err != nil {
		return fmt.Errorf("failed to create USB gadget strings: %w", err)
	}
	stringWrites := map[string]string{
		"serialnumber": config.SerialNumber,
		"manufacturer": config.Manufacturer,
		"product":      config.Product,
	}
	for name, value := range stringWrites {
		if err := writeConfigFSFile(filepath.Join(stringsPath, name), value); err != nil {
			return err
		}
	}

	configPath := filepath.Join(gadgetPath, "configs", config.ConfigName)
	configStringsPath := filepath.Join(configPath, "strings", "0x409")
	if err := os.MkdirAll(configStringsPath, 0755); err != nil {
		return fmt.Errorf("failed to create USB gadget config: %w", err)
	}
	if err := writeConfigFSFile(filepath.Join(configStringsPath, "configuration"), usbProduct); err != nil {
		return err
	}
	if err := writeConfigFSFile(filepath.Join(configPath, "MaxPower"), "250"); err != nil {
		return err
	}

	functionName := fmt.Sprintf("%s.%s", config.Function, config.Interface)
	functionPath := filepath.Join(gadgetPath, "functions", functionName)
	if err := os.MkdirAll(functionPath, 0755); err != nil {
		return fmt.Errorf("failed to create USB function %s: %w", functionName, err)
	}

	for name, value := range map[string]string{"dev_addr": config.DeviceMAC, "host_addr": config.HostMAC} {
		path := filepath.Join(functionPath, name)
		if fileExists(path) {
			if err := writeConfigFSFile(path, value); err != nil {
				return err
			}
		}
	}

	linkPath := filepath.Join(configPath, functionName)
	if !fileExists(linkPath) {
		if err := os.Symlink(functionPath, linkPath); err != nil {
			return fmt.Errorf("failed to link USB function into config: %w", err)
		}
	}

	udcName := boundUDC
	if udcName == "" {
		var err error
		udcName, err = firstUDC()
		if err != nil {
			return err
		}
	}
	if err := writeConfigFSFile(udcPath, udcName); err != nil {
		return err
	}

	m.logger.Info("USB gadget bound to %s", udcName)
	return nil
}

func (m *USBNetManager) configureInterface(config usbNetConfig) error {
	address := fmt.Sprintf("%s/%d", config.DeviceIP, config.PrefixLength)
	if err := runCommand("ip", "link", "set", config.Interface, "up"); err != nil {
		return fmt.Errorf("failed to bring up %s: %w", config.Interface, err)
	}
	if err := runCommand("ip", "addr", "replace", address, "dev", config.Interface); err != nil {
		return fmt.Errorf("failed to assign %s to %s: %w", address, config.Interface, err)
	}
	m.logger.Info("USB network ready on %s at %s", config.Interface, address)
	return nil
}

func ensureConfigFSMounted() error {
	if fileExists(usbGadgetRoot) {
		return nil
	}

	if !fileExists(configFSRoot) {
		if err := os.MkdirAll(configFSRoot, 0755); err != nil {
			return fmt.Errorf("failed to create configfs mount point: %w", err)
		}
	}

	if err := runCommand("mount", "-t", "configfs", "none", configFSRoot); err != nil {
		return fmt.Errorf("failed to mount configfs: %w", err)
	}
	if !fileExists(usbGadgetRoot) {
		return errors.New("configfs mounted but usb_gadget is unavailable; kernel USB gadget support may be missing")
	}

	return nil
}

func writeConfigFSFile(path string, value string) error {
	if err := os.WriteFile(path, []byte(value), 0644); err != nil {
		return fmt.Errorf("failed to write %s: %w", path, err)
	}
	return nil
}

func firstUDC() (string, error) {
	entries, err := os.ReadDir("/sys/class/udc")
	if err != nil {
		return "", fmt.Errorf("failed to read UDC devices: %w", err)
	}
	for _, entry := range entries {
		name := strings.TrimSpace(entry.Name())
		if name != "" {
			return name, nil
		}
	}
	return "", errors.New("no USB device controller found; this board may not support USB device/OTG mode")
}

func runCommand(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s failed: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return nil
}

type usbNetDHCPServer struct {
	config usbNetConfig
	logger *Logger
	server *server4.Server
}

func newUSBNetDHCPServer(config usbNetConfig, logger *Logger) (*usbNetDHCPServer, error) {
	dhcpServer := &usbNetDHCPServer{config: config, logger: logger}
	listenAddr := &net.UDPAddr{IP: net.IPv4zero, Port: dhcpServerPort}
	server, err := server4.NewServer(config.Interface, listenAddr, dhcpServer.handle, server4.WithLogger(server4.EmptyLogger{}))
	if err != nil {
		return nil, fmt.Errorf("failed to start DHCP responder on UDP %d: %w", dhcpServerPort, err)
	}
	dhcpServer.server = server
	return dhcpServer, nil
}

func (s *usbNetDHCPServer) Serve() {
	s.logger.Info("USB DHCP responder serving %s to host", s.config.HostIP)
	if err := s.server.Serve(); err != nil {
		s.logger.Warn("USB DHCP responder stopped: %v", err)
	}
}

func (s *usbNetDHCPServer) handle(conn net.PacketConn, peer net.Addr, request *dhcpv4.DHCPv4) {
	if request == nil || request.OpCode != dhcpv4.OpcodeBootRequest {
		return
	}

	hostIP := net.ParseIP(s.config.HostIP).To4()
	deviceIP := net.ParseIP(s.config.DeviceIP).To4()
	if hostIP == nil || deviceIP == nil {
		s.logger.Warn("USB DHCP has invalid fixed IP configuration")
		return
	}

	var responseType dhcpv4.MessageType
	switch request.MessageType() {
	case dhcpv4.MessageTypeDiscover:
		responseType = dhcpv4.MessageTypeOffer
	case dhcpv4.MessageTypeRequest:
		responseType = dhcpv4.MessageTypeAck
	default:
		return
	}

	reply, err := dhcpv4.NewReplyFromRequest(request,
		dhcpv4.WithMessageType(responseType),
		dhcpv4.WithYourIP(hostIP),
		dhcpv4.WithServerIP(deviceIP),
		dhcpv4.WithNetmask(net.CIDRMask(s.config.PrefixLength, 32)),
		dhcpv4.WithLeaseTime(uint32(s.config.LeaseSeconds)),
		dhcpv4.WithOption(dhcpv4.OptServerIdentifier(deviceIP)),
	)
	if err != nil {
		s.logger.Warn("Failed to build USB DHCP response: %v", err)
		return
	}

	if _, err := conn.WriteTo(reply.ToBytes(), peer); err != nil {
		s.logger.Warn("Failed to send USB DHCP response: %v", err)
	}
}

func usbDevServerHost(config *Config, usbConfig usbNetConfig) Host {
	port := 8000
	if len(config.FallbackHosts) > 0 && config.FallbackHosts[0].Port > 0 {
		port = config.FallbackHosts[0].Port
	}
	return Host{Host: usbConfig.HostIP, Port: port}
}

func preferUSBDevHost(config *Config, usbConfig usbNetConfig) {
	usbHost := usbDevServerHost(config, usbConfig)
	hosts := []Host{usbHost}
	for _, host := range config.FallbackHosts {
		if host.Host == usbHost.Host && host.Port == usbHost.Port {
			continue
		}
		hosts = append(hosts, host)
	}
	config.FallbackHosts = hosts
	config.UseMDNS = false
}

func waitForUSBDevServer(cage *CageLauncher, url string, timeout time.Duration) bool {
	return cage.WaitForDevServer(url, timeout)
}
