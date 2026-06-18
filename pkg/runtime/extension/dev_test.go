package extension

import (
	"path/filepath"
	"testing"
	"time"
)

func TestDevMethodsApplySetEnabledAndReadState(t *testing.T) {
	tempDir := t.TempDir()
	methods := &DevMethods{
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

func TestDevMethodsApplyAndRestartSchedulesRestart(t *testing.T) {
	tempDir := t.TempDir()
	restarted := make(chan struct{}, 1)
	methods := &DevMethods{
		activeConfigPath:   filepath.Join(tempDir, ".dev-env.json"),
		disabledConfigPath: filepath.Join(tempDir, ".dev-env.json.disabled"),
		restart: func() error {
			restarted <- struct{}{}
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
}

func TestDevMethodsRejectEnableWithoutClientKey(t *testing.T) {
	tempDir := t.TempDir()
	methods := &DevMethods{
		activeConfigPath:   filepath.Join(tempDir, ".dev-env.json"),
		disabledConfigPath: filepath.Join(tempDir, ".dev-env.json.disabled"),
		restart:            func() error { return nil },
	}

	if err := methods.Apply(DevConfig{UseMDNS: true}, true); err == nil {
		t.Fatal("expected Apply to reject enabling without a client key")
	}
}
