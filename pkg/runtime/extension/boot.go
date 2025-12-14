package extension

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// BootExtension provides boot and system management functions
type BootExtension struct{}

// Namespace returns "strux"
func (b *BootExtension) Namespace() string {
	return "strux"
}

// SubNamespace returns "boot"
func (b *BootExtension) SubNamespace() string {
	return "boot"
}

// BootMethods provides the boot management methods
type BootMethods struct{}

// HideSplash communicates with Cage to hide the splash screen
func (b *BootMethods) HideSplash() error {
	// Connect to Cage's control socket
	socketPath := "/tmp/strux-cage-control.sock"

	fmt.Printf("Strux Boot: HideSplash() called, connecting to %s\n", socketPath)

	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		fmt.Printf("Strux Boot: Failed to connect: %v\n", err)
		// Socket doesn't exist (dev mode or splash not shown), silently succeed
		if os.IsNotExist(err) || isConnectionRefused(err) {
			fmt.Printf("Strux Boot: Socket not found or refused, returning nil (dev mode?)\n")
			return nil
		}
		return fmt.Errorf("failed to connect to Cage control socket: %w", err)
	}
	defer conn.Close()

	if uc, ok := conn.(*net.UnixConn); ok {
		_ = uc.SetDeadline(time.Now().Add(2 * time.Second))
	}

	fmt.Printf("Strux Boot: Connected, sending HIDE_SPLASH command\n")

	// Send HIDE_SPLASH command
	_, err = conn.Write([]byte("HIDE_SPLASH"))
	if err != nil {
		fmt.Printf("Strux Boot: Failed to send: %v\n", err)
		return fmt.Errorf("failed to send hide splash command: %w", err)
	}

	// Gracefully close write side to signal EOF to the server
	if uc, ok := conn.(*net.UnixConn); ok {
		_ = uc.CloseWrite()
	}

	fmt.Printf("Strux Boot: HIDE_SPLASH command sent successfully\n")
	return nil
}

// isConnectionRefused checks if the error is a connection refused error
func isConnectionRefused(err error) bool {
	if err == nil {
		return false
	}
	// Check for wrapped syscall errors
	var syscallErr syscall.Errno
	if errors.As(err, &syscallErr) {
		return syscallErr == syscall.ECONNREFUSED || syscallErr == syscall.ENOENT
	}
	// Fallback to string matching
	errStr := err.Error()
	return strings.Contains(errStr, "connection refused") ||
		strings.Contains(errStr, "no such file or directory")
}

// Reboot reboots the system
func (b *BootMethods) Reboot() error {
	cmd := exec.Command("reboot")
	return cmd.Run()
}

// Shutdown shuts down the system
func (b *BootMethods) Shutdown() error {
	cmd := exec.Command("poweroff")
	return cmd.Run()
}
