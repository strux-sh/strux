package runtime

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestResolveHTTPAddrDefaultsToLoopback(t *testing.T) {
	t.Setenv("STRUX_HTTP_ADDR", "")

	if addr := resolveHTTPAddr(); addr != "127.0.0.1:8080" {
		t.Fatalf("expected loopback default, got %q", addr)
	}
}

func TestResolveHTTPAddrUsesOverride(t *testing.T) {
	t.Setenv("STRUX_HTTP_ADDR", " :8080 ")

	if addr := resolveHTTPAddr(); addr != ":8080" {
		t.Fatalf("expected override address, got %q", addr)
	}
}

func TestHealthEndpointDoesNotRequireStaticFiles(t *testing.T) {
	handler := &spaHandler{
		staticDir:  t.TempDir(),
		fileServer: http.FileServer(http.Dir(t.TempDir())),
	}
	req := httptest.NewRequest(http.MethodHead, "/__strux/health", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected health endpoint to return 204, got %d", rec.Code)
	}
}
