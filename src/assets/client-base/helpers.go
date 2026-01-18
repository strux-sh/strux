//
// Strux Client - Helper Functions
//
// Common utility functions used throughout the client.
//

package main

import (
	"os"
)

// fileExists checks if a file exists at the given path
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// readFileIntoString reads a file and returns its contents as a string
func readFileIntoString(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}
