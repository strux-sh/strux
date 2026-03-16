//
// Strux Client - Configuration
//
// Handles loading and parsing of the dev client configuration file.
// The config file is placed at /strux/.dev-env.json during dev builds.
//

package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// Host represents a dev server host
type Host struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

// InspectorConfig holds the WebKit Inspector configuration
type InspectorConfig struct {
	// Enabled controls whether the inspector is active
	Enabled bool `json:"enabled"`
	// Port is the port the inspector HTTP server listens on
	Port int `json:"port"`
}

// Config holds the dev client configuration
type Config struct {
	// ClientKey is the authentication key for the dev server
	ClientKey string `json:"clientKey"`

	// UseMDNS enables mDNS discovery for finding the dev server
	UseMDNS bool `json:"useMDNS"`

	// FallbackHosts are hosts to try if mDNS discovery fails
	FallbackHosts []Host `json:"fallbackHosts"`

	// Inspector holds the WebKit Inspector configuration
	Inspector InspectorConfig `json:"inspector"`
}

// DisplayMonitor represents a single monitor's display configuration
type DisplayMonitor struct {
	// Path is the URL path to load on this monitor (e.g., "/" or "/dashboard")
	Path string `json:"path"`
	// Resolution is the display resolution (e.g., "1920x1080")
	Resolution string `json:"resolution,omitempty"`
	// Names are the possible output names for this monitor (e.g., ["HDMI-A-1", "Virtual-1"])
	Names []string `json:"names,omitempty"`
}

// DisplayConfig holds the display configuration from strux.yaml
type DisplayConfig struct {
	// Monitors is the list of monitor configurations
	Monitors []DisplayMonitor `json:"monitors"`
}

// LoadDisplayConfig loads the display configuration from the specified path
func LoadDisplayConfig(path string) (*DisplayConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read display config file: %w", err)
	}

	var config DisplayConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse display config file: %w", err)
	}

	return &config, nil
}

// LoadConfig loads the configuration from the specified path
func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file: %w", err)
	}

	var config Config
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse config file: %w", err)
	}

	return &config, nil
}
