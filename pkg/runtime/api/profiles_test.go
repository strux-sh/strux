package api

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProfilesGetProfile(t *testing.T) {
	tempDir := t.TempDir()
	path := filepath.Join(tempDir, "profile.json")
	if err := os.WriteFile(path, []byte(`{"name":"touch","label":"Touch display"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	service := &ProfilesService{profilePath: path}
	profile, err := service.GetProfile()
	if err != nil {
		t.Fatalf("GetProfile returned an error: %v", err)
	}
	if profile == nil {
		t.Fatal("GetProfile returned nil")
	}
	if profile.Name != "touch" || profile.Label != "Touch display" {
		t.Fatalf("unexpected profile: %#v", profile)
	}
}

func TestProfilesGetProfileReturnsNilWhenNotConfigured(t *testing.T) {
	service := &ProfilesService{profilePath: filepath.Join(t.TempDir(), "missing.json")}
	profile, err := service.GetProfile()
	if err != nil {
		t.Fatalf("GetProfile returned an error: %v", err)
	}
	if profile != nil {
		t.Fatalf("expected nil profile, got %#v", profile)
	}
}

func TestProfilesGetProfileRejectsMalformedJSON(t *testing.T) {
	tempDir := t.TempDir()
	path := filepath.Join(tempDir, "profile.json")
	if err := os.WriteFile(path, []byte(`{"name":`), 0o600); err != nil {
		t.Fatal(err)
	}

	service := &ProfilesService{profilePath: path}
	if _, err := service.GetProfile(); err == nil {
		t.Fatal("expected malformed profile JSON to fail")
	}
}
