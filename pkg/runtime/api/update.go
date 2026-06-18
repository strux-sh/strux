package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

const (
	UpdateNamespace = "update"

	defaultUpdateProgressPath = "/run/strux/update-progress.json"
	defaultUpdateStatePath    = "/strux-data/strux/update-state.json"
)

// UpdateProgress describes the current system update progress, if an update is active.
type UpdateProgress struct {
	Status       string `json:"status"`
	Progress     int    `json:"progress"`
	Message      string `json:"message,omitempty"`
	BytesWritten int64  `json:"bytesWritten,omitempty"`
	TotalBytes   int64  `json:"totalBytes,omitempty"`
	Slot         string `json:"slot,omitempty"`
	Version      string `json:"version,omitempty"`
	UpdatedAt    string `json:"updatedAt,omitempty"`
}

// UpdateState describes persisted A/B update state.
type UpdateState struct {
	Version        int    `json:"version"`
	ActiveSlot     string `json:"activeSlot"`
	PendingSlot    string `json:"pendingSlot"`
	TriesRemaining int    `json:"triesRemaining"`
	Generation     int    `json:"generation"`
	LastGoodAt     string `json:"lastGoodAt,omitempty"`
	LastError      string `json:"lastError"`
}

// UpdateService provides runtime methods under window.strux.update.*.
type UpdateService struct {
	progressPath string
	statePath    string
}

// Progress returns the latest update progress reported by strux-client.
func (u *UpdateService) Progress() (*UpdateProgress, error) {
	path := u.progressPath
	if path == "" {
		path = defaultUpdateProgressPath
	}

	var progress UpdateProgress
	exists, err := readOptionalJSON(path, &progress)
	if err != nil {
		return nil, fmt.Errorf("failed to read update progress: %w", err)
	}
	if !exists {
		return nil, nil
	}
	return &progress, nil
}

// State returns the persisted update boot state.
func (u *UpdateService) State() (*UpdateState, error) {
	path := u.statePath
	if path == "" {
		path = defaultUpdateStatePath
	}

	var state UpdateState
	exists, err := readOptionalJSON(path, &state)
	if err != nil {
		return nil, fmt.Errorf("failed to read update state: %w", err)
	}
	if !exists {
		return nil, nil
	}
	return &state, nil
}

func readOptionalJSON(path string, target interface{}) (bool, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(data, target); err != nil {
		return false, err
	}
	return true, nil
}
