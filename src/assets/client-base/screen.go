//
// Strux Client - Screen Manager
//
// Manages strux-screen daemon processes for remote screen streaming.
// Each output gets its own daemon instance. H.264 encoded frames are
// forwarded over a dedicated binary WebSocket connection (/ws/screen).
//

package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ScreenStartPayload is sent by the server to start streaming an output
type ScreenStartPayload struct {
	OutputName string `json:"outputName"`
}

// ScreenStopPayload is sent by the server to stop streaming an output
type ScreenStopPayload struct {
	OutputName string `json:"outputName"`
}

// ScreenScreenshotPayload is sent by the server to request a screenshot
type ScreenScreenshotPayload struct {
	OutputName string `json:"outputName"`
}

// ScreenReadyPayload is sent to the server when a stream is ready
type ScreenReadyPayload struct {
	OutputName string `json:"outputName"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	Encoder    string `json:"encoder"`
	FPS        int    `json:"fps"`
}

// ScreenStoppedPayload is sent to the server when a stream stops
type ScreenStoppedPayload struct {
	OutputName string `json:"outputName"`
}

// ScreenErrorPayload is sent to the server when an error occurs
type ScreenErrorPayload struct {
	OutputName string `json:"outputName"`
	Error      string `json:"error"`
}

// ScreenScreenshotResultPayload is sent to the server with screenshot data
type ScreenScreenshotResultPayload struct {
	OutputName string `json:"outputName"`
	Data       string `json:"data"` // base64 JPEG
	Width      int    `json:"width"`
	Height     int    `json:"height"`
}

// screenDaemonMessage represents a JSON control message from the daemon
type screenDaemonMessage struct {
	Type    string `json:"type"`
	Width   int    `json:"width,omitempty"`
	Height  int    `json:"height,omitempty"`
	Encoder string `json:"encoder,omitempty"`
	FPS     int    `json:"fps,omitempty"`
	Message string `json:"message,omitempty"`
	Data    string `json:"data,omitempty"`
}

// frameHeader matches the binary frame header from the strux-screen daemon
type frameHeader struct {
	Length    uint32
	MsgType  uint8
	Timestamp uint64
	IsKeyframe uint8
}

const frameHeaderSize = 14 // 4 + 1 + 8 + 1

// ScreenSession represents one screen daemon + connection
type ScreenSession struct {
	outputName  string
	outputIndex uint8
	process     *exec.Cmd
	socketConn  net.Conn
	done        chan struct{}
}

// ScreenManager manages screen capture daemon sessions
type ScreenManager struct {
	sessions    map[string]*ScreenSession
	mu          sync.Mutex
	logger      *Logger
	outputIndex uint8

	// Binary WebSocket for frame data
	screenWS     *websocket.Conn
	screenWSMu   sync.Mutex
	screenWSHost string
	screenWSPort int
	clientKey    string

	// Callbacks for control events
	onReady      func(payload ScreenReadyPayload)
	onStopped    func(payload ScreenStoppedPayload)
	onError      func(payload ScreenErrorPayload)
	onScreenshot func(payload ScreenScreenshotResultPayload)
}

// NewScreenManager creates a new screen manager
func NewScreenManager(
	onReady func(ScreenReadyPayload),
	onStopped func(ScreenStoppedPayload),
	onError func(ScreenErrorPayload),
	onScreenshot func(ScreenScreenshotResultPayload),
) *ScreenManager {
	return &ScreenManager{
		sessions:     make(map[string]*ScreenSession),
		logger:       NewLogger("ScreenManager"),
		onReady:      onReady,
		onStopped:    onStopped,
		onError:      onError,
		onScreenshot: onScreenshot,
	}
}

// SetHost sets the dev server host for the binary WebSocket connection
func (m *ScreenManager) SetHost(host string, port int, clientKey string) {
	m.screenWSHost = host
	m.screenWSPort = port
	m.clientKey = clientKey
}

// ensureScreenWS opens the dedicated /ws/screen binary WebSocket if not already open
func (m *ScreenManager) ensureScreenWS() error {
	m.screenWSMu.Lock()
	defer m.screenWSMu.Unlock()

	if m.screenWS != nil {
		return nil
	}

	wsURL := fmt.Sprintf("ws://%s:%d/ws/screen", m.screenWSHost, m.screenWSPort)
	m.logger.Info("Opening screen WebSocket: %s", wsURL)

	headers := http.Header{}
	if m.clientKey != "" {
		headers.Set("X-Client-Key", m.clientKey)
	}

	conn, _, err := websocket.DefaultDialer.Dial(wsURL, headers)
	if err != nil {
		return fmt.Errorf("failed to connect screen WebSocket: %w", err)
	}

	m.screenWS = conn

	// Start a read loop to handle pings/pongs (we only write on this connection)
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				m.screenWSMu.Lock()
				m.screenWS = nil
				m.screenWSMu.Unlock()
				m.logger.Warn("Screen WebSocket closed: %v", err)
				return
			}
		}
	}()

	return nil
}

// sendFrame sends an encoded H.264 frame over the binary WebSocket
func (m *ScreenManager) sendFrame(outputIndex uint8, timestamp uint64,
	isKeyframe bool, data []byte) {
	m.screenWSMu.Lock()
	ws := m.screenWS
	m.screenWSMu.Unlock()

	if ws == nil {
		return
	}

	// Binary frame format: [1-byte output index][8-byte timestamp][1-byte keyframe][H.264 data]
	buf := make([]byte, 10+len(data))
	buf[0] = outputIndex
	binary.BigEndian.PutUint64(buf[1:9], timestamp)
	if isKeyframe {
		buf[9] = 1
	} else {
		buf[9] = 0
	}
	copy(buf[10:], data)

	m.screenWSMu.Lock()
	err := m.screenWS.WriteMessage(websocket.BinaryMessage, buf)
	m.screenWSMu.Unlock()

	if err != nil {
		m.logger.Error("Failed to send frame: %v", err)
	}
}

// closeScreenWS closes the dedicated binary WebSocket
func (m *ScreenManager) closeScreenWS() {
	m.screenWSMu.Lock()
	defer m.screenWSMu.Unlock()

	if m.screenWS != nil {
		m.screenWS.Close()
		m.screenWS = nil
	}
}

// Start starts a screen capture daemon for the given output.
// If the daemon is already running, just ensures the binary WebSocket is connected.
// The read loop is already forwarding frames — they just need somewhere to go.
func (m *ScreenManager) Start(outputName string) error {
	// Ensure the binary WebSocket is open (may need reconnecting after server restart)
	if err := m.ensureScreenWS(); err != nil {
		return fmt.Errorf("failed to open screen WebSocket: %w", err)
	}

	m.mu.Lock()
	_, exists := m.sessions[outputName]
	m.mu.Unlock()

	if exists {
		m.logger.Info("Session already running for %s, WebSocket reconnected", outputName)
		return nil
	}

	socketPath := fmt.Sprintf("/tmp/strux-screen-%s.sock", outputName)

	// Start the daemon process
	cmd := exec.Command("/usr/bin/strux-screen",
		"--output", outputName,
		"--socket", socketPath)

	// Redirect daemon stderr to log file for debugging
	logFile, err := os.OpenFile("/tmp/strux-screen.log", os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err == nil {
		cmd.Stderr = logFile
	}
	cmd.Stdout = nil

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start strux-screen: %w", err)
	}

	m.logger.Info("Started strux-screen daemon for output %s (PID %d)",
		outputName, cmd.Process.Pid)

	// Wait for the socket to appear
	var conn net.Conn
	for i := 0; i < 50; i++ { // 5 seconds max
		time.Sleep(100 * time.Millisecond)
		c, err := net.Dial("unix", socketPath)
		if err == nil {
			conn = c
			break
		}
	}

	if conn == nil {
		cmd.Process.Kill()
		return fmt.Errorf("daemon socket did not appear: %s", socketPath)
	}

	m.mu.Lock()
	idx := m.outputIndex
	m.outputIndex++

	session := &ScreenSession{
		outputName:  outputName,
		outputIndex: idx,
		process:     cmd,
		socketConn:  conn,
		done:        make(chan struct{}),
	}
	m.sessions[outputName] = session
	m.mu.Unlock()

	// Start read loop for daemon messages
	go m.readLoop(session)

	// Start process wait loop
	go m.waitLoop(session)

	// Send start command to daemon
	m.sendDaemonCommand(session, `{"type":"start"}`)

	return nil
}

// Stop stops a screen capture daemon for the given output
func (m *ScreenManager) Stop(outputName string) {
	m.mu.Lock()
	session, exists := m.sessions[outputName]
	if exists {
		delete(m.sessions, outputName)
	}
	m.mu.Unlock()

	if !exists {
		return
	}

	// Send stop command
	m.sendDaemonCommand(session, `{"type":"stop"}`)

	// Close socket and kill process
	close(session.done)
	if session.socketConn != nil {
		session.socketConn.Close()
	}
	if session.process != nil && session.process.Process != nil {
		session.process.Process.Kill()
	}

	m.logger.Info("Stopped screen session for output %s", outputName)

	if m.onStopped != nil {
		m.onStopped(ScreenStoppedPayload{OutputName: outputName})
	}

	// Close binary WebSocket if no more sessions
	m.mu.Lock()
	remaining := len(m.sessions)
	m.mu.Unlock()
	if remaining == 0 {
		m.closeScreenWS()
	}
}

// StopAll stops all screen capture sessions
func (m *ScreenManager) StopAll() {
	m.mu.Lock()
	names := make([]string, 0, len(m.sessions))
	for name := range m.sessions {
		names = append(names, name)
	}
	m.mu.Unlock()

	for _, name := range names {
		m.Stop(name)
	}
}

// RequestScreenshot sends a screenshot request to the daemon
func (m *ScreenManager) RequestScreenshot(outputName string) {
	m.mu.Lock()
	session, exists := m.sessions[outputName]
	m.mu.Unlock()

	if !exists {
		// Start daemon temporarily for screenshot
		m.logger.Warn("No active session for %s, cannot take screenshot", outputName)
		if m.onError != nil {
			m.onError(ScreenErrorPayload{
				OutputName: outputName,
				Error:      "No active screen session",
			})
		}
		return
	}

	m.sendDaemonCommand(session, `{"type":"screenshot"}`)
}

// sendDaemonCommand sends a newline-delimited JSON command to the daemon
func (m *ScreenManager) sendDaemonCommand(session *ScreenSession, cmd string) {
	if session.socketConn == nil {
		return
	}
	_, err := session.socketConn.Write([]byte(cmd + "\n"))
	if err != nil {
		m.logger.Error("Failed to send command to daemon: %v", err)
	}
}

// readLoop reads messages from the daemon's Unix socket
func (m *ScreenManager) readLoop(session *ScreenSession) {
	reader := bufio.NewReader(session.socketConn)

	for {
		select {
		case <-session.done:
			return
		default:
		}

		// Read the frame header
		headerBuf := make([]byte, frameHeaderSize)
		if _, err := io.ReadFull(reader, headerBuf); err != nil {
			select {
			case <-session.done:
				return
			default:
			}
			m.logger.Error("Failed to read header from daemon: %v", err)
			return
		}

		hdr := frameHeader{
			Length:     binary.LittleEndian.Uint32(headerBuf[0:4]),
			MsgType:   headerBuf[4],
			Timestamp:  binary.LittleEndian.Uint64(headerBuf[5:13]),
			IsKeyframe: headerBuf[13],
		}

		// Read the payload
		payload := make([]byte, hdr.Length)
		if _, err := io.ReadFull(reader, payload); err != nil {
			m.logger.Error("Failed to read payload from daemon: %v", err)
			return
		}

		if hdr.MsgType == 0 {
			// Control message (JSON)
			m.handleDaemonControl(session, payload)
		} else if hdr.MsgType == 1 {
			// Frame data — forward over binary WebSocket
			m.sendFrame(session.outputIndex, hdr.Timestamp,
				hdr.IsKeyframe != 0, payload)
		}
	}
}

// handleDaemonControl processes a JSON control message from the daemon
func (m *ScreenManager) handleDaemonControl(session *ScreenSession,
	data []byte) {
	var msg screenDaemonMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		m.logger.Error("Failed to parse daemon control message: %v", err)
		return
	}

	switch msg.Type {
	case "ready":
		m.logger.Info("Stream ready for %s: %dx%d@%dfps encoder=%s",
			session.outputName, msg.Width, msg.Height, msg.FPS, msg.Encoder)
		if m.onReady != nil {
			m.onReady(ScreenReadyPayload{
				OutputName: session.outputName,
				Width:      msg.Width,
				Height:     msg.Height,
				Encoder:    msg.Encoder,
				FPS:        msg.FPS,
			})
		}

	case "error":
		m.logger.Error("Daemon error for %s: %s", session.outputName, msg.Message)
		if m.onError != nil {
			m.onError(ScreenErrorPayload{
				OutputName: session.outputName,
				Error:      msg.Message,
			})
		}

	case "screenshot":
		m.logger.Info("Screenshot received for %s", session.outputName)
		if m.onScreenshot != nil {
			m.onScreenshot(ScreenScreenshotResultPayload{
				OutputName: session.outputName,
				Data:       msg.Data,
				Width:      msg.Width,
				Height:     msg.Height,
			})
		}
	}
}

// waitLoop waits for the daemon process to exit
func (m *ScreenManager) waitLoop(session *ScreenSession) {
	if session.process != nil {
		session.process.Wait()
	}

	m.mu.Lock()
	_, exists := m.sessions[session.outputName]
	m.mu.Unlock()

	if exists {
		m.logger.Warn("Daemon exited unexpectedly for %s", session.outputName)
		m.Stop(session.outputName)
	}
}
