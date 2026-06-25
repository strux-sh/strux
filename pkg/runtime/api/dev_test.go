package api

import (
	"path/filepath"
	"testing"
	"time"
)

func TestDevServiceApplySetEnabledAndReadState(t *testing.T) {
	tempDir := t.TempDir()
	methods := &DevService{
		activeConfigPath:   filepath.Join(tempDir, ".dev-env.json"),
		disabledConfigPath: filepath.Join(tempDir, ".dev-env.json.disabled"),
		restart:            func() error { return nil },
	}

	config := DevConfig{
		ClientKey: "client-key",
		UseMDNS:   true,
		FallbackHosts: []DevHost{
			{Host: "10.0.0.2", Port: 8000},
		},
		Inspector: DevInspectorConfig{
			Enabled: true,
			Port:    9333,
		},
	}

	if err := methods.Apply(config, false); err != nil {
		t.Fatalf("Apply(disabled) failed: %v", err)
	}

	state, err := methods.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig failed: %v", err)
	}
	if state.Enabled {
		t.Fatal("expected dev mode to be disabled")
	}
	if state.Config.ClientKey != "client-key" {
		t.Fatalf("unexpected client key: %q", state.Config.ClientKey)
	}
	if !fileExists(methods.disabledConfigPath) {
		t.Fatal("expected disabled config file to exist")
	}
	if fileExists(methods.activeConfigPath) {
		t.Fatal("did not expect active config file to exist")
	}

	if err := methods.SetEnabled(true); err != nil {
		t.Fatalf("SetEnabled(true) failed: %v", err)
	}

	state, err = methods.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig after enable failed: %v", err)
	}
	if !state.Enabled {
		t.Fatal("expected dev mode to be enabled")
	}
	if !fileExists(methods.activeConfigPath) {
		t.Fatal("expected active config file to exist")
	}
	if fileExists(methods.disabledConfigPath) {
		t.Fatal("did not expect disabled config file to exist after enable")
	}

	if err := methods.SetEnabled(false); err != nil {
		t.Fatalf("SetEnabled(false) failed: %v", err)
	}
	if fileExists(methods.activeConfigPath) {
		t.Fatal("did not expect active config file to exist after disable")
	}
	if !fileExists(methods.disabledConfigPath) {
		t.Fatal("expected disabled config file to exist after disable")
	}
}

func TestDevServiceApplyAndRestartSchedulesRestart(t *testing.T) {
	tempDir := t.TempDir()
	restarted := make(chan struct{}, 1)
	usbStates := make(chan bool, 1)
	methods := &DevService{
		activeConfigPath:   filepath.Join(tempDir, ".dev-env.json"),
		disabledConfigPath: filepath.Join(tempDir, ".dev-env.json.disabled"),
		restart: func() error {
			restarted <- struct{}{}
			return nil
		},
		setUSBNet: func(enabled bool) error {
			usbStates <- enabled
			return nil
		},
	}

	if err := methods.ApplyAndRestart(DevConfig{
		ClientKey: "client-key",
		UseMDNS:   true,
	}, true); err != nil {
		t.Fatalf("ApplyAndRestart failed: %v", err)
	}

	select {
	case <-restarted:
	case <-time.After(2 * time.Second):
		t.Fatal("expected restart callback to be invoked")
	}

	// The USB debug service should be synced to the enabled state.
	select {
	case enabled := <-usbStates:
		if !enabled {
			t.Fatal("expected USB debug service to be started when dev mode enabled")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected USB debug sync to be invoked")
	}
}

func TestDevServiceRejectEnableWithoutClientKey(t *testing.T) {
	tempDir := t.TempDir()
	methods := &DevService{
		activeConfigPath:   filepath.Join(tempDir, ".dev-env.json"),
		disabledConfigPath: filepath.Join(tempDir, ".dev-env.json.disabled"),
		restart:            func() error { return nil },
	}

	if err := methods.Apply(DevConfig{UseMDNS: true}, true); err == nil {
		t.Fatal("expected Apply to reject enabling without a client key")
	}
}
