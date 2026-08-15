package api

import (
	"encoding/json"
	"fmt"
	"os"
)

const (
	ProfilesNamespace = "profiles"

	defaultProfilePath = "/etc/strux/profile.json"
)

// Profile describes the application-facing profile baked into an image.
type Profile struct {
	Name  string `json:"name"`
	Label string `json:"label"`
}

// ProfilesService provides runtime methods under window.strux.profiles.*.
type ProfilesService struct {
	profilePath string
}

// GetProfile returns the profile baked into the running image. Images built
// without profiles return nil.
func (p *ProfilesService) GetProfile() (*Profile, error) {
	path := p.profilePath
	if path == "" {
		path = defaultProfilePath
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to read profile: %w", err)
	}

	var profile Profile
	if err := json.Unmarshal(data, &profile); err != nil {
		return nil, fmt.Errorf("failed to parse profile: %w", err)
	}

	return &profile, nil
}
