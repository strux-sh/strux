//
// Strux Client - Main Entry Point
//
// This client runs on the target device and handles:
// - Launching Cage compositor and Cog browser
// - Dev mode with WebSocket connection to host
// - Binary updates and system management
//

package main

import (
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// Version is set at build time via -ldflags
var Version = "unknown"

func main() {
	logger := NewLogger("Main")
	logger.Info("Starting Strux Client (v%s)...", Version)

	// Check if dev mode config file exists
	if !fileExists("/strux/.dev-env.json") {
		logger.Info("Production mode: Launching Cage and Cog")
		if err := launchProduction(); err != nil {
			logger.Error("Failed to launch production mode: %v", err)
			os.Exit(1)
		}
		waitForShutdown()
		return
	}

	// Dev mode - load config and connect
	logger.Info("Dev mode detected, loading configuration...")

	config, err := LoadConfig("/strux/.dev-env.json")
	if err != nil {
		logger.Error("Error reading config: %v", err)
		logger.Warn("Running in production mode")
		launchProduction()
		waitForShutdown()
		return
	}

	// Discover hosts
	logger.Info("Discovering dev server hosts...")
	hosts := DiscoverHosts(config)

	if len(hosts) == 0 {
		logger.Error("No hosts found")
		logger.Warn("Falling back to production mode")
		launchProduction()
		waitForShutdown()
		return
	}

	// Attempt to connect via WebSocket
	logger.Info("Attempting to connect to dev server via WebSocket...")
	socket := NewSocketClient(config.ClientKey)

	connected := false
	var connectedHost Host
	for _, host := range hosts {
		if err := socket.Connect(host); err == nil {
			connected = true
			connectedHost = host
			break
		}
		logger.Warn("Failed to connect to %s:%d", host.Host, host.Port)
	}

	if !connected {
		logger.Error("Failed to connect to any dev server")
		logger.Warn("Falling back to production mode")
		launchProduction()
		waitForShutdown()
		return
	}

	logger.Info("WebSocket connected to %s:%d", connectedHost.Host, connectedHost.Port)

	// Determine Cog URL - use discovered host but port 5173 (Vite dev server)
	cogURL := "http://" + connectedHost.Host + ":5173"
	logger.Info("Using dev server URL: %s", cogURL)

	cage := CageLauncherInstance

	// Try to connect to dev server immediately (with short timeout)
	// If it fails, then wait for network readiness and retry
	logger.Info("Attempting to connect to dev server immediately...")
	devServerReady := cage.WaitForDevServer(cogURL, 30*time.Second)

	if !devServerReady {
		// Dev server not immediately reachable - wait for network interface to be ready
		// Cog needs network to load the URL, and WebKit Inspector needs it to bind to 0.0.0.0
		logger.Info("Dev server not immediately reachable, waiting for network interface to be ready...")
		if !cage.WaitForNetworkReady(30 * time.Second) {
			logger.Error("Network interface not ready, falling back to production mode")
			socket.Disconnect()
			launchProduction()
			waitForShutdown()
			return
		}

		// Give network a moment to stabilize
		logger.Info("Network ready, waiting for network to stabilize...")
		time.Sleep(1 * time.Second)

		// Now retry connecting to dev server
		logger.Info("Retrying connection to dev server...")
		if !cage.WaitForDevServer(cogURL, 30*time.Second) {
			logger.Error("Dev server not reachable after network ready, falling back to production mode")
			socket.Disconnect()
			launchProduction()
			waitForShutdown()
			return
		}
	}

	// Ensure network is ready for WebKit Inspector (if enabled)
	// This is critical for binding to 0.0.0.0
	if config.Inspector.Enabled {
		logger.Info("WebKit Inspector enabled - ensuring network interface is ready...")
		if !cage.WaitForNetworkReadyWithPort(10*time.Second, config.Inspector.Port) {
			logger.Warn("Network interface check failed for base port, but continuing anyway...")
		}
	}

	// Give everything a moment to stabilize before launching Cage
	logger.Info("All checks complete, waiting 2 seconds before launching Cage...")
	time.Sleep(2 * time.Second)

	// Load display config to compute inspector ports
	displayConfig, _ := loadDisplaySettings()

	// Launch Cage and Cog with inspector if enabled
	if err := launchDevMode(cogURL, &config.Inspector); err != nil {
		logger.Error("Failed to launch dev mode: %v", err)
		socket.Disconnect()
		launchProduction()
	}

	logger.Info("Dev client connected and ready")

	// Report device info (IP + inspector ports + outputs) to the dev server
	sendDeviceInfo(socket, &config.Inspector, displayConfig)

	// Re-send device info on reconnect and when server explicitly requests it
	resendInfo := func() {
		sendDeviceInfo(socket, &config.Inspector, displayConfig)
	}
	socket.onReconnect = resendInfo
	socket.onDeviceInfoReq = resendInfo

	// Wait for shutdown signal
	waitForShutdown()

	// Cleanup
	socket.Disconnect()
	CageLauncherInstance.Cleanup()
}

// loadDisplaySettings loads display configuration and resolution.
// Returns the display config (may be nil) and the fallback resolution string.
func loadDisplaySettings() (*DisplayConfig, string) {
	logger := NewLogger("Display")

	// Try loading the display config (multi-monitor support)
	var displayConfig *DisplayConfig
	if dc, err := LoadDisplayConfig("/strux/.display-config.json"); err == nil {
		displayConfig = dc
		logger.Info("Loaded display config: %d monitor(s)", len(dc.Monitors))
	} else {
		logger.Info("No display config found, using single-monitor defaults")
	}

	// Read fallback resolution from legacy file or first monitor in config
	resolution := "1920x1080"
	if displayConfig != nil && len(displayConfig.Monitors) > 0 && displayConfig.Monitors[0].Resolution != "" {
		resolution = displayConfig.Monitors[0].Resolution
	} else if content, err := readFileIntoString("/strux/.display-resolution"); err == nil {
		resolution = strings.TrimSpace(content)
	}

	return displayConfig, resolution
}

// launchProduction launches Cage with production settings
func launchProduction() error {
	logger := NewLogger("Production")

	displayConfig, resolution := loadDisplaySettings()

	// Check for splash image
	splashImage := ""
	if fileExists("/strux/logo.png") {
		splashImage = "/strux/logo.png"
	}

	// Wait for backend to be ready
	cage := CageLauncherInstance
	if !cage.WaitForBackend(60 * time.Second) {
		return ErrBackendNotReady
	}

	logger.Info("Launching with resolution: %s", resolution)

	// Launch Cage with backend URL (no inspector in production)
	return cage.Launch(LaunchOptions{
		CogURL:        "http://localhost:8080",
		Resolution:    resolution,
		SplashImage:   splashImage,
		Inspector:     nil,
		DisplayConfig: displayConfig,
	})
}

// launchDevMode launches Cage in dev mode with the specified URL
func launchDevMode(cogURL string, inspector *InspectorConfig) error {
	logger := NewLogger("DevMode")

	displayConfig, resolution := loadDisplaySettings()

	// Check for splash image
	splashImage := ""
	if fileExists("/strux/logo.png") {
		splashImage = "/strux/logo.png"
	}

	// Wait for backend
	cage := CageLauncherInstance
	if !cage.WaitForBackend(60 * time.Second) {
		return ErrBackendNotReady
	}

	logger.Info("Launching with resolution: %s", resolution)

	// Launch Cage with inspector if enabled
	return cage.Launch(LaunchOptions{
		CogURL:        cogURL,
		Resolution:    resolution,
		SplashImage:   splashImage,
		Inspector:     inspector,
		DisplayConfig: displayConfig,
	})
}

// sendDeviceInfo reports the device IP and inspector port assignments to the dev server
func sendDeviceInfo(socket *SocketClient, inspector *InspectorConfig, displayConfig *DisplayConfig) {
	ip := GetDeviceIP()
	if ip == "" {
		ip = "unknown"
	}

	var ports []DeviceInfoInspectorPort

	if inspector != nil && inspector.Enabled {
		basePort := inspector.Port

		if displayConfig != nil && len(displayConfig.Monitors) > 0 {
			// One inspector port per monitor, assigned sequentially
			for i, monitor := range displayConfig.Monitors {
				ports = append(ports, DeviceInfoInspectorPort{
					Path: monitor.Path,
					Port: basePort + i,
				})
			}
		} else {
			// Single monitor fallback
			ports = append(ports, DeviceInfoInspectorPort{
				Path: "/",
				Port: basePort,
			})
		}
	}

	// Discover connected outputs via wlr-randr
	outputs := discoverOutputs()

	socket.SendDeviceInfo(ip, ports, outputs)
}

// discoverOutputs runs wlr-randr and parses connected output names
func discoverOutputs() []OutputInfo {
	logger := NewLogger("Display")

	cmd := exec.Command("wlr-randr")
	out, err := cmd.Output()
	if err != nil {
		logger.Warn("Failed to run wlr-randr: %v", err)
		return nil
	}

	var outputs []OutputInfo
	for _, line := range strings.Split(string(out), "\n") {
		// wlr-randr output lines start with the output name (no leading whitespace)
		if len(line) > 0 && line[0] != ' ' && line[0] != '\t' {
			parts := strings.Fields(line)
			if len(parts) > 0 {
				outputs = append(outputs, OutputInfo{Name: parts[0]})
			}
		}
	}

	logger.Info("Discovered %d outputs", len(outputs))
	for _, o := range outputs {
		logger.Info("  Output: %s", o.Name)
	}

	return outputs
}

// waitForShutdown blocks until SIGINT or SIGTERM is received
func waitForShutdown() {
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	sig := <-sigChan
	logger := NewLogger("Main")
	logger.Info("Received signal %v, shutting down...", sig)

	CageLauncherInstance.Cleanup()
}
