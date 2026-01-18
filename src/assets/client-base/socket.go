//
// Strux Client - WebSocket Client
//
// Handles WebSocket connection to the dev server.
// Uses the WSClient wrapper for event-based message handling.
//
// Events:
// - Client emits: "request-binary" to request the current binary
// - Server emits: "new-binary" with { data: Buffer } for binary updates
// - Server emits: "start-logs" with { streamId, type, service? }
// - Server emits: "stop-logs" with { streamId }
// - Client emits: "log-line" with { streamId, line, service?, timestamp }
// - Client emits: "log-stream-error" with { streamId, error }
//

package main

import (
	"encoding/base64"
	"encoding/json"
	"sync"
	"time"
)

// BinaryPayload represents the payload for binary updates
type BinaryPayload struct {
	Data string `json:"data"` // Base64 encoded binary data
}

// StartLogsPayload represents the payload for starting log streams
type StartLogsPayload struct {
	StreamID string `json:"streamId"`
	Type     string `json:"type"`    // "journalctl" or "service"
	Service  string `json:"service"` // service name if type is "service"
}

// StopLogsPayload represents the payload for stopping log streams
type StopLogsPayload struct {
	StreamID string `json:"streamId"`
}

// LogLinePayload represents a log line to send to the server
type LogLinePayload struct {
	StreamID  string `json:"streamId"`
	Line      string `json:"line"`
	Service   string `json:"service,omitempty"`
	Timestamp string `json:"timestamp"`
}

// LogErrorPayload represents a log stream error
type LogErrorPayload struct {
	StreamID string `json:"streamId"`
	Error    string `json:"error"`
}

// BinaryAckPayload represents the acknowledgment of a binary update
type BinaryAckPayload struct {
	Status           string `json:"status"`           // "skipped", "updated", "error"
	Message          string `json:"message"`          // Human-readable message
	CurrentChecksum  string `json:"currentChecksum"`  // Checksum of current binary on disk
	ReceivedChecksum string `json:"receivedChecksum"` // Checksum of received binary
}

// SocketClient handles WebSocket communication with the dev server
type SocketClient struct {
	ws         *WSClient
	clientKey  string
	logger     *Logger
	mu         sync.Mutex
	connected  bool
	host       Host
	logStreams *LogStreamer
}

// NewSocketClient creates a new WebSocket client
func NewSocketClient(clientKey string) *SocketClient {
	return &SocketClient{
		clientKey:  clientKey,
		logger:     NewLogger("SocketClient"),
		logStreams: NewLogStreamer(),
	}
}

// Connect establishes a WebSocket connection to the specified host
func (s *SocketClient) Connect(host Host) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.logger.Info("Connecting to %s:%d...", host.Host, host.Port)

	// Create WebSocket client
	ws := NewWSClient()

	// Set the client key header for authentication
	if s.clientKey != "" {
		ws.SetHeader("X-Client-Key", s.clientKey)
	}

	// Set up connection lifecycle callbacks
	ws.OnConnect(func() {
		s.mu.Lock()
		s.connected = true
		s.mu.Unlock()
		s.logger.Info("WebSocket connected")
	})

	ws.OnDisconnect(func() {
		s.mu.Lock()
		s.connected = false
		s.mu.Unlock()
		s.logger.Warn("WebSocket disconnected")
		s.logStreams.StopAll()
	})

	ws.OnError(func(err error) {
		s.logger.Error("WebSocket error: %v", err)
	})

	// Set up event handlers
	s.setupEventHandlers(ws)

	// Connect to the server
	// The server should expose a /ws endpoint for WebSocket connections
	if err := ws.ConnectWithHost(host.Host, host.Port, "/ws"); err != nil {
		return err
	}

	s.ws = ws
	s.host = host

	// Wait a moment for connection to establish
	time.Sleep(100 * time.Millisecond)

	s.connected = true
	s.logger.Info("Connected to WebSocket server")

	// Request the current binary
	s.RequestBinary()

	return nil
}

// setupEventHandlers registers all WebSocket event handlers
func (s *SocketClient) setupEventHandlers(ws *WSClient) {
	// Handle binary updates from server
	ws.On("new-binary", func(payload json.RawMessage) {
		var binaryPayload BinaryPayload
		if err := json.Unmarshal(payload, &binaryPayload); err != nil {
			s.logger.Error("Failed to parse binary payload: %v", err)
			return
		}
		s.handleBinaryUpdate(binaryPayload.Data)
	})

	// Handle start-logs event
	ws.On("start-logs", func(payload json.RawMessage) {
		var logsPayload StartLogsPayload
		if err := json.Unmarshal(payload, &logsPayload); err != nil {
			s.logger.Error("Failed to parse start-logs payload: %v", err)
			return
		}
		s.handleStartLogs(logsPayload)
	})

	// Handle stop-logs event
	ws.On("stop-logs", func(payload json.RawMessage) {
		var stopPayload StopLogsPayload
		if err := json.Unmarshal(payload, &stopPayload); err != nil {
			s.logger.Error("Failed to parse stop-logs payload: %v", err)
			return
		}
		s.handleStopLogs(stopPayload)
	})
}

// Disconnect closes the WebSocket connection
func (s *SocketClient) Disconnect() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.ws != nil {
		s.logger.Info("Disconnecting...")
		s.logStreams.StopAll()
		s.ws.Disconnect()
		s.ws = nil
		s.connected = false
	}
}

// IsConnected returns whether the client is connected
func (s *SocketClient) IsConnected() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.connected
}

// GetHost returns the currently connected host
func (s *SocketClient) GetHost() Host {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.host
}

// RequestBinary requests the current binary from the server
func (s *SocketClient) RequestBinary() {
	if s.ws == nil {
		s.logger.Error("Cannot request binary: not connected")
		return
	}

	s.logger.Info("Requesting binary from server...")

	// Emit request-binary event
	if err := s.ws.Emit("request-binary", nil); err != nil {
		s.logger.Error("Failed to request binary: %v", err)
	}
}

// SendLogLine sends a log line to the server
func (s *SocketClient) SendLogLine(streamID, line, service string) {
	if s.ws == nil {
		return
	}

	payload := LogLinePayload{
		StreamID:  streamID,
		Line:      line,
		Service:   service,
		Timestamp: time.Now().Format(time.RFC3339),
	}

	if err := s.ws.Emit("log-line", payload); err != nil {
		s.logger.Error("Failed to send log line: %v", err)
	}
}

// SendLogError sends a log stream error to the server
func (s *SocketClient) SendLogError(streamID string, errMsg string) {
	if s.ws == nil {
		return
	}

	payload := LogErrorPayload{
		StreamID: streamID,
		Error:    errMsg,
	}

	if err := s.ws.Emit("log-stream-error", payload); err != nil {
		s.logger.Error("Failed to send log error: %v", err)
	}
}

// SendBinaryAck sends a binary update acknowledgment to the server
func (s *SocketClient) SendBinaryAck(status, message, currentChecksum, receivedChecksum string) {
	if s.ws == nil {
		return
	}

	payload := BinaryAckPayload{
		Status:           status,
		Message:          message,
		CurrentChecksum:  currentChecksum,
		ReceivedChecksum: receivedChecksum,
	}

	if err := s.ws.Emit("binary-ack", payload); err != nil {
		s.logger.Error("Failed to send binary ack: %v", err)
	}
}

// handleBinaryUpdate handles a binary update from the server
func (s *SocketClient) handleBinaryUpdate(data string) {
	s.logger.Info("Received binary update")

	// Decode base64 data
	decoded, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		s.logger.Error("Failed to decode binary data: %v", err)
		s.SendBinaryAck("error", "Failed to decode binary data: "+err.Error(), "", "")
		return
	}

	s.logger.Info("Decoded binary: %d bytes", len(decoded))

	// Handle the binary update
	result := BinaryHandlerInstance.HandleUpdate(decoded)

	// Send acknowledgment to server
	s.SendBinaryAck(result.Status, result.Message, result.CurrentChecksum, result.ReceivedChecksum)

	if result.Status == "error" {
		s.logger.Error("Binary update failed: %s", result.Message)
	}
}

// handleStartLogs starts a log stream
func (s *SocketClient) handleStartLogs(payload StartLogsPayload) {
	s.logger.Info("Starting log stream: %s (type: %s, service: %s)", payload.StreamID, payload.Type, payload.Service)

	// Create callback to send log lines
	callback := func(line string) {
		s.SendLogLine(payload.StreamID, line, payload.Service)
	}

	var err error
	if payload.Type == "service" && payload.Service != "" {
		err = s.logStreams.StartServiceStream(payload.StreamID, payload.Service, callback)
	} else {
		err = s.logStreams.StartJournalctlStream(payload.StreamID, callback)
	}

	if err != nil {
		s.logger.Error("Failed to start log stream: %v", err)
		s.SendLogError(payload.StreamID, err.Error())
	}
}

// handleStopLogs stops a log stream
func (s *SocketClient) handleStopLogs(payload StopLogsPayload) {
	s.logger.Info("Stopping log stream: %s", payload.StreamID)
	s.logStreams.Stop(payload.StreamID)
}
