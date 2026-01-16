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
const binaryTempPath = "/strux/main.new"

// BinaryUpdateResult contains the result of a binary update operation
type BinaryUpdateResult struct {
	Status           string // "skipped", "updated", "error"
	Message          string // Human-readable message
	CurrentChecksum  string // Checksum of current binary on disk (before update)
	ReceivedChecksum string // Checksum of received binary
}

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

// HandleUpdate handles a binary update and returns a result struct
func (b *BinaryHandler) HandleUpdate(data []byte) BinaryUpdateResult {
	b.logger.Info("Received binary update (%d bytes)", len(data))

	// Calculate checksum of received binary
	receivedChecksum := b.CalculateChecksum(data)
	b.logger.Info("Received binary checksum: %s", receivedChecksum)

	// Check if binary is different from current
	currentChecksum, err := b.GetCurrentChecksum()
	if err != nil {
		b.logger.Warn("Could not get current checksum: %v", err)
	}

	result := BinaryUpdateResult{
		CurrentChecksum:  currentChecksum,
		ReceivedChecksum: receivedChecksum,
	}

	if currentChecksum == receivedChecksum {
		b.logger.Info("Binary is identical to current version, skipping update")
		result.Status = "skipped"
		result.Message = "Binary is identical to current version"
		return result
	}

	// Write the new binary to a temporary file first
	// This avoids "text file busy" error when the binary is currently running
	b.logger.Info("Writing binary to %s...", binaryTempPath)
	if err := os.WriteFile(binaryTempPath, data, 0755); err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("Failed to write binary: %v", err)
		return result
	}

	// Verify the written temp file
	tempData, err := os.ReadFile(binaryTempPath)
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("Failed to read temp binary for verification: %v", err)
		return result
	}

	writtenChecksum := b.CalculateChecksum(tempData)
	if writtenChecksum != receivedChecksum {
		os.Remove(binaryTempPath) // Clean up temp file
		result.Status = "error"
		result.Message = fmt.Sprintf("Checksum mismatch: expected %s, got %s", receivedChecksum, writtenChecksum)
		return result
	}

	// Rename temp file to actual binary path (atomic operation, works even if target is running)
	b.logger.Info("Replacing binary at %s...", binaryPath)
	if err := os.Rename(binaryTempPath, binaryPath); err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("Failed to rename binary: %v", err)
		return result
	}

	b.logger.Info("Binary updated successfully, rebooting system...")
	result.Status = "updated"
	result.Message = "Binary updated, rebooting..."

	// Reboot the system (async, so we can still return)
	go func() {
		if err := b.Reboot(); err != nil {
			b.logger.Error("Reboot failed: %v", err)
		}
	}()

	return result
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
