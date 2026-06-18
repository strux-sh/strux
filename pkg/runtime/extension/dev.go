package extension

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultDevConfigPath      = "/strux/.dev-env.json"
	defaultDisabledConfigPath = "/strux/.dev-env.json.disabled"
	defaultInspectorPort      = 9223
)

// DevExtension provides runtime control over the device dev-mode config.
type DevExtension struct{}

// Namespace returns "strux".
func (d *DevExtension) Namespace() string {
	return "strux"
}

// SubNamespace returns "dev".
func (d *DevExtension) SubNamespace() string {
	return "dev"
}

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

// DevConfig is the JSON payload stored in /strux/.dev-env.json.
type DevConfig struct {
	ClientKey     string             `json:"clientKey"`
	UseMDNS       bool               `json:"useMDNS"`
	FallbackHosts []DevHost          `json:"fallbackHosts"`
	Inspector     DevInspectorConfig `json:"inspector"`
}

// DevState exposes the current dev-mode state plus the stored config.
type DevState struct {
	Enabled bool      `json:"enabled"`
	Config  DevConfig `json:"config"`
}

// DevMethods provides runtime methods under window.strux.dev.*.
type DevMethods struct {
	activeConfigPath   string
	disabledConfigPath string
	restart            func() error
}

// NewDevMethods returns the built-in dev-mode controller.
func NewDevMethods() *DevMethods {
	return &DevMethods{
		activeConfigPath:   defaultDevConfigPath,
		disabledConfigPath: defaultDisabledConfigPath,
		restart: func() error {
			return exec.Command("systemctl", "restart", "strux").Run()
		},
	}
}

// GetConfig returns the currently stored dev-mode config.
func (d *DevMethods) GetConfig() (DevState, error) {
	switch {
	case fileExists(d.activeConfigPath):
		config, err := d.readConfig(d.activeConfigPath)
		if err != nil {
			return DevState{}, err
		}
		return DevState{Enabled: true, Config: config}, nil
	case fileExists(d.disabledConfigPath):
		config, err := d.readConfig(d.disabledConfigPath)
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
func (d *DevMethods) SetConfig(config DevConfig) error {
	config = normalizeDevConfig(config)
	if err := validateDevConfig(config); err != nil {
		return err
	}

	targetPath := d.disabledConfigPath
	if fileExists(d.activeConfigPath) {
		targetPath = d.activeConfigPath
	} else if fileExists(d.disabledConfigPath) {
		targetPath = d.disabledConfigPath
	}

	return d.writeConfig(targetPath, config)
}

// SetEnabled toggles whether the stored dev config is active.
func (d *DevMethods) SetEnabled(enabled bool) error {
	if enabled {
		state, err := d.GetConfig()
		if err != nil {
			return err
		}
		if err := validateDevConfigForEnable(state.Config); err != nil {
			return err
		}

		if fileExists(d.activeConfigPath) {
			return nil
		}
		if !fileExists(d.disabledConfigPath) {
			return errors.New("no stored dev config found; call SetConfig or Apply first")
		}
		_ = os.Remove(d.activeConfigPath)
		return os.Rename(d.disabledConfigPath, d.activeConfigPath)
	}

	if !fileExists(d.activeConfigPath) {
		return nil
	}

	_ = os.Remove(d.disabledConfigPath)
	return os.Rename(d.activeConfigPath, d.disabledConfigPath)
}

// Apply stores the config and toggles dev mode in one call.
func (d *DevMethods) Apply(config DevConfig, enabled bool) error {
	config = normalizeDevConfig(config)
	if err := validateDevConfig(config); err != nil {
		return err
	}
	if enabled {
		if err := validateDevConfigForEnable(config); err != nil {
			return err
		}
	}

	targetPath := d.disabledConfigPath
	if enabled {
		targetPath = d.activeConfigPath
	}

	if err := d.writeConfig(targetPath, config); err != nil {
		return err
	}

	if enabled {
		_ = os.Remove(d.disabledConfigPath)
		return nil
	}

	_ = os.Remove(d.activeConfigPath)
	return nil
}

// RestartService restarts the Strux systemd service after returning to the caller.
func (d *DevMethods) RestartService() error {
	if d.restart == nil {
		return errors.New("restart function not configured")
	}

	go func() {
		time.Sleep(500 * time.Millisecond)
		if err := d.restart(); err != nil {
			fmt.Printf("Strux Dev: Failed to restart service: %v\n", err)
		}
	}()

	return nil
}

// ApplyAndRestart stores the config, toggles dev mode, and restarts the service.
func (d *DevMethods) ApplyAndRestart(config DevConfig, enabled bool) error {
	if err := d.Apply(config, enabled); err != nil {
		return err
	}
	return d.RestartService()
}

func (d *DevMethods) readConfig(path string) (DevConfig, error) {
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

func (d *DevMethods) writeConfig(path string, config DevConfig) error {
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

func defaultDevConfig() DevConfig {
	return DevConfig{
		UseMDNS:       true,
		FallbackHosts: []DevHost{},
		Inspector: DevInspectorConfig{
			Enabled: false,
			Port:    defaultInspectorPort,
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
	return config
}

func validateDevConfig(config DevConfig) error {
	if config.Inspector.Port <= 0 {
		return errors.New("inspector.port must be greater than 0")
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
