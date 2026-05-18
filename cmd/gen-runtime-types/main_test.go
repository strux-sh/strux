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

	if len(runtimeTypes.Extensions["strux"]) != 1 {
		t.Fatalf("expected 1 strux extension, got %d", len(runtimeTypes.Extensions["strux"]))
	}

	method := runtimeTypes.Extensions["strux"]["sample"].Methods[0]
	if got := method.Params[0].TSType; got != "StruxRuntime.Config" {
		t.Fatalf("expected qualified param type, got %q", got)
	}
	if got := method.ReturnTypes[0].TSType; got != "StruxRuntime.State" {
		t.Fatalf("expected qualified return type, got %q", got)
	}

	typeNames := make(map[string]bool)
	for name := range runtimeTypes.Structs {
		typeNames[name] = true
	}

	for _, want := range []string{"Child", "Config", "State"} {
		if !typeNames[want] {
			t.Fatalf("expected referenced type %q to be emitted", want)
		}
	}

	config := runtimeTypes.Structs["Config"]
	if len(config.Fields) == 0 || config.Fields[0].Name != "child" {
		t.Fatalf("expected JSON field names to be used for runtime helper structs, got %#v", config.Fields)
	}
}

func TestParseExtensionsCollectsRuntimeRegistrations(t *testing.T) {
	tempDir := t.TempDir()
	source := `package board

import struxruntime "github.com/strux-dev/strux/pkg/runtime"

type GPIOWriteRequest struct {
	Pin int ` + "`json:\"pin\"`" + `
	Value bool ` + "`json:\"value\"`" + `
}

type GPIOMethods struct{}

func init() {
	struxruntime.RegisterExtension("strux", "gpio", &GPIOMethods{})
}

func (g *GPIOMethods) Write(req GPIOWriteRequest) error { return nil }
func (g *GPIOMethods) Read(pin int) (bool, error) { return true, nil }
`

	path := filepath.Join(tempDir, "gpio.go")
	if err := os.WriteFile(path, []byte(source), 0644); err != nil {
		t.Fatalf("failed to write fixture: %v", err)
	}

	runtimeTypes, err := parseExtensions(tempDir)
	if err != nil {
		t.Fatalf("parseExtensions failed: %v", err)
	}

	if len(runtimeTypes.Extensions["strux"]) != 1 {
		t.Fatalf("expected 1 strux extension, got %d", len(runtimeTypes.Extensions["strux"]))
	}

	ext := runtimeTypes.Extensions["strux"]["gpio"]
	if len(ext.Methods) != 2 {
		t.Fatalf("expected 2 methods, got %#v", ext.Methods)
	}

	output := generateTypeScriptDeclarations(runtimeTypes, false)
	if !strings.Contains(output, "interface GPIOWriteRequest") {
		t.Fatalf("expected support type in output:\n%s", output)
	}
	if !strings.Contains(output, "gpio: {") {
		t.Fatalf("expected gpio namespace in output:\n%s", output)
	}
	if strings.Contains(output, "ipc: {") {
		t.Fatalf("did not expect ipc in extension-only output:\n%s", output)
	}
}

func TestParseExtensionsCollectsCustomExtensionRegistrations(t *testing.T) {
	tempDir := t.TempDir()
	source := `package board

import struxruntime "github.com/strux-dev/strux/pkg/runtime"

type GPIOMethods struct{}

func init() {
	struxruntime.RegisterCustomExtension("gpio", &GPIOMethods{})
}

func (g *GPIOMethods) Write(pin int, value bool) error { return nil }
`

	path := filepath.Join(tempDir, "gpio.go")
	if err := os.WriteFile(path, []byte(source), 0644); err != nil {
		t.Fatalf("failed to write fixture: %v", err)
	}

	runtimeTypes, err := parseExtensions(tempDir)
	if err != nil {
		t.Fatalf("parseExtensions failed: %v", err)
	}

	if len(runtimeTypes.Extensions["strux"]) != 1 {
		t.Fatalf("expected 1 strux extension, got %d", len(runtimeTypes.Extensions["strux"]))
	}
	if _, ok := runtimeTypes.Extensions["strux"]["gpio"]; !ok {
		t.Fatalf("expected strux.gpio extension, got %#v", runtimeTypes.Extensions)
	}
}

func TestGenerateTypeScriptNamespacesRuntimeSupportTypes(t *testing.T) {
	runtimeTypes := RuntimeTypes{
		Structs: map[string]StructDef{
			"DevConfig": {
				Fields: []FieldDef{
					{Name: "fallbackHosts", TSType: "DevHost[]"},
				},
			},
			"DevHost": {
				Fields: []FieldDef{
					{Name: "host", TSType: "string"},
				},
			},
		},
		Extensions: map[string]map[string]RuntimeExtensionDef{
			"strux": {
				"dev": {
					Methods: []MethodDef{
						{
							Name:   "Apply",
							Params: []ParamDef{{Name: "config", TSType: "StruxRuntime.DevConfig"}},
						},
					},
				},
			},
		},
	}

	output := generateTypeScript(runtimeTypes)

	if !strings.Contains(output, `"structs": {`) {
		t.Fatal("expected helper types to be emitted as runtime JSON")
	}
	if !strings.Contains(output, `"tsType": "StruxRuntime.DevConfig"`) {
		t.Fatal("expected extension method metadata to reference the namespaced helper type")
	}
	if strings.Contains(output, "\ninterface DevConfig {\n") {
		t.Fatal("did not expect DevConfig to be emitted as a top-level interface")
	}
}
