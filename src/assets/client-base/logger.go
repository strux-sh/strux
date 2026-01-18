//
// Strux Client - Logger
//
// Simple colored logger for the Strux client.
// Uses ANSI escape codes for terminal colors.
// Also writes to serial console for debugging in QEMU.
//

package main

import (
	"fmt"
	"os"
	"runtime"
	"sync"
)

const (
	colorReset  = "\033[0m"
	colorCyan   = "\033[36m"
	colorYellow = "\033[33m"
	colorRed    = "\033[31m"
	colorBlue   = "\033[34m"
)

// serialConsole is the file handle to the serial console device
var (
	serialConsole     *os.File
	serialConsoleOnce sync.Once
)

// getSerialConsole returns the serial console file handle, opening it if needed
func getSerialConsole() *os.File {
	serialConsoleOnce.Do(func() {
		// Determine serial device based on architecture
		// x86_64: /dev/ttyS0
		// ARM64/ARM: /dev/ttyAMA0
		devices := []string{"/dev/ttyS0", "/dev/ttyAMA0", "/dev/console"}
		if runtime.GOARCH == "arm64" || runtime.GOARCH == "arm" {
			devices = []string{"/dev/ttyAMA0", "/dev/ttyS0", "/dev/console"}
		}

		for _, dev := range devices {
			f, err := os.OpenFile(dev, os.O_WRONLY|os.O_APPEND, 0)
			if err == nil {
				serialConsole = f
				break
			}
		}
	})
	return serialConsole
}

type Logger struct {
	service string
}

func NewLogger(service string) *Logger {
	return &Logger{service: service}
}

func (l *Logger) log(level, color, msg string, args ...interface{}) {
	formatted := fmt.Sprintf(msg, args...)
	logLine := fmt.Sprintf("%s[STRUX]%s %s[%s]%s [%s] %s\n",
		colorCyan, colorReset,
		color, level, colorReset,
		l.service, formatted)

	// Write to stdout (captured by systemd journal)
	fmt.Print(logLine)

	// Also write to serial console for QEMU debugging
	if serial := getSerialConsole(); serial != nil {
		// Write plain text without colors for cleaner serial output
		plainLine := fmt.Sprintf("[STRUX] [%s] [%s] %s\n", level, l.service, formatted)
		serial.WriteString(plainLine)
	}
}

func (l *Logger) Info(msg string, args ...interface{})  { l.log("INFO", colorBlue, msg, args...) }
func (l *Logger) Warn(msg string, args ...interface{})  { l.log("WARN", colorYellow, msg, args...) }
func (l *Logger) Error(msg string, args ...interface{}) { l.log("ERROR", colorRed, msg, args...) }
