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
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	logger := NewLogger("Main")
	logger.Info("Starting Strux Client...")

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

	// Wait a bit for connection to stabilize
	time.Sleep(500 * time.Millisecond)

	// Determine Cog URL - use discovered host but port 5173 (Vite dev server)
	cogURL := "http://" + connectedHost.Host + ":5173"
	logger.Info("Using dev server URL: %s", cogURL)

	// Launch Cage and Cog
	if err := launchDevMode(cogURL); err != nil {
		logger.Error("Failed to launch dev mode: %v", err)
		socket.Disconnect()
		launchProduction()
	}

	logger.Info("Dev client connected and ready")

	// Wait for shutdown signal
	waitForShutdown()

	// Cleanup
	socket.Disconnect()
	CageLauncherInstance.Cleanup()
}

// launchProduction launches Cage with production settings
func launchProduction() error {
	logger := NewLogger("Production")

	// Read display resolution
	resolution := "1920x1080"
	if content, err := readFileIntoString("/strux/.display-resolution"); err == nil {
		resolution = strings.TrimSpace(content)
	} else {
		logger.Warn("Could not read display resolution, using default")
	}

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

	// Launch Cage
	return cage.Launch("http://localhost:8080", resolution, splashImage)
}

// launchDevMode launches Cage in dev mode with the specified URL
func launchDevMode(cogURL string) error {
	logger := NewLogger("DevMode")

	// Read display resolution
	resolution := "1920x1080"
	if content, err := readFileIntoString("/strux/.display-resolution"); err == nil {
		resolution = strings.TrimSpace(content)
	} else {
		logger.Warn("Could not read display resolution, using default")
	}

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

	// Launch Cage
	return cage.Launch(cogURL, resolution, splashImage)
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
