package runtime

import (
	"testing"

	"github.com/strux-dev/strux/pkg/runtime/api"
)

type eventfulService struct {
	api.Service
}

// GetThing is a normal RPC method; Emit (from the embedded api.Service) must be
// filtered out of the reflected bindings.
func (e *eventfulService) GetThing() string { return "x" }

func TestExtractMethodsSkipsReservedEventMethods(t *testing.T) {
	r := newRegistry()

	names := map[string]bool{}
	for _, m := range r.extractMethods(&eventfulService{}) {
		names[m.Name] = true
	}

	if names["Emit"] {
		t.Error("Emit should be filtered out of RPC method bindings")
	}
	if !names["GetThing"] {
		t.Error("GetThing should be exposed as an RPC method")
	}
}
