//
// Strux Client - WebSocket Client
//
// Handles WebSocket connection to the dev server.
// Uses the WSClient wrapper for event-based message handling.
//
// Message types (aligned with ndev/types.ts):
//
// Server → Client:
//   - "binary-new"           { data: string }
//   - "component"            { data: string, destPath: string }
//   - "device-info-requested"
//   - "ssh-start"            { sessionID: string, shell: string }
//   - "ssh-input"            { sessionID: string, data: string }
//   - "ssh-exit"             { sessionID: string }
//   - "system-restart"
//   - "system-restart-strux"
//   - "screen-request"       { outputName, serverHostURL }
//   - "screen-picture"       { outputName }
//
// Client → Server:
//   - "binary-requested"
//   - "binary-ack"           { status, binary, currentChecksum?, receivedChecksum? }
//   - "component-ack"        { status, message, destPath }
//   - "device-info"          { ip, inspectorPorts, outputs? }
//   - "log-line"             { type, line, timestamp }
//   - "ssh-output"           { sessionID, data }
//   - "ssh-exit-received"    { sessionID, code }
//   - "screen-picture-received" { outputName, data, width, height }
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

// LogLinePayload represents a log line to send to the server
type LogLinePayload struct {
	Type      string `json:"type"`      // "journalctl", "service", "app", "cage", "screen", "early", "client"
	Line      string `json:"line"`
	Timestamp string `json:"timestamp"`
}

// SSHStartPayload starts an interactive shell session
type SSHStartPayload struct {
	SessionID string `json:"sessionID"`
	Shell     string `json:"shell,omitempty"`
	Rows      int    `json:"rows,omitempty"`
	Cols      int    `json:"cols,omitempty"`
}

// SSHResizePayload resizes a PTY session
type SSHResizePayload struct {
	SessionID string `json:"sessionID"`
	Rows      int    `json:"rows"`
	Cols      int    `json:"cols"`
}

// SSHInputPayload sends input to an interactive shell session
type SSHInputPayload struct {
	SessionID string `json:"sessionID"`
	Data      string `json:"data"`
}

// SSHOutputPayload sends console output back to the server
type SSHOutputPayload struct {
	SessionID string `json:"sessionID"`
	Data      string `json:"data"`
}

// SSHExitReceivedPayload notifies the server of session exit
type SSHExitReceivedPayload struct {
	SessionID string `json:"sessionID"`
	Code      int    `json:"code"`
}

// BinaryAckPayload represents the acknowledgment of a binary update
type BinaryAckPayload struct {
	Status           string `json:"status"`                     // "skipped", "updated", "error"
	Binary           string `json:"binary"`                     // Binary name/path
	CurrentChecksum  string `json:"currentChecksum,omitempty"`  // Checksum of current binary on disk
	ReceivedChecksum string `json:"receivedChecksum,omitempty"` // Checksum of received binary
}

// ComponentPayload represents a component file update from the server
type ComponentPayload struct {
	Data     string `json:"data"`     // Base64 encoded binary data
	DestPath string `json:"destPath"` // Target filesystem path on device
}

// ComponentAckPayload represents the acknowledgment of a component update
type ComponentAckPayload struct {
	Status   string `json:"status"`   // "updated", "error"
	Message  string `json:"message"`
	DestPath string `json:"destPath"`
}

// DeviceInfoInspectorPort describes one inspector port for one monitor path
type DeviceInfoInspectorPort struct {
	Path string `json:"path"`
	Port int    `json:"port"`
}

// OutputInfo describes a connected display output
type OutputInfo struct {
	Name  string `json:"name"`
	Label string `json:"label,omitempty"`
}

// DeviceInfoPayload reports device IP and inspector ports to the dev server
type DeviceInfoPayload struct {
	IP             string                    `json:"ip"`
	InspectorPorts []DeviceInfoInspectorPort `json:"inspectorPorts"`
	Outputs        []OutputInfo              `json:"outputs,omitempty"`
	Version        string                    `json:"version"`
}

// SocketClient handles WebSocket communication with the dev server
type SocketClient struct {
	ws              *WSClient
	clientKey       string
	logger          *Logger
	mu              sync.Mutex
	connected       bool
	hasConnected    bool // true after first successful connection (to detect reconnections)
	host            Host
	logStreams      *LogStreamer
	exec            *ExecManager
	screen          *ScreenManager
	onReconnect     func() // called on reconnection so main.go can re-send device info
	onDeviceInfoReq func() // called when server requests device info
}

// NewSocketClient creates a new WebSocket client
func NewSocketClient(clientKey string) *SocketClient {
	client := &SocketClient{
		clientKey:  clientKey,
		logger:     NewLogger("SocketClient"),
		logStreams: NewLogStreamer(),
	}

	client.exec = NewExecManager(
		func(sessionID, data string) {
			client.SendSSHOutput(sessionID, data)
		},
		func(sessionID string, code int) {
			client.SendSSHExitReceived(sessionID, code)
		},
	)

	client.screen = NewScreenManager(
		func(payload ScreenReadyPayload) {
			client.SendScreenReady(payload)
		},
		func(payload ScreenStoppedPayload) {
			client.SendScreenStopped(payload)
		},
		func(payload ScreenErrorPayload) {
			client.SendScreenError(payload)
		},
		func(payload ScreenScreenshotResultPayload) {
			client.SendScreenScreenshot(payload)
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

	// Set protocol version and client key as query params
	ws.SetQueryParam("v", "0.3.0")
	if s.clientKey != "" {
		ws.SetQueryParam("key", s.clientKey)
	}

	// Set up connection lifecycle callbacks
	ws.OnConnect(func() {
		s.mu.Lock()
		reconnecting := s.hasConnected
		s.connected = true
		s.hasConnected = true
		s.mu.Unlock()
		s.logger.Info("WebSocket connected")

		// Auto-start log streams on every connect
		s.startAutoLogStreams()

		// On reconnection, re-request binary
		if reconnecting {
			s.logger.Info("Re-initializing after reconnection...")
			s.RequestBinary()
		}
		// Always notify so main.go can (re-)send device info
		if s.onReconnect != nil {
			s.onReconnect()
		}
	})

	ws.OnDisconnect(func() {
		s.mu.Lock()
		s.connected = false
		s.mu.Unlock()
		s.logger.Warn("WebSocket disconnected")
		s.logStreams.StopAll()
		s.screen.StopAll()
	})

	ws.OnError(func(err error) {
		s.logger.Error("WebSocket error: %v", err)
	})

	// Set up event handlers
	s.setupEventHandlers(ws)

	// Connect to the server on the /client path
	if err := ws.ConnectWithHost(host.Host, host.Port, "/client"); err != nil {
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
	ws.On("binary-new", func(payload json.RawMessage) {
		var binaryPayload BinaryPayload
		if err := json.Unmarshal(payload, &binaryPayload); err != nil {
			s.logger.Error("Failed to parse binary-new payload: %v", err)
			return
		}
		s.handleBinaryUpdate(binaryPayload.Data)
	})

	// Handle ssh-start event
	ws.On("ssh-start", func(payload json.RawMessage) {
		var sshPayload SSHStartPayload
		if err := json.Unmarshal(payload, &sshPayload); err != nil {
			s.logger.Error("Failed to parse ssh-start payload: %v", err)
			return
		}
		s.handleSSHStart(sshPayload)
	})

	// Handle ssh-resize event
	ws.On("ssh-resize", func(payload json.RawMessage) {
		var resizePayload SSHResizePayload
		if err := json.Unmarshal(payload, &resizePayload); err != nil {
			s.logger.Error("Failed to parse ssh-resize payload: %v", err)
			return
		}
		s.exec.Resize(resizePayload.SessionID, resizePayload.Rows, resizePayload.Cols)
	})

	// Handle ssh-input event
	ws.On("ssh-input", func(payload json.RawMessage) {
		var inputPayload SSHInputPayload
		if err := json.Unmarshal(payload, &inputPayload); err != nil {
			s.logger.Error("Failed to parse ssh-input payload: %v", err)
			return
		}
		s.handleSSHInput(inputPayload)
	})

	// Handle ssh-exit event (server wants to end a session)
	ws.On("ssh-exit", func(payload json.RawMessage) {
		var exitPayload struct {
			SessionID string `json:"sessionID"`
		}
		if err := json.Unmarshal(payload, &exitPayload); err != nil {
			s.logger.Error("Failed to parse ssh-exit payload: %v", err)
			return
		}
		s.exec.Stop(exitPayload.SessionID)
	})

	// Handle component event
	ws.On("component", func(payload json.RawMessage) {
		var componentPayload ComponentPayload
		if err := json.Unmarshal(payload, &componentPayload); err != nil {
			s.logger.Error("Failed to parse component payload: %v", err)
			return
		}
		s.handleComponentUpdate(componentPayload)
	})

	// Handle system-restart-strux event
	ws.On("system-restart-strux", func(payload json.RawMessage) {
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

	// Handle system-restart event (full reboot)
	ws.On("system-restart", func(payload json.RawMessage) {
		s.logger.Info("System reboot requested by server")
		if err := BinaryHandlerInstance.Reboot(); err != nil {
			s.logger.Error("Reboot failed: %v", err)
		}
	})

	// Handle device-info-requested from server
	ws.On("device-info-requested", func(payload json.RawMessage) {
		s.logger.Info("Server requested device info")
		if s.onDeviceInfoReq != nil {
			s.onDeviceInfoReq()
		}
	})

	// Handle screen-request event
	ws.On("screen-request", func(payload json.RawMessage) {
		var screenPayload ScreenStartPayload
		if err := json.Unmarshal(payload, &screenPayload); err != nil {
			s.logger.Error("Failed to parse screen-request payload: %v", err)
			return
		}
		s.handleScreenStart(screenPayload)
	})

	// Handle screen-picture event (screenshot request)
	ws.On("screen-picture", func(payload json.RawMessage) {
		var screenPayload ScreenScreenshotPayload
		if err := json.Unmarshal(payload, &screenPayload); err != nil {
			s.logger.Error("Failed to parse screen-picture payload: %v", err)
			return
		}
		s.handleScreenScreenshot(screenPayload)
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
		s.screen.StopAll()
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

	if err := s.ws.Emit("binary-requested", nil); err != nil {
		s.logger.Error("Failed to request binary: %v", err)
	}
}

// SendLogLine sends a log line to the server
func (s *SocketClient) SendLogLine(logType, line string) {
	if s.ws == nil {
		return
	}

	payload := LogLinePayload{
		Type:      logType,
		Line:      line,
		Timestamp: time.Now().Format(time.RFC3339),
	}

	if err := s.ws.Emit("log-line", payload); err != nil {
		s.logger.Error("Failed to send log line: %v", err)
	}
}

// SendBinaryAck sends a binary update acknowledgment to the server
func (s *SocketClient) SendBinaryAck(status, currentChecksum, receivedChecksum string) {
	if s.ws == nil {
		return
	}

	payload := BinaryAckPayload{
		Status:           status,
		Binary:           binaryPath,
		CurrentChecksum:  currentChecksum,
		ReceivedChecksum: receivedChecksum,
	}

	if err := s.ws.Emit("binary-ack", payload); err != nil {
		s.logger.Error("Failed to send binary ack: %v", err)
	}
}

// SendSSHOutput streams console output to the server
func (s *SocketClient) SendSSHOutput(sessionID, data string) {
	if s.ws == nil {
		return
	}

	payload := SSHOutputPayload{
		SessionID: sessionID,
		Data:      data,
	}

	if err := s.ws.Emit("ssh-output", payload); err != nil {
		s.logger.Error("Failed to send ssh output: %v", err)
	}
}

// SendSSHExitReceived sends session exit status to the server
func (s *SocketClient) SendSSHExitReceived(sessionID string, code int) {
	if s.ws == nil {
		return
	}

	payload := SSHExitReceivedPayload{
		SessionID: sessionID,
		Code:      code,
	}

	if err := s.ws.Emit("ssh-exit-received", payload); err != nil {
		s.logger.Error("Failed to send ssh exit: %v", err)
	}
}

// handleBinaryUpdate handles a binary update from the server
func (s *SocketClient) handleBinaryUpdate(data string) {
	s.logger.Info("Received binary update")

	// Decode base64 data
	decoded, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		s.logger.Error("Failed to decode binary data: %v", err)
		s.SendBinaryAck("error", "", "")
		return
	}

	s.logger.Info("Decoded binary: %d bytes", len(decoded))

	// Handle the binary update
	result := BinaryHandlerInstance.HandleUpdate(decoded)

	// Send acknowledgment to server
	s.SendBinaryAck(result.Status, result.CurrentChecksum, result.ReceivedChecksum)

	if result.Status == "error" {
		s.logger.Error("Binary update failed: %s", result.Message)
	}
}

// startAutoLogStreams starts all log streams automatically on connect
func (s *SocketClient) startAutoLogStreams() {
	s.logger.Info("Auto-starting log streams...")

	logTypes := []struct {
		logType string
		starter func(string, LogCallback) error
	}{
		{"journalctl", s.logStreams.StartJournalctlStream},
		{"app", s.logStreams.StartAppLogStream},
		{"cage", s.logStreams.StartCageLogStream},
		{"early", s.logStreams.StartEarlyLogStream},
	}

	for _, lt := range logTypes {
		streamID := fmt.Sprintf("auto-%s-%d", lt.logType, time.Now().UnixMilli())
		logType := lt.logType
		err := lt.starter(streamID, func(line string) {
			s.SendLogLine(logType, line)
		})
		if err != nil {
			s.logger.Warn("Failed to start %s log stream: %v", lt.logType, err)
		}
	}
}

// handleSSHStart starts or attaches to an SSH/PTY session
func (s *SocketClient) handleSSHStart(payload SSHStartPayload) {
	s.logger.Info("SSH start requested: %s", payload.SessionID)

	// Try to attach to an existing session first
	if s.exec.AttachToExisting(payload.SessionID) {
		s.logger.Info("Attached to existing PTY session: %s", payload.SessionID)
		// Resize to match requested dimensions
		if payload.Rows > 0 && payload.Cols > 0 {
			s.exec.Resize(payload.SessionID, payload.Rows, payload.Cols)
		}
		return
	}

	// No existing session, start a new one
	if err := s.exec.Start(payload.SessionID, payload.Shell); err != nil {
		s.logger.Error("Failed to start SSH session: %v", err)
		return
	}

	// Set initial PTY size
	if payload.Rows > 0 && payload.Cols > 0 {
		s.exec.Resize(payload.SessionID, payload.Rows, payload.Cols)
	}
}

// handleSSHInput sends input to an SSH/PTY session
func (s *SocketClient) handleSSHInput(payload SSHInputPayload) {
	if err := s.exec.SendInput(payload.SessionID, payload.Data); err != nil {
		s.logger.Error("Failed to send SSH input: %v", err)
	}
}

// handleComponentUpdate handles a component file update from the server
func (s *SocketClient) handleComponentUpdate(payload ComponentPayload) {
	s.logger.Info("Received component update -> %s", payload.DestPath)

	// Decode base64 data
	decoded, err := base64.StdEncoding.DecodeString(payload.Data)
	if err != nil {
		s.logger.Error("Failed to decode component data: %v", err)
		s.SendComponentAck("error", "Failed to decode data: "+err.Error(), payload.DestPath)
		return
	}

	s.logger.Info("Decoded component: %d bytes -> %s", len(decoded), payload.DestPath)

	// Compute checksum for verification
	checksum := fmt.Sprintf("%x", sha256.Sum256(decoded))

	// Ensure parent directory exists
	parentDir := filepath.Dir(payload.DestPath)
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		s.logger.Error("Failed to create directory %s: %v", parentDir, err)
		s.SendComponentAck("error", "Failed to create directory: "+err.Error(), payload.DestPath)
		return
	}

	// Write to temp file first for atomic replace
	tmpPath := payload.DestPath + ".tmp"
	if err := os.WriteFile(tmpPath, decoded, 0755); err != nil {
		s.logger.Error("Failed to write temp file: %v", err)
		s.SendComponentAck("error", "Failed to write temp file: "+err.Error(), payload.DestPath)
		return
	}

	// Verify temp file checksum
	tmpData, err := os.ReadFile(tmpPath)
	if err != nil {
		os.Remove(tmpPath)
		s.logger.Error("Failed to read back temp file: %v", err)
		s.SendComponentAck("error", "Failed to verify temp file: "+err.Error(), payload.DestPath)
		return
	}

	tmpChecksum := fmt.Sprintf("%x", sha256.Sum256(tmpData))
	if tmpChecksum != checksum {
		os.Remove(tmpPath)
		s.logger.Error("Checksum mismatch for %s", payload.DestPath)
		s.SendComponentAck("error", "Checksum mismatch after write", payload.DestPath)
		return
	}

	// Atomic rename
	if err := os.Rename(tmpPath, payload.DestPath); err != nil {
		os.Remove(tmpPath)
		s.logger.Error("Failed to replace component file: %v", err)
		s.SendComponentAck("error", "Failed to replace file: "+err.Error(), payload.DestPath)
		return
	}

	s.logger.Info("Component updated at %s (checksum: %s)", payload.DestPath, checksum[:16])
	s.SendComponentAck("updated", fmt.Sprintf("Updated at %s", payload.DestPath), payload.DestPath)
}

// SendComponentAck sends a component update acknowledgment to the server
func (s *SocketClient) SendComponentAck(status, message, destPath string) {
	if s.ws == nil {
		return
	}

	payload := ComponentAckPayload{
		Status:   status,
		Message:  message,
		DestPath: destPath,
	}

	if err := s.ws.Emit("component-ack", payload); err != nil {
		s.logger.Error("Failed to send component ack: %v", err)
	}
}

// SendDeviceInfo reports device IP and inspector port assignments to the dev server
func (s *SocketClient) SendDeviceInfo(ip string, inspectorPorts []DeviceInfoInspectorPort, outputs []OutputInfo) {
	if s.ws == nil {
		return
	}

	payload := DeviceInfoPayload{
		IP:             ip,
		InspectorPorts: inspectorPorts,
		Outputs:        outputs,
		Version:        Version,
	}

	s.logger.Info("Sending device info: IP=%s, inspectorPorts=%d, outputs=%d", ip, len(inspectorPorts), len(outputs))

	if err := s.ws.Emit("device-info", payload); err != nil {
		s.logger.Error("Failed to send device info: %v", err)
	}
}

// handleScreenStart starts screen streaming for an output
func (s *SocketClient) handleScreenStart(payload ScreenStartPayload) {
	s.logger.Info("Starting screen stream for output: %s", payload.OutputName)
	s.screen.SetHost(s.host.Host, s.host.Port, s.clientKey)
	if err := s.screen.Start(payload.OutputName); err != nil {
		s.logger.Error("Failed to start screen stream: %v", err)
		s.SendScreenError(ScreenErrorPayload{
			OutputName: payload.OutputName,
			Error:      err.Error(),
		})
	}
}

// handleScreenScreenshot requests a screenshot from an output
func (s *SocketClient) handleScreenScreenshot(payload ScreenScreenshotPayload) {
	s.logger.Info("Screenshot requested for output: %s", payload.OutputName)
	s.screen.RequestScreenshot(payload.OutputName)
}

// SendScreenReady notifies the server that a screen stream is ready
func (s *SocketClient) SendScreenReady(payload ScreenReadyPayload) {
	if s.ws == nil {
		return
	}
	if err := s.ws.Emit("screen-ready", payload); err != nil {
		s.logger.Error("Failed to send screen-ready: %v", err)
	}
}

// SendScreenStopped notifies the server that a screen stream has stopped
func (s *SocketClient) SendScreenStopped(payload ScreenStoppedPayload) {
	if s.ws == nil {
		return
	}
	if err := s.ws.Emit("screen-stopped", payload); err != nil {
		s.logger.Error("Failed to send screen-stopped: %v", err)
	}
}

// SendScreenError sends a screen error to the server
func (s *SocketClient) SendScreenError(payload ScreenErrorPayload) {
	if s.ws == nil {
		return
	}
	if err := s.ws.Emit("screen-error", payload); err != nil {
		s.logger.Error("Failed to send screen-error: %v", err)
	}
}

// SendScreenScreenshot sends a screenshot result to the server
func (s *SocketClient) SendScreenScreenshot(payload ScreenScreenshotResultPayload) {
	if s.ws == nil {
		return
	}
	if err := s.ws.Emit("screen-picture-received", payload); err != nil {
		s.logger.Error("Failed to send screenshot result: %v", err)
	}
}
