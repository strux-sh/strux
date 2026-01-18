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
	if err := runtime.Start(app); err != nil {
		log.Fatal(err)
	}
}
