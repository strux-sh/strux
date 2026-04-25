package runtime

import "testing"

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
