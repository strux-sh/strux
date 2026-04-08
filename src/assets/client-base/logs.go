//
// Strux Client - Log Streamer
//
// Streams system logs (journalctl) and app logs to the dev server.
// Supports streaming all logs, filtering by service, or tailing a file.
//

package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"
)

// LogCallback is called for each log line
type LogCallback func(line string)

// LogStreamType indicates the type of log stream
type LogStreamType int

const (
	LogStreamTypeCommand LogStreamType = iota
	LogStreamTypeFile
)

// LogStream represents an active log stream
type LogStream struct {
	ID         string
	Service    string
	StreamType LogStreamType
	cmd        *exec.Cmd
	file       *os.File
	callback   LogCallback
	done       chan struct{}
	stopped    bool
	mu         sync.Mutex
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
		ID:         streamID,
		StreamType: LogStreamTypeCommand,
		cmd:        cmd,
		callback:   callback,
		done:       make(chan struct{}),
	}

	// Start the command and stream output
	if err := l.startCommandStream(stream); err != nil {
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
		ID:         streamID,
		Service:    serviceName,
		StreamType: LogStreamTypeCommand,
		cmd:        cmd,
		callback:   callback,
		done:       make(chan struct{}),
	}

	// Start the command and stream output
	if err := l.startCommandStream(stream); err != nil {
		return err
	}

	l.streams[streamID] = stream
	return nil
}

// StartAppLogStream starts streaming the application log file
// This tails /tmp/strux-backend.log where the user's Go app output is written
func (l *LogStreamer) StartAppLogStream(streamID string, callback LogCallback) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	if _, exists := l.streams[streamID]; exists {
		return fmt.Errorf("stream %s already exists", streamID)
	}

	l.logger.Info("Starting app log stream: %s", streamID)

	// Create the stream
	stream := &LogStream{
		ID:         streamID,
		StreamType: LogStreamTypeFile,
		callback:   callback,
		done:       make(chan struct{}),
	}

	// Start tailing the log file
	if err := l.startFileStream(stream, "/tmp/strux-backend.log"); err != nil {
		return err
	}

	l.streams[streamID] = stream
	return nil
}

// StartCageLogStream starts streaming the Cage compositor log file
// This tails /tmp/strux-cage.log where Cage/Cog output is written
func (l *LogStreamer) StartCageLogStream(streamID string, callback LogCallback) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	if _, exists := l.streams[streamID]; exists {
		return fmt.Errorf("stream %s already exists", streamID)
	}

	l.logger.Info("Starting cage log stream: %s", streamID)

	// Create the stream
	stream := &LogStream{
		ID:         streamID,
		StreamType: LogStreamTypeFile,
		callback:   callback,
		done:       make(chan struct{}),
	}

	// Start tailing the log file
	if err := l.startFileStream(stream, "/tmp/strux-cage.log"); err != nil {
		return err
	}

	l.streams[streamID] = stream
	return nil
}

// StartEarlyLogStream starts streaming best-effort early boot logs
// Prefers journalctl -b, falls back to dmesg -w
func (l *LogStreamer) StartEarlyLogStream(streamID string, callback LogCallback) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	if _, exists := l.streams[streamID]; exists {
		return fmt.Errorf("stream %s already exists", streamID)
	}

	l.logger.Info("Starting early log stream: %s", streamID)

	cmd := exec.Command("journalctl", "-b", "-f", "--no-pager", "-o", "short-precise")
	stream := &LogStream{
		ID:         streamID,
		StreamType: LogStreamTypeCommand,
		cmd:        cmd,
		callback:   callback,
		done:       make(chan struct{}),
	}

	if err := l.startCommandStream(stream); err != nil {
		l.logger.Warn("journalctl not available, falling back to dmesg: %v", err)
		cmd = exec.Command("dmesg", "-w")
		stream.cmd = cmd
		if err := l.startCommandStream(stream); err != nil {
			return err
		}
	}

	l.streams[streamID] = stream
	return nil
}

// startCommandStream starts a command and reads its output
func (l *LogStreamer) startCommandStream(stream *LogStream) error {
	// Force color output from journalctl even when piped
	stream.cmd.Env = append(os.Environ(), "SYSTEMD_COLORS=1")

	// Get stdout pipe
	stdout, err := stream.cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("failed to get stdout pipe: %w", err)
	}

	// Also capture stderr
	stderr, err := stream.cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("failed to get stderr pipe: %w", err)
	}

	// Start the command
	if err := stream.cmd.Start(); err != nil {
		return fmt.Errorf("failed to start command: %w", err)
	}

	// Read stdout in a goroutine
	go l.readPipe(stream, stdout)

	// Read stderr in a goroutine
	go l.readPipe(stream, stderr)

	// Wait for command in background and cleanup
	go func() {
		stream.cmd.Wait()
		// Give readers a moment to finish
		time.Sleep(100 * time.Millisecond)
		l.cleanupStream(stream.ID)
	}()

	return nil
}

// startFileStream starts tailing a log file
func (l *LogStreamer) startFileStream(stream *LogStream, filePath string) error {
	// Wait for the file to exist (it may not exist immediately on boot)
	go func() {
		maxWait := 60 * time.Second
		waitInterval := 500 * time.Millisecond
		elapsed := time.Duration(0)

		for elapsed < maxWait {
			select {
			case <-stream.done:
				return
			default:
			}

			// Check if file exists
			if _, err := os.Stat(filePath); err == nil {
				break
			}

			time.Sleep(waitInterval)
			elapsed += waitInterval
		}

		// Check if we're still running
		stream.mu.Lock()
		if stream.stopped {
			stream.mu.Unlock()
			return
		}
		stream.mu.Unlock()

		// Open the file for reading
		file, err := os.Open(filePath)
		if err != nil {
			l.logger.Error("Failed to open log file %s: %v", filePath, err)
			return
		}

		stream.mu.Lock()
		stream.file = file
		stream.mu.Unlock()

		// Seek to end of file (we only want new content)
		file.Seek(0, io.SeekEnd)

		// Read file in a loop, tailing new content
		l.tailFile(stream, file)
	}()

	return nil
}

// readPipe reads from a pipe and calls the callback for each line
func (l *LogStreamer) readPipe(stream *LogStream, pipe io.ReadCloser) {
	// Use a larger buffer for long lines (1MB)
	scanner := bufio.NewScanner(pipe)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)

	for {
		// Check if we should stop before blocking on Scan
		select {
		case <-stream.done:
			return
		default:
		}

		if !scanner.Scan() {
			break
		}

		line := scanner.Text()
		if line != "" {
			// Check again before callback in case we were stopped
			stream.mu.Lock()
			stopped := stream.stopped
			stream.mu.Unlock()
			if stopped {
				return
			}
			stream.callback(line)
		}
	}

	if err := scanner.Err(); err != nil {
		l.logger.Error("Scanner error for stream %s: %v", stream.ID, err)
	}
}

// tailFile continuously reads new content from a file
func (l *LogStreamer) tailFile(stream *LogStream, file *os.File) {
	defer file.Close()

	reader := bufio.NewReader(file)
	pollInterval := 100 * time.Millisecond

	for {
		select {
		case <-stream.done:
			return
		default:
		}

		line, err := reader.ReadString('\n')
		if err != nil {
			if err != io.EOF {
				l.logger.Error("Error reading log file: %v", err)
				return
			}
			// EOF - wait for more content
			time.Sleep(pollInterval)
			continue
		}

		// Remove trailing newline
		if len(line) > 0 && line[len(line)-1] == '\n' {
			line = line[:len(line)-1]
		}

		if line != "" {
			stream.mu.Lock()
			stopped := stream.stopped
			stream.mu.Unlock()
			if stopped {
				return
			}
			stream.callback(line)
		}
	}
}

// cleanupStream removes a stream from the map
func (l *LogStreamer) cleanupStream(streamID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.streams, streamID)
}

// Stop stops a specific log stream
func (l *LogStreamer) Stop(streamID string) {
	l.mu.Lock()
	stream, exists := l.streams[streamID]
	if !exists {
		l.mu.Unlock()
		l.logger.Warn("Stream not found: %s", streamID)
		return
	}
	delete(l.streams, streamID)
	l.mu.Unlock()

	l.logger.Info("Stopping stream: %s", streamID)

	// Mark as stopped first
	stream.mu.Lock()
	stream.stopped = true
	stream.mu.Unlock()

	// Close the done channel to signal goroutines
	close(stream.done)

	// Kill the process if it's a command stream
	if stream.cmd != nil && stream.cmd.Process != nil {
		stream.cmd.Process.Kill()
	}

	// Close the file if it's a file stream
	if stream.file != nil {
		stream.file.Close()
	}
}

// StopAll stops all active log streams
func (l *LogStreamer) StopAll() {
	l.mu.Lock()
	streams := make([]*LogStream, 0, len(l.streams))
	ids := make([]string, 0, len(l.streams))
	for id, stream := range l.streams {
		streams = append(streams, stream)
		ids = append(ids, id)
	}
	// Clear the map
	l.streams = make(map[string]*LogStream)
	l.mu.Unlock()

	l.logger.Info("Stopping all streams")

	for i, stream := range streams {
		l.logger.Info("Stopping stream: %s", ids[i])

		stream.mu.Lock()
		stream.stopped = true
		stream.mu.Unlock()

		close(stream.done)
		if stream.cmd != nil && stream.cmd.Process != nil {
			stream.cmd.Process.Kill()
		}
		if stream.file != nil {
			stream.file.Close()
		}
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
