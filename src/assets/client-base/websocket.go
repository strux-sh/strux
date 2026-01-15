//
// Strux Client - WebSocket Client with Event Handling
//
// A wrapper around gorilla/websocket that provides socket.io-like
// event-based message handling. Messages use a simple JSON protocol:
//
//	{
//	    "type": "event-name",
//	    "payload": { ... event data ... }
//	}
//
// Usage:
//
//	ws := NewWSClient()
//	ws.On("new-binary", func(payload json.RawMessage) {
//	    var data BinaryPayload
//	    json.Unmarshal(payload, &data)
//	    // handle binary update
//	})
//	ws.Connect("ws://host:port/ws")
//	ws.Emit("request-binary", nil)
//

package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Message represents a WebSocket message with event type and payload
type Message struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// EventHandler is a function that handles an event with its payload
type EventHandler func(payload json.RawMessage)

// WSClient is a WebSocket client with event-based message handling
type WSClient struct {
	conn     *websocket.Conn
	handlers map[string][]EventHandler
	mu       sync.RWMutex
	connMu   sync.Mutex
	done     chan struct{}
	logger   *Logger

	// Connection state
	connected bool
	url       string

	// Callbacks for connection lifecycle
	onConnect    func()
	onDisconnect func()
	onError      func(error)

	// Configuration
	pingInterval    time.Duration
	reconnect       bool
	reconnectDelay  time.Duration
	maxReconnectTry int
}

// NewWSClient creates a new WebSocket client
func NewWSClient() *WSClient {
	return &WSClient{
		handlers:        make(map[string][]EventHandler),
		logger:          NewLogger("WSClient"),
		pingInterval:    30 * time.Second,
		reconnect:       true,
		reconnectDelay:  2 * time.Second,
		maxReconnectTry: 5,
	}
}

// On registers an event handler for a specific event type
// Multiple handlers can be registered for the same event
func (w *WSClient) On(eventType string, handler EventHandler) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.handlers[eventType] = append(w.handlers[eventType], handler)
}

// Off removes all handlers for a specific event type
func (w *WSClient) Off(eventType string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.handlers, eventType)
}

// OnConnect sets a callback for when connection is established
func (w *WSClient) OnConnect(handler func()) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.onConnect = handler
}

// OnDisconnect sets a callback for when connection is lost
func (w *WSClient) OnDisconnect(handler func()) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.onDisconnect = handler
}

// OnError sets a callback for connection errors
func (w *WSClient) OnError(handler func(error)) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.onError = handler
}

// SetReconnect configures auto-reconnection behavior
func (w *WSClient) SetReconnect(enabled bool, delay time.Duration, maxRetries int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.reconnect = enabled
	w.reconnectDelay = delay
	w.maxReconnectTry = maxRetries
}

// Connect establishes a WebSocket connection to the specified URL
func (w *WSClient) Connect(wsURL string) error {
	w.connMu.Lock()
	defer w.connMu.Unlock()

	// Parse and validate URL
	u, err := url.Parse(wsURL)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}

	// Ensure ws:// or wss:// scheme
	if u.Scheme != "ws" && u.Scheme != "wss" {
		// Convert http/https to ws/wss
		if u.Scheme == "http" {
			u.Scheme = "ws"
		} else if u.Scheme == "https" {
			u.Scheme = "wss"
		} else {
			u.Scheme = "ws"
		}
	}

	w.url = u.String()
	w.logger.Info("Connecting to %s...", w.url)

	// Dial the WebSocket server
	conn, _, err := websocket.DefaultDialer.Dial(w.url, nil)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}

	w.conn = conn
	w.done = make(chan struct{})
	w.connected = true

	// Start the read loop
	go w.readLoop()

	// Start ping loop to keep connection alive
	go w.pingLoop()

	w.logger.Info("Connected to WebSocket server")

	// Trigger connect callback
	w.mu.RLock()
	onConnect := w.onConnect
	w.mu.RUnlock()
	if onConnect != nil {
		go onConnect()
	}

	return nil
}

// ConnectWithHost connects using host and port, constructing the WebSocket URL
func (w *WSClient) ConnectWithHost(host string, port int, path string) error {
	wsURL := fmt.Sprintf("ws://%s:%d%s", host, port, path)
	return w.Connect(wsURL)
}

// Disconnect closes the WebSocket connection
func (w *WSClient) Disconnect() {
	w.connMu.Lock()
	defer w.connMu.Unlock()

	if w.conn == nil {
		return
	}

	w.logger.Info("Disconnecting...")

	// Signal done to stop goroutines
	close(w.done)

	// Send close message
	w.conn.WriteMessage(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))

	// Close the connection
	w.conn.Close()
	w.conn = nil
	w.connected = false

	// Trigger disconnect callback
	w.mu.RLock()
	onDisconnect := w.onDisconnect
	w.mu.RUnlock()
	if onDisconnect != nil {
		go onDisconnect()
	}
}

// IsConnected returns whether the client is connected
func (w *WSClient) IsConnected() bool {
	w.connMu.Lock()
	defer w.connMu.Unlock()
	return w.connected && w.conn != nil
}

// Emit sends an event with payload to the server
func (w *WSClient) Emit(eventType string, payload interface{}) error {
	w.connMu.Lock()
	defer w.connMu.Unlock()

	if w.conn == nil {
		return fmt.Errorf("not connected")
	}

	msg := Message{
		Type: eventType,
	}

	// Marshal payload if provided
	if payload != nil {
		payloadBytes, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("failed to marshal payload: %w", err)
		}
		msg.Payload = payloadBytes
	}

	// Marshal the full message
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("failed to marshal message: %w", err)
	}

	// Send the message
	if err := w.conn.WriteMessage(websocket.TextMessage, data); err != nil {
		return fmt.Errorf("failed to send message: %w", err)
	}

	return nil
}

// EmitWithAck sends an event and waits for an acknowledgment
// The ack event type is expected to be eventType + "-ack"
func (w *WSClient) EmitWithAck(eventType string, payload interface{}, timeout time.Duration) (json.RawMessage, error) {
	ackChan := make(chan json.RawMessage, 1)
	ackEvent := eventType + "-ack"

	// Register temporary handler for ack
	w.On(ackEvent, func(payload json.RawMessage) {
		select {
		case ackChan <- payload:
		default:
		}
	})
	defer w.Off(ackEvent)

	// Send the event
	if err := w.Emit(eventType, payload); err != nil {
		return nil, err
	}

	// Wait for ack or timeout
	select {
	case ack := <-ackChan:
		return ack, nil
	case <-time.After(timeout):
		return nil, fmt.Errorf("timeout waiting for ack")
	}
}

// readLoop reads messages from the WebSocket and dispatches to handlers
func (w *WSClient) readLoop() {
	defer func() {
		w.connMu.Lock()
		if w.conn != nil {
			w.conn.Close()
			w.conn = nil
		}
		wasConnected := w.connected
		w.connected = false
		w.connMu.Unlock()

		if wasConnected {
			// Trigger disconnect callback
			w.mu.RLock()
			onDisconnect := w.onDisconnect
			w.mu.RUnlock()
			if onDisconnect != nil {
				go onDisconnect()
			}

			// Attempt reconnection if enabled
			w.mu.RLock()
			shouldReconnect := w.reconnect
			w.mu.RUnlock()
			if shouldReconnect {
				go w.attemptReconnect()
			}
		}
	}()

	for {
		select {
		case <-w.done:
			return
		default:
		}

		// Read message
		_, data, err := w.conn.ReadMessage()
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				w.logger.Info("Connection closed normally")
				return
			}
			w.logger.Error("Read error: %v", err)

			// Trigger error callback
			w.mu.RLock()
			onError := w.onError
			w.mu.RUnlock()
			if onError != nil {
				go onError(err)
			}
			return
		}

		// Parse message
		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			w.logger.Warn("Failed to parse message: %v", err)
			continue
		}

		// Dispatch to handlers
		w.dispatch(msg.Type, msg.Payload)
	}
}

// dispatch calls all registered handlers for an event type
func (w *WSClient) dispatch(eventType string, payload json.RawMessage) {
	w.mu.RLock()
	handlers := w.handlers[eventType]
	w.mu.RUnlock()

	if len(handlers) == 0 {
		return
	}

	for _, handler := range handlers {
		go handler(payload)
	}
}

// pingLoop sends periodic ping messages to keep the connection alive
func (w *WSClient) pingLoop() {
	ticker := time.NewTicker(w.pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-w.done:
			return
		case <-ticker.C:
			w.connMu.Lock()
			if w.conn != nil {
				if err := w.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					w.logger.Warn("Ping failed: %v", err)
				}
			}
			w.connMu.Unlock()
		}
	}
}

// attemptReconnect tries to reconnect to the server
func (w *WSClient) attemptReconnect() {
	w.mu.RLock()
	maxRetries := w.maxReconnectTry
	delay := w.reconnectDelay
	url := w.url
	w.mu.RUnlock()

	for i := 0; i < maxRetries; i++ {
		w.logger.Info("Reconnection attempt %d/%d...", i+1, maxRetries)

		time.Sleep(delay)

		if err := w.Connect(url); err == nil {
			w.logger.Info("Reconnected successfully")
			return
		}

		// Exponential backoff
		delay = delay * 2
		if delay > 30*time.Second {
			delay = 30 * time.Second
		}
	}

	w.logger.Error("Failed to reconnect after %d attempts", maxRetries)
}
