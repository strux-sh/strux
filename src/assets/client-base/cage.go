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
	"time"
)

// ErrBackendNotReady is returned when the backend doesn't start in time
var ErrBackendNotReady = errors.New("backend not ready")

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

// Launch starts Cage compositor with Cog browser
func (c *CageLauncher) Launch(cogURL, resolution, splashImage string) error {
	c.logger.Info("Launching Cage and Cog with URL: %s", cogURL)

	// Build Cage arguments
	args := []string{}

	// Add splash image if provided
	if splashImage != "" {
		args = append(args, fmt.Sprintf("--splash-image=%s", splashImage))
	}

	// Build the shell command to run inside Cage
	// 1. Set display resolution using wlr-randr
	// 2. Launch Cog browser with the specified URL
	shellCmd := fmt.Sprintf(
		`wlr-randr --output Virtual-1 --mode "%s" 2>/dev/null || true; exec cog "%s" --web-extensions-dir=/usr/lib/wpe-web-extensions`,
		resolution, cogURL,
	)

	args = append(args, "--", "sh", "-c", shellCmd)

	// Create the command
	c.process = exec.Command("cage", args...)

	// Set environment variables required for Cage and WebKit
	c.process.Env = append(os.Environ(),
		"WPE_WEB_EXTENSION_PATH=/usr/lib/wpe-web-extensions",
		"SEATD_SOCK=/run/seatd.sock",
		"WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1",
		"WEBKIT_FORCE_SANDBOX=0",
	)

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
