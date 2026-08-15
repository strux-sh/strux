package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestIntrospectionEmitsEmptyArraysInsteadOfNull(t *testing.T) {
	dir := t.TempDir()
	mainPath := filepath.Join(dir, "main.go")
	source := `package main

type App struct {
	private string
}

type Empty struct{}

func (a *App) Ping() {}
`
	if err := os.WriteFile(mainPath, []byte(source), 0o644); err != nil {
		t.Fatalf("write main.go: %v", err)
	}

	output, err := introspectData(mainPath)
	if err != nil {
		t.Fatalf("introspect data: %v", err)
	}
	encoded, err := json.Marshal(output)
	if err != nil {
		t.Fatalf("marshal introspection output: %v", err)
	}

	var data map[string]any
	if err := json.Unmarshal(encoded, &data); err != nil {
		t.Fatalf("unmarshal output: %v", err)
	}
	app := data["app"].(map[string]any)
	if _, ok := app["fields"].([]any); !ok {
		t.Fatalf("app fields should be an array, got %#v", app["fields"])
	}
	structs := data["structs"].(map[string]any)
	empty := structs["Empty"].(map[string]any)
	if _, ok := empty["fields"].([]any); !ok {
		t.Fatalf("struct fields should be an array, got %#v", empty["fields"])
	}
}
