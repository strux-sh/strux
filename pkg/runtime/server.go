package runtime

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

// spaHandler serves static files from a directory and falls back to index.html
// for any path that doesn't match a real file. This enables client-side routing
// with frameworks like Vue Router, React Router, etc.
type spaHandler struct {
	staticDir string
	fileServer http.Handler
}

func (h *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
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
	http.ServeFile(w, r, filepath.Join(h.staticDir, "index.html"))
}

// Start begins the IPC bridge and HTTP server.
// It serves static files from ./frontend on port 8080.
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

// Serve starts the HTTP server on port 8080, serving static files from ./frontend.
// This function blocks until the server exits.
func (rt *Runtime) Serve() error {
	staticDir := "./frontend"
	handler := &spaHandler{
		staticDir:  staticDir,
		fileServer: http.FileServer(http.Dir(staticDir)),
	}

	log.Println("Strux: Starting HTTP server on :8080")
	log.Println("Strux: Serving static files from ./frontend (SPA fallback enabled)")

	return http.ListenAndServe(":8080", handler)
}
