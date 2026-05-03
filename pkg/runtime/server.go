package runtime

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// spaHandler serves static files from a directory and falls back to index.html
// for any path that doesn't match a real file. This enables client-side routing
// with frameworks like Vue Router, React Router, etc.
type spaHandler struct {
	staticDir  string
	fileServer http.Handler
}

func (h *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/__strux/health" {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Clean the path and build the full file path
	path := filepath.Join(h.staticDir, filepath.Clean(r.URL.Path))

	// Check if the requested path exists as a file
	info, err := os.Stat(path)
	if err == nil && !info.IsDir() {
		// File exists — serve it directly
		h.fileServer.ServeHTTP(w, r)
		return
	}

	// Check if it's a directory with an index.html
	if err == nil && info.IsDir() {
		indexPath := filepath.Join(path, "index.html")
		if _, err := os.Stat(indexPath); err == nil {
			h.fileServer.ServeHTTP(w, r)
			return
		}
	}

	// File doesn't exist — serve index.html for SPA client-side routing
	indexPath := filepath.Join(h.staticDir, "index.html")
	if _, statErr := os.Stat(indexPath); statErr != nil {
		log.Printf("SPA fallback: index.html not found at %s (resolved from staticDir=%s, cwd=%s): %v",
			indexPath, h.staticDir, getCwd(), statErr)
		http.Error(w, "index.html not found", http.StatusNotFound)
		return
	}
	log.Printf("SPA fallback: serving %s for request %s", indexPath, r.URL.Path)
	http.ServeFile(w, r, indexPath)
}

func getCwd() string {
	cwd, err := os.Getwd()
	if err != nil {
		return "(unknown)"
	}
	return cwd
}

func resolveStaticDir() string {
	if info, err := os.Stat("/strux/frontend"); err == nil && info.IsDir() {
		return "/strux/frontend"
	}
	return "./frontend"
}

func resolveHTTPAddr() string {
	addr := strings.TrimSpace(os.Getenv("STRUX_HTTP_ADDR"))
	if addr == "" {
		return "127.0.0.1:8080"
	}
	return addr
}

// Start begins the IPC bridge and HTTP server.
// It serves static files from /strux/frontend when available, otherwise ./frontend.
// This function blocks on the HTTP server — call it from main().
func Start(app interface{}) error {
	rt, err := Init(app)
	if err != nil {
		return err
	}
	defer rt.Stop()

	// Block on HTTP server
	return rt.Serve()
}

// Init creates the Runtime, starts the IPC socket, and returns the Runtime
// without blocking. Use this instead of Start when you need access to the
// Runtime for events (Emit/On/Off). Call rt.Serve() to start the HTTP server.
func Init(app interface{}) (*Runtime, error) {
	rt := New(app)
	if err := rt.Start(); err != nil {
		return nil, fmt.Errorf("failed to start IPC server: %w", err)
	}
	return rt, nil
}

// Serve starts the HTTP server on port 8080, serving static files from
// /strux/frontend when available, otherwise ./frontend.
// This function blocks until the server exits.
func (rt *Runtime) Serve() error {
	staticDir := resolveStaticDir()
	addr := resolveHTTPAddr()
	handler := &spaHandler{
		staticDir:  staticDir,
		fileServer: http.FileServer(http.Dir(staticDir)),
	}

	log.Printf("Strux: Starting HTTP server on %s", addr)
	log.Printf("Strux: Serving static files from %s (SPA fallback enabled)", staticDir)

	return http.ListenAndServe(addr, handler)
}
