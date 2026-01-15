//
// Strux Client - Logger
//
// Simple colored logger for the Strux client.
// Uses ANSI escape codes for terminal colors.
//

package main

import (
	"fmt"
)

const (
	colorReset  = "\033[0m"
	colorCyan   = "\033[36m"
	colorYellow = "\033[33m"
	colorRed    = "\033[31m"
	colorBlue   = "\033[34m"
)

type Logger struct {
	service string
}

func NewLogger(service string) *Logger {

	return &Logger{service: service}

}

func (l *Logger) log(level, color, msg string, args ...interface{}) {
	formatted := fmt.Sprintf(msg, args...)
	fmt.Printf("%s[STRUX]%s %s[%s]%s [%s] %s\n",
		colorCyan, colorReset,
		color, level, colorReset,
		l.service, formatted)
}

func (l *Logger) Info(msg string, args ...interface{})  { l.log("INFO", colorBlue, msg, args...) }
func (l *Logger) Warn(msg string, args ...interface{})  { l.log("WARN", colorYellow, msg, args...) }
func (l *Logger) Error(msg string, args ...interface{}) { l.log("ERROR", colorRed, msg, args...) }
