//
// Strux Client - Cage Launcher
//
// Manages the Cage compositor and Cog browser processes.
// Cage is a Wayland compositor that runs a single application.
// Cog is a WPE WebKit-based browser optimized for embedded systems.
//

package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

// ErrBackendNotReady is returned when the backend doesn't start in time
var ErrBackendNotReady = errors.New("backend not ready")

// LaunchOptions contains configuration for launching Cage
type LaunchOptions struct {
	// CogURL is the base URL to load in Cog browser
	CogURL string
	// Resolution is the display resolution for single-monitor mode (e.g., "1920x1080")
	Resolution string
	// SplashImage is the path to the splash image (optional)
	SplashImage string
	// Inspector holds the WebKit Inspector configuration (optional, for dev mode)
	Inspector *InspectorConfig
	// DisplayConfig holds multi-monitor display configuration (optional)
	DisplayConfig *DisplayConfig
}

// CageLauncher manages the Cage compositor process
type CageLauncher struct {
	process *exec.Cmd
	logger  *Logger
	logFile *os.File
}

// CageLauncherInstance is the global Cage launcher
var CageLauncherInstance = &CageLauncher{
	logger: NewLogger("CageLauncher"),
}

// WaitForBackend waits for the Go backend to be ready on port 8080
func (c *CageLauncher) WaitForBackend(timeout time.Duration) bool {
	c.logger.Info("Waiting for backend on port 8080 (timeout: %v)...", timeout)

	client := &http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(timeout)
	attempt := 0

	for time.Now().Before(deadline) {
		attempt++
		resp, err := client.Head("http://localhost:8080")
		if err != nil {
			if attempt%10 == 1 { // Log every 10th attempt (every 5 seconds)
				c.logger.Info("Backend not ready yet (attempt %d): %v", attempt, err)
			}
		} else {
			resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 400 {
				c.logger.Info("Backend is ready! (status: %d, after %d attempts)", resp.StatusCode, attempt)
				return true
			}
			c.logger.Warn("Backend returned status %d (attempt %d)", resp.StatusCode, attempt)
		}
		time.Sleep(500 * time.Millisecond)
	}

	c.logger.Error("Backend did not start within %v (after %d attempts)", timeout, attempt)
	return false
}

// WaitForNetworkReady waits for the network interface to be ready to bind to 0.0.0.0
// This is critical for WebKit Inspector which binds to 0.0.0.0:<port>
// Checks:
// 1) Port is free (inspector port if provided, or test port)
// 2) At least one global IPv4 address exists (not 127.x, not 169.254.x)
// 3) Default route is present
func (c *CageLauncher) WaitForNetworkReady(timeout time.Duration) bool {
	return c.WaitForNetworkReadyWithPort(timeout, 0)
}

// WaitForNetworkReadyWithPort waits for network readiness, checking a specific port
func (c *CageLauncher) WaitForNetworkReadyWithPort(timeout time.Duration, inspectorPort int) bool {
	c.logger.Info("Waiting for network interface to be ready (timeout: %v)...", timeout)

	deadline := time.Now().Add(timeout)
	attempt := 0

	for time.Now().Before(deadline) {
		attempt++

		// Check 1: Port is free (if inspector port specified)
		if inspectorPort > 0 {
			if !c.isPortFree(inspectorPort) {
				if attempt%10 == 1 {
					c.logger.Info("Port %d not free yet (attempt %d)", inspectorPort, attempt)
				}
				time.Sleep(500 * time.Millisecond)
				continue
			}
		}

		// Check 2: At least one global IPv4 address exists
		hasGlobalIPv4 := c.hasGlobalIPv4()
		if !hasGlobalIPv4 {
			if attempt%10 == 1 {
				c.logger.Info("No global IPv4 address yet (attempt %d)", attempt)
			}
			time.Sleep(500 * time.Millisecond)
			continue
		}

		// Check 3: Default route is present
		hasDefaultRoute := c.hasDefaultRoute()
		if !hasDefaultRoute {
			if attempt%10 == 1 {
				c.logger.Info("No default route yet (attempt %d)", attempt)
			}
			time.Sleep(500 * time.Millisecond)
			continue
		}

		// All checks passed - network is ready
		c.logger.Info("Network interface is ready! (after %d attempts)", attempt)
		return true
	}

	c.logger.Error("Network interface did not become ready within %v (after %d attempts)", timeout, attempt)
	return false
}

// isPortFree checks if a port is free using ss command
func (c *CageLauncher) isPortFree(port int) bool {
	cmd := exec.Command("sh", "-c", fmt.Sprintf("ss -ltn | awk '{print $4}' | grep -q ':%d$'", port))
	err := cmd.Run()
	// If grep finds the port, it returns 0 (success), meaning port is NOT free
	// If grep doesn't find it, it returns non-zero, meaning port IS free
	return err != nil
}

// hasGlobalIPv4 checks if there's at least one global IPv4 address (not 127.x, not 169.254.x)
func (c *CageLauncher) hasGlobalIPv4() bool {
	cmd := exec.Command("ip", "-4", "-o", "addr", "show", "scope", "global")
	output, err := cmd.Output()
	if err != nil {
		return false
	}

	// Check if output contains "inet " (IPv4 address)
	return strings.Contains(string(output), "inet ")
}

// hasDefaultRoute checks if a default route is present
func (c *CageLauncher) hasDefaultRoute() bool {
	cmd := exec.Command("sh", "-c", "ip route | grep -q '^default '")
	err := cmd.Run()
	// grep returns 0 if found (success), non-zero if not found
	return err == nil
}

// WaitForDevServer waits for the dev server (Vite) to be reachable at the specified URL
func (c *CageLauncher) WaitForDevServer(url string, timeout time.Duration) bool {
	c.logger.Info("Waiting for dev server at %s (timeout: %v)...", url, timeout)

	client := &http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(timeout)
	attempt := 0

	for time.Now().Before(deadline) {
		attempt++
		resp, err := client.Get(url)
		if err != nil {
			if attempt%10 == 1 { // Log every 10th attempt (every 5 seconds)
				c.logger.Info("Dev server not reachable yet (attempt %d): %v", attempt, err)
			}
		} else {
			resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				c.logger.Info("Dev server is reachable! (status: %d, after %d attempts)", resp.StatusCode, attempt)
				return true
			}
			c.logger.Warn("Dev server returned status %d (attempt %d)", resp.StatusCode, attempt)
		}
		time.Sleep(500 * time.Millisecond)
	}

	c.logger.Error("Dev server did not become reachable within %v (after %d attempts)", timeout, attempt)
	return false
}

// writeDisplayMap writes the output-to-URL mapping file that Cage reads via --display-map.
// Format: one "output_name=url" per line, plus "output_name.resolution=WxH" for resolution.
func (c *CageLauncher) writeDisplayMap(opts LaunchOptions) error {
	var lines []string

	if opts.DisplayConfig != nil {
		for _, monitor := range opts.DisplayConfig.Monitors {
			cogURL := opts.CogURL + monitor.Path
			for _, name := range monitor.Names {
				lines = append(lines, fmt.Sprintf("%s=%s", name, cogURL))
				if monitor.Resolution != "" {
					lines = append(lines, fmt.Sprintf("%s.resolution=%s", name, monitor.Resolution))
				}
			}
		}
	}

	content := strings.Join(lines, "\n") + "\n"
	return os.WriteFile("/tmp/strux-display-map", []byte(content), 0644)
}

// writeDisplayMapAndGetPath writes the display map file and returns the path.
// Cage reads this file to know which URL to launch on each output.
func (c *CageLauncher) writeDisplayMapAndGetPath(opts LaunchOptions) string {
	if err := c.writeDisplayMap(opts); err != nil {
		c.logger.Error("Failed to write display map: %v", err)
		return ""
	}
	return "/tmp/strux-display-map"
}

// Launch starts Cage compositor with Cog browser
func (c *CageLauncher) Launch(opts LaunchOptions) error {
	c.logger.Info("Launching Cage and Cog with URL: %s", opts.CogURL)

	// Note: Network readiness is checked before calling Launch() in dev mode
	// This ensures both Cog and WebKit Inspector can use the network properly

	// Build Cage arguments
	// Always use per-view mode so each Cog is confined to its own output.
	// Unconfigured outputs get a "not configured" page instead of stretching.
	args := []string{"-m", "per-view"}

	// Pass input device mapping file if it exists
	if fileExists("/strux/.input-map") {
		args = append(args, "--input-map=/strux/.input-map")
	}

	// Write display map and pass to Cage — Cage spawns Cog instances per output
	// using the user-modifiable /strux/strux-run-cog.sh script
	displayMapPath := c.writeDisplayMapAndGetPath(opts)
	if displayMapPath != "" {
		args = append(args, fmt.Sprintf("--display-map=%s", displayMapPath))
	}

	// Add splash image if provided
	if opts.SplashImage != "" {
		args = append(args, fmt.Sprintf("--splash-image=%s", opts.SplashImage))
	}

	// No primary client command — Cage manages Cog lifecycle directly

	// Create the command
	c.process = exec.Command("cage", args...)

	// Set environment variables required for Cage and WebKit
	c.process.Env = append(os.Environ(),
		"WPE_WEB_EXTENSION_PATH=/usr/lib/wpe-web-extensions",
		"SEATD_SOCK=/run/seatd.sock",
		"WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1",
		"WEBKIT_FORCE_SANDBOX=0",
		"WLR_LIBINPUT_NO_DEVICES=1",

		// Prevent GIO/libproxy from blocking on DBus during early init
		"LIBPROXY_IGNORE_SETTINGS=1",
		"GIO_USE_PROXY_RESOLVER=direct",
		"GSETTINGS_BACKEND=memory",
	)

	// Load custom Cage environment variables from bsp.yaml (written by strux-build-post.sh)
	if extra := loadCageEnv("/strux/.cage-env"); len(extra) > 0 {
		c.logger.Info("Loaded %d custom Cage environment variables", len(extra))
		c.process.Env = append(c.process.Env, extra...)
	}

	// Add WebKit Inspector HTTP server if enabled (dev mode)
	// Must bind to 0.0.0.0 so it's accessible via QEMU port forwarding
	// (127.0.0.1 is not reachable from the host through QEMU's hostfwd)
	if opts.Inspector != nil && opts.Inspector.Enabled {
		inspectorAddr := fmt.Sprintf("0.0.0.0:%d", opts.Inspector.Port)
		c.process.Env = append(c.process.Env,
			fmt.Sprintf("WEBKIT_INSPECTOR_HTTP_SERVER=%s", inspectorAddr),
		)
		c.logger.Info("WebKit Inspector HTTP server enabled on port %d", opts.Inspector.Port)
	}

	// Open log file
	var err error
	c.logFile, err = os.Create("/tmp/strux-cage.log")
	if err != nil {
		c.logger.Warn("Could not create log file: %v", err)
	}

	// Set up stdout/stderr to go to log file
	if c.logFile != nil {
		c.process.Stdout = io.MultiWriter(c.logFile, &logWriter{logger: c.logger, prefix: "stdout"})
		c.process.Stderr = io.MultiWriter(c.logFile, &logWriter{logger: c.logger, prefix: "stderr"})
	}

	// Start the process
	if err := c.process.Start(); err != nil {
		return fmt.Errorf("failed to start Cage: %w", err)
	}

	c.logger.Info("Cage and Cog launched successfully (PID: %d)", c.process.Process.Pid)

	// Monitor the process in a goroutine
	go func() {
		err := c.process.Wait()
		if err != nil {
			c.logger.Error("Cage exited with error: %v", err)
		} else {
			c.logger.Info("Cage exited normally")
		}
	}()

	return nil
}

// Cleanup terminates the Cage process
func (c *CageLauncher) Cleanup() {
	if c.process != nil && c.process.Process != nil {
		c.logger.Info("Cleaning up Cage process...")
		c.process.Process.Kill()
		c.process = nil
	}

	if c.logFile != nil {
		c.logFile.Close()
		c.logFile = nil
	}
}

// loadCageEnv reads custom Cage environment variables from a KEY=VALUE file
func loadCageEnv(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var envs []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "#") && strings.Contains(line, "=") {
			envs = append(envs, line)
		}
	}
	return envs
}

// logWriter is a simple io.Writer that logs each line
type logWriter struct {
	logger *Logger
	prefix string
}

func (w *logWriter) Write(p []byte) (n int, err error) {
	// Log the output from Cage/Cog to help with debugging
	if len(p) > 0 {
		// Trim trailing newline to avoid double newlines in log
		output := string(p)
		if len(output) > 0 && output[len(output)-1] == '\n' {
			output = output[:len(output)-1]
		}
		if len(output) > 0 {
			w.logger.Info("[%s] %s", w.prefix, output)
		}
	}
	return len(p), nil
}
