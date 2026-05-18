package api

import (
	"encoding/json"
	"fmt"
	"os"
)

const (
	ProjectNamespace = "project"

	defaultProjectInfoPath = "/etc/strux/project.json"
)

// ProjectInfo describes the Strux project image currently running.
type ProjectInfo struct {
	Name           string `json:"name"`
	ProjectVersion string `json:"projectVersion"`
	StruxVersion   string `json:"struxVersion"`
	BSP            string `json:"bsp"`
	Arch           string `json:"arch"`
	BuiltAt        string `json:"builtAt"`
}

// ProjectService provides runtime methods under window.strux.project.*.
type ProjectService struct {
	infoPath string
}

// Info returns metadata for the currently booted project image.
func (p *ProjectService) Info() (ProjectInfo, error) {
	path := p.infoPath
	if path == "" {
		path = defaultProjectInfoPath
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return ProjectInfo{}, fmt.Errorf("failed to read project info: %w", err)
	}

	var info ProjectInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return ProjectInfo{}, fmt.Errorf("failed to parse project info: %w", err)
	}

	return info, nil
}
