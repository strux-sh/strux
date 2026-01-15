//
// Strux Client - Log Streamer
//
// Streams system logs (journalctl) to the dev server.
// Supports streaming all logs or filtering by service.
//

package main

import (
	"bufio"
	"fmt"
	"os/exec"
	"sync"
)

// LogCallback is called for each log line
type LogCallback func(line string)

// LogStream represents an active log stream
type LogStream struct {
	ID       string
	Service  string
	cmd      *exec.Cmd
	callback LogCallback
	done     chan struct{}
}

// LogStreamer manages log streams
type LogStreamer struct {
	streams map[string]*LogStream
	mu      sync.Mutex
	logger  *Logger
}

// NewLogStreamer creates a new log streamer
func NewLogStreamer() *LogStreamer {
	return &LogStreamer{
		streams: make(map[string]*LogStream),
		logger:  NewLogger("LogStreamer"),
	}
}

// StartJournalctlStream starts streaming all journalctl logs
func (l *LogStreamer) StartJournalctlStream(streamID string, callback LogCallback) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	if _, exists := l.streams[streamID]; exists {
		return fmt.Errorf("stream %s already exists", streamID)
	}

	l.logger.Info("Starting journalctl stream: %s", streamID)

	// Create the journalctl command
	cmd := exec.Command("journalctl", "-f", "--no-pager", "-o", "short-precise")

	// Create the stream
	stream := &LogStream{
		ID:       streamID,
		cmd:      cmd,
		callback: callback,
		done:     make(chan struct{}),
	}

	// Start the command and stream output
	if err := l.startStreamOutput(stream); err != nil {
		return err
	}

	l.streams[streamID] = stream
	return nil
}

// StartServiceStream starts streaming logs for a specific systemd service
func (l *LogStreamer) StartServiceStream(streamID, serviceName string, callback LogCallback) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	if _, exists := l.streams[streamID]; exists {
		return fmt.Errorf("stream %s already exists", streamID)
	}

	l.logger.Info("Starting service stream: %s for %s", streamID, serviceName)

	// Create the journalctl command for the specific service
	cmd := exec.Command("journalctl", "-f", "--no-pager", "-u", serviceName, "-o", "short-precise")

	// Create the stream
	stream := &LogStream{
		ID:       streamID,
		Service:  serviceName,
		cmd:      cmd,
		callback: callback,
		done:     make(chan struct{}),
	}

	// Start the command and stream output
	if err := l.startStreamOutput(stream); err != nil {
		return err
	}

	l.streams[streamID] = stream
	return nil
}

// startStreamOutput starts the command and reads its output
func (l *LogStreamer) startStreamOutput(stream *LogStream) error {
	// Get stdout pipe
	stdout, err := stream.cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("failed to get stdout pipe: %w", err)
	}

	// Start the command
	if err := stream.cmd.Start(); err != nil {
		return fmt.Errorf("failed to start command: %w", err)
	}

	// Read output in a goroutine
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			select {
			case <-stream.done:
				return
			default:
				line := scanner.Text()
				if line != "" {
					stream.callback(line)
				}
			}
		}

		if err := scanner.Err(); err != nil {
			l.logger.Error("Scanner error for stream %s: %v", stream.ID, err)
		}
	}()

	// Wait for command in background and cleanup
	go func() {
		stream.cmd.Wait()
		l.mu.Lock()
		delete(l.streams, stream.ID)
		l.mu.Unlock()
	}()

	return nil
}

// Stop stops a specific log stream
func (l *LogStreamer) Stop(streamID string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	stream, exists := l.streams[streamID]
	if !exists {
		l.logger.Warn("Stream not found: %s", streamID)
		return
	}

	l.logger.Info("Stopping stream: %s", streamID)

	close(stream.done)
	if stream.cmd.Process != nil {
		stream.cmd.Process.Kill()
	}

	delete(l.streams, streamID)
}

// StopAll stops all active log streams
func (l *LogStreamer) StopAll() {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.logger.Info("Stopping all streams")

	for id, stream := range l.streams {
		close(stream.done)
		if stream.cmd.Process != nil {
			stream.cmd.Process.Kill()
		}
		delete(l.streams, id)
	}
}

// GetActiveStreams returns the IDs of all active streams
func (l *LogStreamer) GetActiveStreams() []string {
	l.mu.Lock()
	defer l.mu.Unlock()

	ids := make([]string, 0, len(l.streams))
	for id := range l.streams {
		ids = append(ids, id)
	}
	return ids
}

