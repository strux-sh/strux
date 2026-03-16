package main

import (
	"log"

	"github.com/strux-dev/strux/pkg/runtime"
)

// App is the main application struct
// All public fields and methods are exposed to the frontend
type App struct {
	// Title is displayed in the window
	Title string

	// Counter is a simple state example
	Counter int
}

// Greet returns a greeting message
func (a *App) Greet(name string) string {
	return "Hello, " + name + "!"
}

// Add adds two numbers together
func (a *App) Add(x, y float64) float64 {
	return x + y
}

func main() {
	app := &App{
		Title:   "${projectName}",
		Counter: 0,
	}

	// Init starts the IPC bridge and returns the runtime for event access.
	// Use runtime.Start(app) instead if you don't need events.
	rt, err := runtime.Init(app)
	if err != nil {
		log.Fatal(err)
	}
	defer rt.Stop()

	// Listen for events from the frontend
	rt.On("hello", func(data interface{}) {
		log.Printf("Received hello event: %v", data)
		// Send an event back to the frontend
		rt.Emit("hello-reply", map[string]string{"message": "Hello from Go!"})
	})

	// Start HTTP server (blocks)
	if err := rt.Serve(); err != nil {
		log.Fatal(err)
	}
}
