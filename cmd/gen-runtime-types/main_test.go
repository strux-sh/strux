package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseExtensionsCollectsReferencedTypes(t *testing.T) {
	tempDir := t.TempDir()
	source := `package extension

type SampleExtension struct{}

func (s *SampleExtension) Namespace() string { return "strux" }
func (s *SampleExtension) SubNamespace() string { return "sample" }

type Alias string

type Child struct {
	Value string
}

type Config struct {
	Child Child ` + "`json:\"child\"`" + `
	Tags []Alias ` + "`json:\"tags\"`" + `
	Index map[string]Child ` + "`json:\"index\"`" + `
}

type State struct {
	Config Config
}

type SampleMethods struct{}

func (s *SampleMethods) Apply(config Config) (State, error) { return State{}, nil }
`

	path := filepath.Join(tempDir, "sample.go")
	if err := os.WriteFile(path, []byte(source), 0644); err != nil {
		t.Fatalf("failed to write fixture: %v", err)
	}

	runtimeTypes, err := parseExtensions(tempDir)
	if err != nil {
		t.Fatalf("parseExtensions failed: %v", err)
	}

	if len(runtimeTypes.Extensions) != 1 {
		t.Fatalf("expected 1 extension, got %d", len(runtimeTypes.Extensions))
	}

	method := runtimeTypes.Extensions[0].Methods[0]
	if got := method.Params[0].TSType; got != "StruxRuntime.Config" {
		t.Fatalf("expected qualified param type, got %q", got)
	}
	if got := method.ReturnType; got != "StruxRuntime.State" {
		t.Fatalf("expected qualified return type, got %q", got)
	}

	typeNames := make(map[string]bool)
	for _, typeInfo := range runtimeTypes.Types {
		typeNames[typeInfo.Name] = true
	}

	for _, want := range []string{"Alias", "Child", "Config", "State"} {
		if !typeNames[want] {
			t.Fatalf("expected referenced type %q to be emitted", want)
		}
	}

	for _, typeInfo := range runtimeTypes.Types {
		if typeInfo.Name != "Config" {
			continue
		}
		if len(typeInfo.Fields) == 0 || typeInfo.Fields[0].Name != "child" {
			t.Fatalf("expected JSON field names to be used for runtime helper structs, got %#v", typeInfo.Fields)
		}
	}
}

func TestGenerateTypeScriptNamespacesRuntimeSupportTypes(t *testing.T) {
	runtimeTypes := RuntimeTypes{
		Types: []TypeInfo{
			{
				Name: "DevConfig",
				Kind: "struct",
				Fields: []FieldDef{
					{Name: "fallbackHosts", TSType: "DevHost[]"},
				},
			},
			{
				Name: "DevHost",
				Kind: "struct",
				Fields: []FieldDef{
					{Name: "host", TSType: "string"},
				},
			},
		},
		Extensions: []ExtensionInfo{
			{
				Namespace:    "strux",
				SubNamespace: "dev",
				Methods: []MethodInfo{
					{
						Name:       "Apply",
						Params:     []ParamDef{{Name: "config", TSType: "StruxRuntime.DevConfig"}},
						ReturnType: "void",
					},
				},
			},
		},
	}

	output := generateTypeScript(runtimeTypes)

	if !strings.Contains(output, "declare namespace StruxRuntime {") {
		t.Fatal("expected helper types to be namespaced under StruxRuntime")
	}
	if !strings.Contains(output, "Apply(config: StruxRuntime.DevConfig): Promise<void>;") {
		t.Fatal("expected extension method to reference the namespaced helper type")
	}
	if strings.Contains(output, "\ninterface DevConfig {\n") {
		t.Fatal("did not expect DevConfig to be emitted as a top-level interface")
	}
}
