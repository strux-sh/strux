package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	DevNamespace = "dev"

	defaultDevConfigPath      = "/strux/.dev-env.json"
	defaultDisabledConfigPath = "/strux/.dev-env.json.disabled"
	defaultInspectorPort      = 9223
)

// DevHost represents a dev server host.
type DevHost struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

// DevInspectorConfig holds WebKit Inspector settings.
type DevInspectorConfig struct {
	Enabled bool `json:"enabled"`
	Port    int  `json:"port"`
}

// DevUSBConfig holds USB debug Ethernet settings.
type DevUSBConfig struct {
	Enabled bool   `json:"enabled"`
	Subnet  string `json:"subnet"`
}

// DevConfig is the JSON payload stored in /strux/.dev-env.json.
type DevConfig struct {
	ClientKey     string             `json:"clientKey"`
	UseMDNS       bool               `json:"useMDNS"`
	FallbackHosts []DevHost          `json:"fallbackHosts"`
	Inspector     DevInspectorConfig `json:"inspector"`
	USB           DevUSBConfig       `json:"usb"`
}

// DevState exposes the current dev-mode state plus the stored config.
type DevState struct {
	Enabled bool      `json:"enabled"`
	Config  DevConfig `json:"config"`
}

// DevService provides runtime methods under window.strux.dev.*.
type DevService struct {
	activeConfigPath   string
	disabledConfigPath string
	restart            func() error
	// setUSBNet starts (enabled) or stops (disabled) the standalone
	// strux-usbnet.service so the USB debug link follows dev-mode state. Nil
	// uses a systemctl-based default.
	setUSBNet func(enabled bool) error
}

// GetConfig returns the currently stored dev-mode config.
func (d *DevService) GetConfig() (DevState, error) {
	activePath := d.activePath()
	disabledPath := d.disabledPath()

	switch {
	case fileExists(activePath):
		config, err := d.readConfig(activePath)
		if err != nil {
			return DevState{}, err
		}
		return DevState{Enabled: true, Config: config}, nil
	case fileExists(disabledPath):
		config, err := d.readConfig(disabledPath)
		if err != nil {
			return DevState{}, err
		}
		return DevState{Enabled: false, Config: config}, nil
	default:
		return DevState{
			Enabled: false,
			Config:  defaultDevConfig(),
		}, nil
	}
}

// SetConfig writes the dev config without changing whether dev mode is enabled.
func (d *DevService) SetConfig(config DevConfig) error {
	config = normalizeDevConfig(config)
	if err := validateDevConfig(config); err != nil {
		return err
	}

	activePath := d.activePath()
	disabledPath := d.disabledPath()
	targetPath := disabledPath
	if fileExists(activePath) {
		targetPath = activePath
	} else if fileExists(disabledPath) {
		targetPath = disabledPath
	}

	return d.writeConfig(targetPath, config)
}

// SetEnabled toggles whether the stored dev config is active.
func (d *DevService) SetEnabled(enabled bool) error {
	activePath := d.activePath()
	disabledPath := d.disabledPath()

	if enabled {
		state, err := d.GetConfig()
		if err != nil {
			return err
		}
		if err := validateDevConfigForEnable(state.Config); err != nil {
			return err
		}

		if fileExists(activePath) {
			return nil
		}
		if !fileExists(disabledPath) {
			return errors.New("no stored dev config found; call SetConfig or Apply first")
		}
		_ = os.Remove(activePath)
		return os.Rename(disabledPath, activePath)
	}

	if !fileExists(activePath) {
		return nil
	}

	_ = os.Remove(disabledPath)
	return os.Rename(activePath, disabledPath)
}

// Apply stores the config and toggles dev mode in one call.
func (d *DevService) Apply(config DevConfig, enabled bool) error {
	config = normalizeDevConfig(config)
	if err := validateDevConfig(config); err != nil {
		return err
	}
	if enabled {
		if err := validateDevConfigForEnable(config); err != nil {
			return err
		}
	}

	activePath := d.activePath()
	disabledPath := d.disabledPath()
	targetPath := disabledPath
	if enabled {
		targetPath = activePath
	}

	if err := d.writeConfig(targetPath, config); err != nil {
		return err
	}

	if enabled {
		_ = os.Remove(disabledPath)
		return nil
	}

	_ = os.Remove(activePath)
	return nil
}

// RestartService restarts the Strux systemd service after returning to the caller.
func (d *DevService) RestartService() error {
	restart := d.restartFunc()
	if restart == nil {
		return errors.New("restart function not configured")
	}

	go func() {
		time.Sleep(500 * time.Millisecond)
		// Bring the standalone USB debug service in line with the current
		// dev-mode state before restarting the kiosk service.
		if state, err := d.GetConfig(); err == nil {
			if uerr := d.usbNetFunc()(state.Enabled); uerr != nil {
				fmt.Printf("Strux Dev: Failed to sync USB debug service: %v\n", uerr)
			}
		}
		if err := restart(); err != nil {
			fmt.Printf("Strux Dev: Failed to restart service: %v\n", err)
		}
	}()

	return nil
}

// ApplyAndRestart stores the config, toggles dev mode, and restarts the service.
func (d *DevService) ApplyAndRestart(config DevConfig, enabled bool) error {
	if err := d.Apply(config, enabled); err != nil {
		return err
	}
	return d.RestartService()
}

func (d *DevService) readConfig(path string) (DevConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return DevConfig{}, fmt.Errorf("failed to read dev config: %w", err)
	}

	var config DevConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return DevConfig{}, fmt.Errorf("failed to parse dev config: %w", err)
	}

	return normalizeDevConfig(config), nil
}

func (d *DevService) writeConfig(path string, config DevConfig) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("failed to prepare config directory: %w", err)
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to encode dev config: %w", err)
	}

	tempPath := path + ".tmp"
	if err := os.WriteFile(tempPath, append(data, '\n'), 0644); err != nil {
		return fmt.Errorf("failed to write dev config: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("failed to activate dev config: %w", err)
	}

	return nil
}

func (d *DevService) activePath() string {
	if d.activeConfigPath != "" {
		return d.activeConfigPath
	}
	return defaultDevConfigPath
}

func (d *DevService) disabledPath() string {
	if d.disabledConfigPath != "" {
		return d.disabledConfigPath
	}
	return defaultDisabledConfigPath
}

func (d *DevService) restartFunc() func() error {
	if d.restart != nil {
		return d.restart
	}
	return func() error {
		return exec.Command("systemctl", "restart", "strux").Run()
	}
}

func (d *DevService) usbNetFunc() func(enabled bool) error {
	if d.setUSBNet != nil {
		return d.setUSBNet
	}
	return func(enabled bool) error {
		action := "stop"
		if enabled {
			action = "start"
		}
		return exec.Command("systemctl", action, "strux-usbnet").Run()
	}
}

func defaultDevConfig() DevConfig {
	return DevConfig{
		UseMDNS:       true,
		FallbackHosts: []DevHost{},
		Inspector: DevInspectorConfig{
			Enabled: false,
			Port:    defaultInspectorPort,
		},
		USB: DevUSBConfig{
			Enabled: true,
			Subnet:  "192.168.7.0/24",
		},
	}
}

func normalizeDevConfig(config DevConfig) DevConfig {
	if config.FallbackHosts == nil {
		config.FallbackHosts = []DevHost{}
	}
	if config.Inspector.Port == 0 {
		config.Inspector.Port = defaultInspectorPort
	}
	if strings.TrimSpace(config.USB.Subnet) == "" {
		config.USB.Subnet = "192.168.7.0/24"
	}
	return config
}

func validateDevConfig(config DevConfig) error {
	if config.Inspector.Port <= 0 {
		return errors.New("inspector.port must be greater than 0")
	}
	if strings.TrimSpace(config.USB.Subnet) == "" {
		return errors.New("usb.subnet is required")
	}
	ip, ipNet, err := net.ParseCIDR(config.USB.Subnet)
	if err != nil || ip.To4() == nil {
		return errors.New("usb.subnet must be an IPv4 CIDR")
	}
	prefixLength, bits := ipNet.Mask.Size()
	if bits != 32 || prefixLength > 30 {
		return errors.New("usb.subnet must provide at least two usable IPv4 addresses")
	}

	for i, host := range config.FallbackHosts {
		if strings.TrimSpace(host.Host) == "" {
			return fmt.Errorf("fallbackHosts[%d].host is required", i)
		}
		if host.Port <= 0 {
			return fmt.Errorf("fallbackHosts[%d].port must be greater than 0", i)
		}
	}

	return nil
}

func validateDevConfigForEnable(config DevConfig) error {
	if strings.TrimSpace(config.ClientKey) == "" {
		return errors.New("clientKey is required to enable dev mode")
	}
	return validateDevConfig(config)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
