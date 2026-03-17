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
// - Server emits: "exec-start" with { sessionId, shell? }
// - Server emits: "exec-input" with { sessionId, data }
// - Client emits: "exec-output" with { sessionId, stream, data }
// - Client emits: "exec-exit" with { sessionId, code }
// - Client emits: "exec-error" with { sessionId, error }
//

package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
	Type     string `json:"type"`    // "journalctl", "service", "app", "cage", or "early"
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

// ExecStartPayload starts an interactive shell session
type ExecStartPayload struct {
	SessionID string `json:"sessionId"`
	Shell     string `json:"shell,omitempty"`
}

// ExecInputPayload sends input to an interactive shell session
type ExecInputPayload struct {
	SessionID string `json:"sessionId"`
	Data      string `json:"data"`
}

// ExecOutputPayload sends console output back to the server
type ExecOutputPayload struct {
	SessionID string `json:"sessionId"`
	Stream    string `json:"stream"`
	Data      string `json:"data"`
}

// ExecExitPayload notifies the server of session exit
type ExecExitPayload struct {
	SessionID string `json:"sessionId"`
	Code      int    `json:"code"`
}

// ExecErrorPayload reports an exec error
type ExecErrorPayload struct {
	SessionID string `json:"sessionId"`
	Error     string `json:"error"`
}

// BinaryAckPayload represents the acknowledgment of a binary update
type BinaryAckPayload struct {
	Status           string `json:"status"`           // "skipped", "updated", "error"
	Message          string `json:"message"`          // Human-readable message
	CurrentChecksum  string `json:"currentChecksum"`  // Checksum of current binary on disk
	ReceivedChecksum string `json:"receivedChecksum"` // Checksum of received binary
}

// ComponentPayload represents a component binary update from the server
type ComponentPayload struct {
	ComponentType string `json:"componentType"` // "cage", "wpe-extension", "client"
	Data          string `json:"data"`          // Base64 encoded binary data
	DestPath      string `json:"destPath"`      // Target filesystem path on device
}

// ComponentAckPayload represents the acknowledgment of a component update
type ComponentAckPayload struct {
	ComponentType string `json:"componentType"`
	Status        string `json:"status"`  // "updated", "error"
	Message       string `json:"message"`
}

// DeviceInfoInspectorPort describes one inspector port for one monitor path
type DeviceInfoInspectorPort struct {
	Path string `json:"path"`
	Port int    `json:"port"`
}

// DeviceInfoPayload reports device IP and inspector ports to the dev server
type DeviceInfoPayload struct {
	IP             string                    `json:"ip"`
	InspectorPorts []DeviceInfoInspectorPort `json:"inspectorPorts"`
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
	exec       *ExecManager
}

// NewSocketClient creates a new WebSocket client
func NewSocketClient(clientKey string) *SocketClient {
	client := &SocketClient{
		clientKey:  clientKey,
		logger:     NewLogger("SocketClient"),
		logStreams: NewLogStreamer(),
	}

	client.exec = NewExecManager(
		func(sessionID, stream, data string) {
			client.SendExecOutput(sessionID, stream, data)
		},
		func(sessionID string, code int) {
			client.SendExecExit(sessionID, code)
		},
		func(sessionID string, err error) {
			client.SendExecError(sessionID, err.Error())
		},
	)

	return client
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

	// Handle exec-start event
	ws.On("exec-start", func(payload json.RawMessage) {
		var execPayload ExecStartPayload
		if err := json.Unmarshal(payload, &execPayload); err != nil {
			s.logger.Error("Failed to parse exec-start payload: %v", err)
			return
		}
		s.handleExecStart(execPayload)
	})

	// Handle exec-input event
	ws.On("exec-input", func(payload json.RawMessage) {
		var inputPayload ExecInputPayload
		if err := json.Unmarshal(payload, &inputPayload); err != nil {
			s.logger.Error("Failed to parse exec-input payload: %v", err)
			return
		}
		s.handleExecInput(inputPayload)
	})

	// Handle new-component event (component binary updates)
	ws.On("new-component", func(payload json.RawMessage) {
		var componentPayload ComponentPayload
		if err := json.Unmarshal(payload, &componentPayload); err != nil {
			s.logger.Error("Failed to parse new-component payload: %v", err)
			return
		}
		s.handleComponentUpdate(componentPayload)
	})

	// Handle restart-service event
	ws.On("restart-service", func(payload json.RawMessage) {
		s.logger.Info("Strux service restart requested by server")
		go func() {
			cmd := exec.Command("systemctl", "restart", "strux")
			if err := cmd.Run(); err != nil {
				s.logger.Error("Failed to restart strux service: %v", err)
			} else {
				s.logger.Info("Strux service restarted")
			}
		}()
	})

	// Handle reboot event
	ws.On("reboot", func(payload json.RawMessage) {
		s.logger.Info("Reboot requested by server")
		if err := BinaryHandlerInstance.Reboot(); err != nil {
			s.logger.Error("Reboot failed: %v", err)
		}
	})
}

// Disconnect closes the WebSocket connection
func (s *SocketClient) Disconnect() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.ws != nil {
		s.logger.Info("Disconnecting...")
		s.logStreams.StopAll()
		s.exec.StopAll()
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

// SendExecOutput streams console output to the server
func (s *SocketClient) SendExecOutput(sessionID, stream, data string) {
	if s.ws == nil {
		return
	}

	payload := ExecOutputPayload{
		SessionID: sessionID,
		Stream:    stream,
		Data:      data,
	}

	if err := s.ws.Emit("exec-output", payload); err != nil {
		s.logger.Error("Failed to send exec output: %v", err)
	}
}

// SendExecExit sends session exit status to the server
func (s *SocketClient) SendExecExit(sessionID string, code int) {
	if s.ws == nil {
		return
	}

	payload := ExecExitPayload{
		SessionID: sessionID,
		Code:      code,
	}

	if err := s.ws.Emit("exec-exit", payload); err != nil {
		s.logger.Error("Failed to send exec exit: %v", err)
	}
}

// SendExecError sends exec error to the server
func (s *SocketClient) SendExecError(sessionID string, errMsg string) {
	if s.ws == nil {
		return
	}

	payload := ExecErrorPayload{
		SessionID: sessionID,
		Error:     errMsg,
	}

	if err := s.ws.Emit("exec-error", payload); err != nil {
		s.logger.Error("Failed to send exec error: %v", err)
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
	switch payload.Type {
	case "service":
		if payload.Service != "" {
			err = s.logStreams.StartServiceStream(payload.StreamID, payload.Service, callback)
		} else {
			err = s.logStreams.StartJournalctlStream(payload.StreamID, callback)
		}
	case "app":
		// Stream the user's Go app output from /tmp/strux-backend.log
		err = s.logStreams.StartAppLogStream(payload.StreamID, callback)
	case "cage":
		// Stream Cage/Cog output from /tmp/strux-cage.log
		err = s.logStreams.StartCageLogStream(payload.StreamID, callback)
	case "journalctl":
		err = s.logStreams.StartJournalctlStream(payload.StreamID, callback)
	case "early":
		err = s.logStreams.StartEarlyLogStream(payload.StreamID, callback)
	default:
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

func (s *SocketClient) handleExecStart(payload ExecStartPayload) {
	s.logger.Info("Starting exec session: %s", payload.SessionID)

	if err := s.exec.Start(payload.SessionID, payload.Shell); err != nil {
		s.logger.Error("Failed to start exec session: %v", err)
		s.SendExecError(payload.SessionID, err.Error())
	}
}

func (s *SocketClient) handleExecInput(payload ExecInputPayload) {
	if err := s.exec.SendInput(payload.SessionID, payload.Data); err != nil {
		s.logger.Error("Failed to send exec input: %v", err)
		s.SendExecError(payload.SessionID, err.Error())
	}
}

// handleComponentUpdate handles a component binary update from the server
func (s *SocketClient) handleComponentUpdate(payload ComponentPayload) {
	s.logger.Info("Received component update: %s -> %s", payload.ComponentType, payload.DestPath)

	// Decode base64 data
	decoded, err := base64.StdEncoding.DecodeString(payload.Data)
	if err != nil {
		s.logger.Error("Failed to decode component data: %v", err)
		s.SendComponentAck(payload.ComponentType, "error", "Failed to decode data: "+err.Error())
		return
	}

	s.logger.Info("Decoded component %s: %d bytes", payload.ComponentType, len(decoded))

	// Compute checksum for verification
	checksum := fmt.Sprintf("%x", sha256.Sum256(decoded))

	// Ensure parent directory exists
	parentDir := filepath.Dir(payload.DestPath)
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		s.logger.Error("Failed to create directory %s: %v", parentDir, err)
		s.SendComponentAck(payload.ComponentType, "error", "Failed to create directory: "+err.Error())
		return
	}

	// Write to temp file first for atomic replace
	tmpPath := payload.DestPath + ".tmp"
	if err := os.WriteFile(tmpPath, decoded, 0755); err != nil {
		s.logger.Error("Failed to write temp file: %v", err)
		s.SendComponentAck(payload.ComponentType, "error", "Failed to write temp file: "+err.Error())
		return
	}

	// Verify temp file checksum
	tmpData, err := os.ReadFile(tmpPath)
	if err != nil {
		os.Remove(tmpPath)
		s.logger.Error("Failed to read back temp file: %v", err)
		s.SendComponentAck(payload.ComponentType, "error", "Failed to verify temp file: "+err.Error())
		return
	}

	tmpChecksum := fmt.Sprintf("%x", sha256.Sum256(tmpData))
	if tmpChecksum != checksum {
		os.Remove(tmpPath)
		s.logger.Error("Checksum mismatch for %s", payload.ComponentType)
		s.SendComponentAck(payload.ComponentType, "error", "Checksum mismatch after write")
		return
	}

	// Atomic rename
	if err := os.Rename(tmpPath, payload.DestPath); err != nil {
		os.Remove(tmpPath)
		s.logger.Error("Failed to replace component file: %v", err)
		s.SendComponentAck(payload.ComponentType, "error", "Failed to replace file: "+err.Error())
		return
	}

	s.logger.Info("Component %s updated successfully at %s (checksum: %s)", payload.ComponentType, payload.DestPath, checksum[:16])
	s.SendComponentAck(payload.ComponentType, "updated", fmt.Sprintf("Component replaced at %s", payload.DestPath))
}

// SendComponentAck sends a component update acknowledgment to the server
func (s *SocketClient) SendComponentAck(componentType, status, message string) {
	if s.ws == nil {
		return
	}

	payload := ComponentAckPayload{
		ComponentType: componentType,
		Status:        status,
		Message:       message,
	}

	if err := s.ws.Emit("component-ack", payload); err != nil {
		s.logger.Error("Failed to send component ack: %v", err)
	}
}

// SendDeviceInfo reports device IP and inspector port assignments to the dev server
func (s *SocketClient) SendDeviceInfo(ip string, inspectorPorts []DeviceInfoInspectorPort) {
	if s.ws == nil {
		return
	}

	payload := DeviceInfoPayload{
		IP:             ip,
		InspectorPorts: inspectorPorts,
	}

	s.logger.Info("Sending device info: IP=%s, inspectorPorts=%d", ip, len(inspectorPorts))

	if err := s.ws.Emit("device-info", payload); err != nil {
		s.logger.Error("Failed to send device info: %v", err)
	}
}
