package api

import (
	"fmt"
	"os"
	"runtime"
	"strings"
)

const SystemNamespace = "system"

// deviceModelPath is the device-tree node exposing the hardware model string on
// most ARM/RISC-V Linux boards.
const deviceModelPath = "/proc/device-tree/model"

// SystemService provides runtime methods under window.strux.system.* describing
// the device the image is currently running on.
type SystemService struct {
	// infoPath overrides the project metadata file location (used in tests).
	infoPath string
}

// BSP returns the name of the board support package the running image was built
// for, read from the project metadata written at build time.
func (s *SystemService) BSP() (string, error) {
	path := s.infoPath
	if path == "" {
		path = defaultProjectInfoPath
	}

	info, err := readProjectInfo(path)
	if err != nil {
		return "", fmt.Errorf("failed to read BSP: %w", err)
	}

	return info.BSP, nil
}

// Arch returns the CPU architecture the runtime binary was built for (e.g.
// "arm64", "amd64"), which matches the device it is executing on.
func (s *SystemService) Arch() (string, error) {
	return runtime.GOARCH, nil
}

// Model returns the hardware model string reported by the device tree (e.g.
// "Rockchip RK3576 EVB"). It returns an empty string on platforms without a
// device-tree model node (such as the dev-mode host).
func (s *SystemService) Model() (string, error) {
	data, err := os.ReadFile(deviceModelPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", fmt.Errorf("failed to read device model: %w", err)
	}

	// Device-tree strings are null-terminated; trim the terminator and any
	// surrounding whitespace.
	return strings.TrimSpace(strings.TrimRight(string(data), "\x00")), nil
}

// Hostname returns the device's network hostname.
func (s *SystemService) Hostname() (string, error) {
	hostname, err := os.Hostname()
	if err != nil {
		return "", fmt.Errorf("failed to read hostname: %w", err)
	}
	return hostname, nil
}
