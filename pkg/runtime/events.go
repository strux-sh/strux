package runtime

import (
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
)

// EventMessage represents a bidirectional event between Go and JavaScript
type EventMessage struct {
	Type  string      `json:"type"`
	Event string      `json:"event"`
	Data  interface{} `json:"data,omitempty"`
}

// EventHandler is a registered Go-side handler for events from JavaScript
type EventHandler struct {
	ID       uint64
	Callback func(data interface{})
}

// eventState holds all event-related state for the Runtime
type eventState struct {
	// Connections from WPE extension event channels
	eventConns   map[net.Conn]struct{}
	eventConnsMu sync.RWMutex

	// Go-side event listeners (for events coming from JS)
	handlers   map[string][]EventHandler // event name -> handlers
	handlersMu sync.RWMutex

	// Auto-incrementing handler ID
	nextHandlerID atomic.Uint64
}

func newEventState() *eventState {
	return &eventState{
		eventConns: make(map[net.Conn]struct{}),
		handlers:   make(map[string][]EventHandler),
	}
}

// Emit sends an event to all connected JavaScript frontends
func (rt *Runtime) Emit(event string, data interface{}) {
	msg := EventMessage{
		Type:  "event",
		Event: event,
		Data:  data,
	}

	jsonData, err := json.Marshal(msg)
	if err != nil {
		fmt.Printf("Strux Runtime: Failed to marshal event %s: %v\n", event, err)
		return
	}
	jsonData = append(jsonData, '\n')

	rt.events.eventConnsMu.RLock()
	conns := make([]net.Conn, 0, len(rt.events.eventConns))
	for conn := range rt.events.eventConns {
		conns = append(conns, conn)
	}
	rt.events.eventConnsMu.RUnlock()

	for _, conn := range conns {
		if _, err := conn.Write(jsonData); err != nil {
			// Connection broken, remove it
			rt.events.eventConnsMu.Lock()
			delete(rt.events.eventConns, conn)
			rt.events.eventConnsMu.Unlock()
			conn.Close()
		}
	}
}

// On registers a handler for events emitted from JavaScript.
// Returns a handler ID that can be passed to Off() to unregister.
func (rt *Runtime) On(event string, handler func(data interface{})) uint64 {
	id := rt.events.nextHandlerID.Add(1)

	rt.events.handlersMu.Lock()
	rt.events.handlers[event] = append(rt.events.handlers[event], EventHandler{
		ID:       id,
		Callback: handler,
	})
	rt.events.handlersMu.Unlock()

	return id
}

// Off removes a previously registered event handler by its ID.
func (rt *Runtime) Off(id uint64) {
	rt.events.handlersMu.Lock()
	defer rt.events.handlersMu.Unlock()

	for event, handlers := range rt.events.handlers {
		for i, h := range handlers {
			if h.ID == id {
				rt.events.handlers[event] = append(handlers[:i], handlers[i+1:]...)
				if len(rt.events.handlers[event]) == 0 {
					delete(rt.events.handlers, event)
				}
				return
			}
		}
	}
}

// handleEventConnection reads events from a JS event channel and dispatches to Go handlers
func (rt *Runtime) handleEventConnection(conn net.Conn) {
	defer func() {
		rt.events.eventConnsMu.Lock()
		delete(rt.events.eventConns, conn)
		rt.events.eventConnsMu.Unlock()
		conn.Close()
	}()

	decoder := json.NewDecoder(conn)

	for {
		var msg EventMessage
		if err := decoder.Decode(&msg); err != nil {
			return
		}

		if msg.Type != "event" || msg.Event == "" {
			continue
		}

		// Dispatch to registered Go handlers
		rt.events.handlersMu.RLock()
		handlers := make([]EventHandler, len(rt.events.handlers[msg.Event]))
		copy(handlers, rt.events.handlers[msg.Event])
		rt.events.handlersMu.RUnlock()

		data := msg.Data
		for _, h := range handlers {
			go h.Callback(data)
		}
	}
}
