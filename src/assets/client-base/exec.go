//
// Strux Client - Exec Manager (SSH/PTY)
//
// Provides interactive shell sessions over WebSocket using a PTY.
// Supports auto-attaching to an existing session on reconnect.
//

package main

import (
	"fmt"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
)

type ExecSession struct {
	id   string
	cmd  *exec.Cmd
	pty  *os.File
	done chan struct{}
}

type ExecManager struct {
	sessions map[string]*ExecSession
	mu       sync.Mutex
	logger   *Logger
	onOutput func(sessionID, data string)
	onExit   func(sessionID string, code int)
}

func NewExecManager(onOutput func(string, string), onExit func(string, int)) *ExecManager {
	return &ExecManager{
		sessions: make(map[string]*ExecSession),
		logger:   NewLogger("ExecManager"),
		onOutput: onOutput,
		onExit:   onExit,
	}
}

// AttachToExisting checks if there's an existing session and re-maps it to the new sessionID.
// Returns true if an existing session was found and attached.
func (m *ExecManager) AttachToExisting(newSessionID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()

	// If there's already a session with this ID, it's already attached
	if _, exists := m.sessions[newSessionID]; exists {
		return true
	}

	// Find any existing session and re-map it
	for oldID, session := range m.sessions {
		m.logger.Info("Re-attaching existing PTY session %s as %s", oldID, newSessionID)
		delete(m.sessions, oldID)
		session.id = newSessionID
		m.sessions[newSessionID] = session
		return true
	}

	return false
}

func (m *ExecManager) Start(sessionID string, shell string) error {
	m.mu.Lock()
	if _, exists := m.sessions[sessionID]; exists {
		m.mu.Unlock()
		return fmt.Errorf("session already exists: %s", sessionID)
	}
	m.mu.Unlock()

	shellPath := shell
	if shellPath == "" || !fileExists(shellPath) {
		if fileExists("/bin/bash") {
			shellPath = "/bin/bash"
		} else {
			shellPath = "/bin/sh"
		}
	}

	cmd := exec.Command(shellPath)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	ptmx, err := pty.Start(cmd)
	if err != nil {
		return fmt.Errorf("failed to start pty: %w", err)
	}

	session := &ExecSession{
		id:   sessionID,
		cmd:  cmd,
		pty:  ptmx,
		done: make(chan struct{}),
	}

	m.mu.Lock()
	m.sessions[sessionID] = session
	m.mu.Unlock()

	go m.readLoop(session)
	go m.waitLoop(session)

	m.logger.Info("Started exec session: %s", sessionID)
	return nil
}

func (m *ExecManager) SendInput(sessionID string, data string) error {
	m.mu.Lock()
	session, exists := m.sessions[sessionID]
	m.mu.Unlock()

	if !exists {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	_, err := session.pty.Write([]byte(data))
	return err
}

func (m *ExecManager) Resize(sessionID string, rows, cols int) {
	m.mu.Lock()
	session, exists := m.sessions[sessionID]
	m.mu.Unlock()

	if !exists || session.pty == nil {
		return
	}

	if err := pty.Setsize(session.pty, &pty.Winsize{
		Rows: uint16(rows),
		Cols: uint16(cols),
	}); err != nil {
		m.logger.Error("Failed to resize PTY: %v", err)
	}
}

func (m *ExecManager) Stop(sessionID string) {
	m.mu.Lock()
	session, exists := m.sessions[sessionID]
	if exists {
		delete(m.sessions, sessionID)
	}
	m.mu.Unlock()

	if !exists {
		return
	}

	close(session.done)
	if session.cmd.Process != nil {
		_ = session.cmd.Process.Kill()
	}
	if session.pty != nil {
		_ = session.pty.Close()
	}
}

func (m *ExecManager) StopAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.sessions))
	for id := range m.sessions {
		ids = append(ids, id)
	}
	m.mu.Unlock()

	for _, id := range ids {
		m.Stop(id)
	}
}

func (m *ExecManager) readLoop(session *ExecSession) {
	buf := make([]byte, 4096)

	for {
		select {
		case <-session.done:
			return
		default:
		}

		n, err := session.pty.Read(buf)
		if err != nil {
			// PTY closed — not an error worth reporting separately
			return
		}

		if n > 0 && m.onOutput != nil {
			m.onOutput(session.id, string(buf[:n]))
		}
	}
}

func (m *ExecManager) waitLoop(session *ExecSession) {
	err := session.cmd.Wait()
	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = 1
		}
	}

	if m.onExit != nil {
		m.onExit(session.id, exitCode)
	}

	m.Stop(session.id)
}
