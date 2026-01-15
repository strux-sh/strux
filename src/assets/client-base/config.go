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

// Config holds the dev client configuration
type Config struct {
	// ClientKey is the authentication key for the dev server
	ClientKey string `json:"clientKey"`

	// UseMDNS enables mDNS discovery for finding the dev server
	UseMDNS bool `json:"useMDNS"`

	// FallbackHosts are hosts to try if mDNS discovery fails
	FallbackHosts []Host `json:"fallbackHosts"`
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
