package api

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

const BootNamespace = "boot"

// BootService provides boot and system management methods.
type BootService struct{}

// HideSplash communicates with Cage to hide the splash screen.
func (b *BootService) HideSplash() error {
	socketPath := "/tmp/strux-cage-control.sock"

	fmt.Printf("Strux Boot: HideSplash() called, connecting to %s\n", socketPath)

	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		fmt.Printf("Strux Boot: Failed to connect: %v\n", err)
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

	if _, err = conn.Write([]byte("HIDE_SPLASH")); err != nil {
		fmt.Printf("Strux Boot: Failed to send: %v\n", err)
		return fmt.Errorf("failed to send hide splash command: %w", err)
	}

	if uc, ok := conn.(*net.UnixConn); ok {
		_ = uc.CloseWrite()
	}

	fmt.Printf("Strux Boot: HIDE_SPLASH command sent successfully\n")
	return nil
}

func isConnectionRefused(err error) bool {
	if err == nil {
		return false
	}
	var syscallErr syscall.Errno
	if errors.As(err, &syscallErr) {
		return syscallErr == syscall.ECONNREFUSED || syscallErr == syscall.ENOENT
	}
	errStr := err.Error()
	return strings.Contains(errStr, "connection refused") ||
		strings.Contains(errStr, "no such file or directory")
}

// Reboot reboots the system.
func (b *BootService) Reboot() error {
	cmd := exec.Command("reboot")
	return cmd.Run()
}

// Shutdown shuts down the system.
func (b *BootService) Shutdown() error {
	cmd := exec.Command("poweroff")
	return cmd.Run()
}
