//
// Strux Client - Binary Handler
//
// Handles binary updates for the main application.
// When a new binary is received from the dev server, it:
// 1. Calculates checksum to verify integrity
// 2. Compares with current binary to avoid unnecessary updates
// 3. Writes the new binary to /strux/main
// 4. Reboots the system to apply changes
//

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
)

const binaryPath = "/strux/main"

// BinaryHandler handles binary updates
type BinaryHandler struct {
	logger *Logger
}

// BinaryHandlerInstance is the global binary handler
var BinaryHandlerInstance = &BinaryHandler{
	logger: NewLogger("BinaryHandler"),
}

// CalculateChecksum calculates the SHA-256 checksum of data
func (b *BinaryHandler) CalculateChecksum(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

// GetCurrentChecksum returns the checksum of the current binary
func (b *BinaryHandler) GetCurrentChecksum() (string, error) {
	if !fileExists(binaryPath) {
		b.logger.Info("No existing binary at %s", binaryPath)
		return "", nil
	}

	data, err := os.ReadFile(binaryPath)
	if err != nil {
		return "", fmt.Errorf("failed to read binary: %w", err)
	}

	return b.CalculateChecksum(data), nil
}

// HandleUpdate handles a binary update
func (b *BinaryHandler) HandleUpdate(data []byte) error {
	b.logger.Info("Received binary update (%d bytes)", len(data))

	// Calculate checksum of received binary
	receivedChecksum := b.CalculateChecksum(data)
	b.logger.Info("Received binary checksum: %s", receivedChecksum)

	// Check if binary is different from current
	currentChecksum, err := b.GetCurrentChecksum()
	if err != nil {
		b.logger.Warn("Could not get current checksum: %v", err)
	}

	if currentChecksum == receivedChecksum {
		b.logger.Info("Binary is identical to current version, skipping update")
		return nil
	}

	// Write the new binary
	b.logger.Info("Writing binary to %s...", binaryPath)
	if err := os.WriteFile(binaryPath, data, 0755); err != nil {
		return fmt.Errorf("failed to write binary: %w", err)
	}

	// Verify the written file
	writtenChecksum, err := b.GetCurrentChecksum()
	if err != nil {
		return fmt.Errorf("failed to verify written binary: %w", err)
	}

	if writtenChecksum != receivedChecksum {
		return fmt.Errorf("checksum mismatch: expected %s, got %s", receivedChecksum, writtenChecksum)
	}

	b.logger.Info("Binary updated successfully, rebooting system...")

	// Reboot the system
	return b.Reboot()
}

// Reboot reboots the system
func (b *BinaryHandler) Reboot() error {
	b.logger.Info("Initiating system reboot...")

	// Try systemctl reboot first
	cmd := exec.Command("systemctl", "reboot")
	if err := cmd.Run(); err != nil {
		b.logger.Warn("systemctl reboot failed, trying reboot command...")

		// Fall back to reboot command
		cmd = exec.Command("reboot")
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("failed to reboot: %w", err)
		}
	}

	return nil
}

