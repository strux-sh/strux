package extension

import "testing"

type testRegistryExtension struct{}

func (e *testRegistryExtension) Namespace() string {
	return "test"
}

func (e *testRegistryExtension) SubNamespace() string {
	return "config"
}

type testRegistryHost struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

type testRegistryConfig struct {
	Name  string             `json:"name"`
	Hosts []testRegistryHost `json:"hosts"`
}

type testRegistryMethods struct{}

func (m *testRegistryMethods) Describe(config testRegistryConfig) string {
	return config.Name + ":" + config.Hosts[0].Host
}

func (m *testRegistryMethods) CountPorts(hosts []testRegistryHost) int {
	total := 0
	for _, host := range hosts {
		total += host.Port
	}
	return total
}

func TestRegistryExecuteMethodDecodesStructParameters(t *testing.T) {
	registry := NewRegistry()
	if err := registry.Register(&testRegistryExtension{}, &testRegistryMethods{}); err != nil {
		t.Fatalf("register failed: %v", err)
	}

	result, err := registry.ExecuteMethod("test", "config", "Describe", []interface{}{
		map[string]interface{}{
			"name": "device",
			"hosts": []interface{}{
				map[string]interface{}{
					"host": "10.0.0.2",
					"port": 8000,
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("ExecuteMethod returned error: %v", err)
	}

	got, ok := result.(string)
	if !ok {
		t.Fatalf("expected string result, got %T", result)
	}
	if got != "device:10.0.0.2" {
		t.Fatalf("unexpected result: %q", got)
	}
}

func TestRegistryExecuteMethodDecodesSliceParameters(t *testing.T) {
	registry := NewRegistry()
	if err := registry.Register(&testRegistryExtension{}, &testRegistryMethods{}); err != nil {
		t.Fatalf("register failed: %v", err)
	}

	result, err := registry.ExecuteMethod("test", "config", "CountPorts", []interface{}{
		[]interface{}{
			map[string]interface{}{"host": "10.0.0.2", "port": 8000},
			map[string]interface{}{"host": "10.0.0.3", "port": 9000},
		},
	})
	if err != nil {
		t.Fatalf("ExecuteMethod returned error: %v", err)
	}

	got, ok := result.(int)
	if !ok {
		t.Fatalf("expected int result, got %T", result)
	}
	if got != 17000 {
		t.Fatalf("unexpected result: %d", got)
	}
}
