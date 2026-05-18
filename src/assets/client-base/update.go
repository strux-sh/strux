package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	struxDataDir       = "/strux-data/strux"
	bootEnvPath        = struxDataDir + "/boot.env"
	bootEnvBackupPath  = struxDataDir + "/boot.env.bak"
	updateStatePath    = struxDataDir + "/update-state.json"
	updateProgressPath = "/run/strux/update-progress.json"
	projectInfoPath    = "/etc/strux/project.json"
	updatePublicKey    = "/etc/strux/update.pub"
)

type bootEnv struct {
	Active     string
	Pending    string
	Tries      int
	Generation int
}

type updateState struct {
	Version        int    `json:"version"`
	ActiveSlot     string `json:"activeSlot"`
	PendingSlot    string `json:"pendingSlot"`
	TriesRemaining int    `json:"triesRemaining"`
	Generation     int    `json:"generation"`
	LastGoodAt     string `json:"lastGoodAt,omitempty"`
	LastError      string `json:"lastError"`
}

type projectInfo struct {
	Name           string `json:"name"`
	ProjectVersion string `json:"projectVersion"`
	StruxVersion   string `json:"struxVersion"`
	BSP            string `json:"bsp"`
	Arch           string `json:"arch"`
	BuiltAt        string `json:"builtAt"`
}

type updateBundleManifest struct {
	Schema         string `json:"schema"`
	BSP            string `json:"bsp"`
	Version        string `json:"version"`
	ProjectVersion string `json:"projectVersion"`
	StruxVersion   string `json:"struxVersion"`
	CreatedAt      string `json:"createdAt"`
	Payload        struct {
		Type   string `json:"type"`
		File   string `json:"file"`
		Size   int64  `json:"size"`
		SHA256 string `json:"sha256"`
	} `json:"payload"`
	Signing struct {
		Algorithm   string `json:"algorithm"`
		SignedBytes string `json:"signedBytes"`
	} `json:"signing"`
}

type systemUpdateResult struct {
	Status  string
	Message string
	Slot    string
	Version string
}

type systemUpdateProgress struct {
	Status       string `json:"status"`
	Progress     int    `json:"progress"`
	Message      string `json:"message,omitempty"`
	BytesWritten int64  `json:"bytesWritten,omitempty"`
	TotalBytes   int64  `json:"totalBytes,omitempty"`
	Slot         string `json:"slot,omitempty"`
	Version      string `json:"version,omitempty"`
	UpdatedAt    string `json:"updatedAt,omitempty"`
}

type systemUpdateProgressCallback func(systemUpdateProgress)

type rootfsProgressWriter struct {
	total    int64
	written  int64
	slot     string
	version  string
	emit     systemUpdateProgressCallback
	lastPct  int
	lastEmit time.Time
}

func (w *rootfsProgressWriter) Write(data []byte) (int, error) {
	n := len(data)
	w.written += int64(n)
	w.maybeEmit(false)
	return n, nil
}

func (w *rootfsProgressWriter) maybeEmit(force bool) {
	if w.emit == nil || w.total <= 0 {
		return
	}

	progress := int((w.written * 100) / w.total)
	if progress > 100 {
		progress = 100
	}

	now := time.Now()
	if !force && progress == w.lastPct && now.Sub(w.lastEmit) < 750*time.Millisecond {
		return
	}
	if !force && progress != 100 && progress < w.lastPct+1 && now.Sub(w.lastEmit) < 750*time.Millisecond {
		return
	}

	w.lastPct = progress
	w.lastEmit = now
	w.emit(systemUpdateProgress{
		Status:       "installing",
		Progress:     progress,
		Message:      "Writing inactive rootfs",
		BytesWritten: w.written,
		TotalBytes:   w.total,
		Slot:         w.slot,
		Version:      w.version,
	})
}

func currentBootSlot() string {
	data, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		return ""
	}

	for _, field := range strings.Fields(string(data)) {
		if strings.HasPrefix(field, "strux.slot=") {
			slot := strings.TrimPrefix(field, "strux.slot=")
			if slot == "A" || slot == "B" {
				return slot
			}
		}
	}

	return ""
}

func readProjectInfo() (projectInfo, error) {
	data, err := os.ReadFile(projectInfoPath)
	if err != nil {
		return projectInfo{}, err
	}

	var info projectInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return projectInfo{}, err
	}
	return info, nil
}

func parseBootEnv(data []byte) (bootEnv, error) {
	env := bootEnv{
		Active:     "A",
		Pending:    "",
		Tries:      0,
		Generation: 1,
	}

	for _, rawLine := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}

		switch key {
		case "strux_active":
			env.Active = value
		case "strux_pending":
			env.Pending = value
		case "strux_tries":
			tries, err := strconv.ParseInt(value, 0, 32)
			if err != nil {
				return env, fmt.Errorf("invalid strux_tries %q: %w", value, err)
			}
			env.Tries = int(tries)
		case "strux_generation":
			generation, err := strconv.ParseInt(value, 0, 32)
			if err != nil {
				return env, fmt.Errorf("invalid strux_generation %q: %w", value, err)
			}
			env.Generation = int(generation)
		}
	}

	if env.Active != "A" && env.Active != "B" {
		return env, fmt.Errorf("invalid strux_active %q", env.Active)
	}
	if env.Pending != "" && env.Pending != "A" && env.Pending != "B" {
		return env, fmt.Errorf("invalid strux_pending %q", env.Pending)
	}

	return env, nil
}

func readBootEnv() (bootEnv, error) {
	for _, path := range []string{bootEnvPath, bootEnvBackupPath} {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		env, err := parseBootEnv(data)
		if err == nil {
			return env, nil
		}
	}

	return bootEnv{}, fmt.Errorf("no valid Strux boot env found")
}

func renderBootEnv(env bootEnv) []byte {
	return []byte(fmt.Sprintf(
		"strux_active=%s\nstrux_pending=%s\nstrux_tries=%d\nstrux_generation=%d\n",
		env.Active,
		env.Pending,
		env.Tries,
		env.Generation,
	))
}

func writeStateFile(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	// /strux-data is FAT so U-Boot can read it. Avoid temp-file + rename
	// sequences here; redundant boot.env files provide the recovery path.
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	written, err := file.Write(data)
	if err != nil {
		file.Close()
		return err
	}
	if written != len(data) {
		file.Close()
		return io.ErrShortWrite
	}
	if err := file.Chmod(mode); err != nil {
		file.Close()
		return err
	}
	syncErr := file.Sync()
	closeErr := file.Close()

	if dirFile, err := os.Open(dir); err == nil {
		_ = dirFile.Sync()
		_ = dirFile.Close()
	}

	if syncErr != nil {
		return syncErr
	}
	if closeErr != nil {
		return closeErr
	}
	return nil
}

func writeUpdateProgress(progress systemUpdateProgress) error {
	progress.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	data, err := json.MarshalIndent(progress, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	return writeStateFile(updateProgressPath, data, 0644)
}

func writeBootEnvRedundant(env bootEnv) error {
	data := renderBootEnv(env)

	if err := writeStateFile(bootEnvBackupPath, data, 0644); err != nil {
		return err
	}
	return writeStateFile(bootEnvPath, data, 0644)
}

func writeUpdateState(env bootEnv, lastGoodAt string) error {
	state := updateState{
		Version:        1,
		ActiveSlot:     env.Active,
		PendingSlot:    env.Pending,
		TriesRemaining: env.Tries,
		Generation:     env.Generation,
		LastGoodAt:     lastGoodAt,
		LastError:      "",
	}

	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	return writeStateFile(updateStatePath, data, 0644)
}

func markPendingUpdateGood() error {
	slot := currentBootSlot()
	if slot == "" {
		return nil
	}

	env, err := readBootEnv()
	if err != nil {
		return nil
	}

	if env.Pending == "" && env.Active == slot {
		return nil
	}

	env.Active = slot
	env.Pending = ""
	env.Tries = 0
	env.Generation++

	if err := writeBootEnvRedundant(env); err != nil {
		return err
	}
	return writeUpdateState(env, time.Now().UTC().Format(time.RFC3339))
}

func inactiveSlot(current string) (string, error) {
	switch current {
	case "A":
		return "B", nil
	case "B":
		return "A", nil
	default:
		return "", fmt.Errorf("unknown current slot %q", current)
	}
}

func slotDevice(slot string) (string, error) {
	switch slot {
	case "A":
		return "/dev/disk/by-partlabel/strux-rootfs-a", nil
	case "B":
		return "/dev/disk/by-partlabel/strux-rootfs-b", nil
	default:
		return "", fmt.Errorf("unknown slot %q", slot)
	}
}

func loadUpdatePublicKey(path string) (*rsa.PublicKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	if block, _ := pem.Decode(data); block != nil {
		parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		key, ok := parsed.(*rsa.PublicKey)
		if !ok {
			return nil, fmt.Errorf("public key is not RSA")
		}
		if key.N.BitLen() < 4096 {
			return nil, fmt.Errorf("RSA update public key must be at least 4096 bits")
		}
		return key, nil
	}

	return nil, fmt.Errorf("unsupported update public key format")
}

func verifyUpdateManifest(manifestBytes, signatureBase64 []byte) (updateBundleManifest, error) {
	signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(signatureBase64)))
	if err != nil {
		return updateBundleManifest{}, fmt.Errorf("decode signature: %w", err)
	}

	publicKey, err := loadUpdatePublicKey(updatePublicKey)
	if err != nil {
		return updateBundleManifest{}, fmt.Errorf("load update public key: %w", err)
	}
	digest := sha512.Sum512(manifestBytes)
	if err := rsa.VerifyPSS(publicKey, crypto.SHA512, digest[:], signature, &rsa.PSSOptions{
		SaltLength: rsa.PSSSaltLengthEqualsHash,
		Hash:       crypto.SHA512,
	}); err != nil {
		return updateBundleManifest{}, fmt.Errorf("invalid update bundle signature: %w", err)
	}

	var manifest updateBundleManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return updateBundleManifest{}, fmt.Errorf("parse manifest: %w", err)
	}

	if manifest.Schema != "dev.strux.update.bundle.v1" {
		return updateBundleManifest{}, fmt.Errorf("unsupported update schema %q", manifest.Schema)
	}
	if manifest.Payload.Type != "full-rootfs" {
		return updateBundleManifest{}, fmt.Errorf("unsupported payload type %q", manifest.Payload.Type)
	}
	if manifest.Payload.File != filepath.Base(manifest.Payload.File) {
		return updateBundleManifest{}, fmt.Errorf("payload file must be a bundle-local filename")
	}
	if manifest.Signing.Algorithm != "rsa-pss-sha512" {
		return updateBundleManifest{}, fmt.Errorf("unsupported signing algorithm %q", manifest.Signing.Algorithm)
	}
	if manifest.Signing.SignedBytes != "" && manifest.Signing.SignedBytes != "manifest.json" {
		return updateBundleManifest{}, fmt.Errorf("unsupported signed bytes target %q", manifest.Signing.SignedBytes)
	}
	if manifest.ProjectVersion == "" {
		manifest.ProjectVersion = manifest.Version
	}

	return manifest, nil
}

func verifyBundleCompatibility(manifest updateBundleManifest) error {
	info, err := readProjectInfo()
	if err != nil {
		return fmt.Errorf("read installed project info: %w", err)
	}
	if info.BSP == "" {
		return fmt.Errorf("installed project info is missing bsp")
	}
	if manifest.BSP != info.BSP {
		return fmt.Errorf("bundle BSP %q does not match installed BSP %q", manifest.BSP, info.BSP)
	}
	return nil
}

func writeRootfsPayloadToSlot(src io.Reader, destPath string, expectedSize int64, expectedSHA256 string, progress *rootfsProgressWriter) error {
	dest, err := os.OpenFile(destPath, os.O_WRONLY, 0600)
	if err != nil {
		return err
	}

	hasher := sha256.New()
	writers := []io.Writer{dest, hasher}
	if progress != nil {
		progress.maybeEmit(true)
		writers = append(writers, progress)
	}
	written, copyErr := io.Copy(io.MultiWriter(writers...), src)
	syncErr := dest.Sync()
	closeErr := dest.Close()
	if copyErr != nil {
		return copyErr
	}
	if syncErr != nil {
		return syncErr
	}
	if closeErr != nil {
		return closeErr
	}
	if written != expectedSize {
		return fmt.Errorf("payload size mismatch: manifest=%d actual=%d", expectedSize, written)
	}
	if progress != nil {
		progress.written = written
		progress.maybeEmit(true)
	}
	actualSHA256 := fmt.Sprintf("%x", hasher.Sum(nil))
	if !strings.EqualFold(actualSHA256, expectedSHA256) {
		return fmt.Errorf("payload sha256 mismatch")
	}
	return nil
}

func writePendingUpdateState(slot string) error {
	env, err := readBootEnv()
	if err != nil {
		env = bootEnv{
			Active:     currentBootSlot(),
			Generation: 1,
		}
		if env.Active == "" {
			env.Active = "A"
		}
	}

	env.Pending = slot
	env.Tries = 3
	env.Generation++

	if err := writeBootEnvRedundant(env); err != nil {
		return err
	}
	return writeUpdateState(env, "")
}

func streamInstallUpdateBundle(source string, compressedBundle io.Reader, progress systemUpdateProgressCallback) systemUpdateResult {
	logger := NewLogger("SystemUpdate")
	logger.Info("Installing update bundle stream: %s", source)
	if progress != nil {
		progress(systemUpdateProgress{Status: "downloading", Progress: 0, Message: "Reading update bundle"})
	}

	gzipReader, err := gzip.NewReader(compressedBundle)
	if err != nil {
		return systemUpdateResult{Status: "error", Message: "open bundle gzip: " + err.Error()}
	}
	defer gzipReader.Close()

	tarReader := tar.NewReader(gzipReader)
	var manifestBytes []byte
	var signatureBytes []byte
	var manifest *updateBundleManifest

	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			return systemUpdateResult{Status: "error", Message: "bundle ended before rootfs payload was written"}
		}
		if err != nil {
			return systemUpdateResult{Status: "error", Message: "read bundle tar: " + err.Error()}
		}
		if header.Typeflag != tar.TypeReg {
			continue
		}

		cleanName := filepath.Clean(header.Name)
		if cleanName == "." || strings.HasPrefix(cleanName, "..") || filepath.IsAbs(cleanName) {
			return systemUpdateResult{Status: "error", Message: fmt.Sprintf("unsafe bundle path %q", header.Name)}
		}
		name := filepath.Base(cleanName)

		switch name {
		case "manifest.json":
			manifestBytes, err = io.ReadAll(tarReader)
			if err != nil {
				return systemUpdateResult{Status: "error", Message: "read manifest: " + err.Error()}
			}
			if len(signatureBytes) > 0 {
				verifiedManifest, err := verifyUpdateManifest(manifestBytes, signatureBytes)
				if err != nil {
					return systemUpdateResult{Status: "error", Message: "verify manifest: " + err.Error()}
				}
				manifest = &verifiedManifest
			}

		case "manifest.sig":
			signatureBytes, err = io.ReadAll(tarReader)
			if err != nil {
				return systemUpdateResult{Status: "error", Message: "read manifest signature: " + err.Error()}
			}
			if len(manifestBytes) > 0 {
				verifiedManifest, err := verifyUpdateManifest(manifestBytes, signatureBytes)
				if err != nil {
					return systemUpdateResult{Status: "error", Message: "verify manifest: " + err.Error()}
				}
				manifest = &verifiedManifest
			}

		default:
			if manifest == nil || name != manifest.Payload.File {
				continue
			}
			if header.Size != manifest.Payload.Size {
				return systemUpdateResult{Status: "error", Message: fmt.Sprintf("payload size mismatch: manifest=%d tar=%d", manifest.Payload.Size, header.Size), Version: manifest.Version}
			}
			if err := verifyBundleCompatibility(*manifest); err != nil {
				return systemUpdateResult{Status: "error", Message: "incompatible update bundle: " + err.Error(), Version: manifest.Version}
			}

			currentSlot := currentBootSlot()
			targetSlot, err := inactiveSlot(currentSlot)
			if err != nil {
				return systemUpdateResult{Status: "error", Message: err.Error(), Version: manifest.Version}
			}
			devicePath, err := slotDevice(targetSlot)
			if err != nil {
				return systemUpdateResult{Status: "error", Message: err.Error(), Version: manifest.Version}
			}

			logger.Info("Streaming version %s to inactive slot %s (%s)", manifest.Version, targetSlot, devicePath)
			if progress != nil {
				progress(systemUpdateProgress{
					Status:     "installing",
					Progress:   0,
					Message:    "Writing inactive rootfs",
					TotalBytes: manifest.Payload.Size,
					Slot:       targetSlot,
					Version:    manifest.Version,
				})
			}
			progressWriter := &rootfsProgressWriter{
				total:   manifest.Payload.Size,
				slot:    targetSlot,
				version: manifest.Version,
				emit:    progress,
			}
			if err := writeRootfsPayloadToSlot(tarReader, devicePath, manifest.Payload.Size, manifest.Payload.SHA256, progressWriter); err != nil {
				return systemUpdateResult{Status: "error", Message: "write inactive slot: " + err.Error(), Slot: targetSlot, Version: manifest.Version}
			}
			if progress != nil {
				progress(systemUpdateProgress{
					Status:       "installing",
					Progress:     100,
					Message:      "Rootfs verified",
					BytesWritten: manifest.Payload.Size,
					TotalBytes:   manifest.Payload.Size,
					Slot:         targetSlot,
					Version:      manifest.Version,
				})
			}

			if err := writePendingUpdateState(targetSlot); err != nil {
				return systemUpdateResult{Status: "error", Message: "write pending state: " + err.Error(), Slot: targetSlot, Version: manifest.Version}
			}
			if progress != nil {
				progress(systemUpdateProgress{
					Status:       "completed",
					Progress:     100,
					Message:      "Update installed; rebooting",
					BytesWritten: manifest.Payload.Size,
					TotalBytes:   manifest.Payload.Size,
					Slot:         targetSlot,
					Version:      manifest.Version,
				})
			}

			go func() {
				time.Sleep(2 * time.Second)
				if err := BinaryHandlerInstance.Reboot(); err != nil {
					logger.Error("Reboot after update failed: %v", err)
				}
			}()

			return systemUpdateResult{
				Status:  "pending",
				Message: "Update installed; rebooting into pending slot",
				Slot:    targetSlot,
				Version: manifest.Version,
			}
		}
	}
}

func installUpdateBundle(bundlePath string, progress systemUpdateProgressCallback) systemUpdateResult {
	file, err := os.Open(bundlePath)
	if err != nil {
		return systemUpdateResult{Status: "error", Message: "open update bundle: " + err.Error()}
	}
	defer file.Close()

	return streamInstallUpdateBundle(bundlePath, file, progress)
}

func downloadAndInstallUpdateBundle(bundleURL string, progress systemUpdateProgressCallback) systemUpdateResult {
	logger := NewLogger("SystemUpdate")
	logger.Info("Downloading update bundle: %s", bundleURL)
	if progress != nil {
		progress(systemUpdateProgress{Status: "downloading", Progress: 0, Message: "Downloading update bundle"})
	}

	resp, err := http.Get(bundleURL)
	if err != nil {
		return systemUpdateResult{Status: "error", Message: "download update bundle: " + err.Error()}
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return systemUpdateResult{Status: "error", Message: fmt.Sprintf("download update bundle: HTTP %d", resp.StatusCode)}
	}

	return streamInstallUpdateBundle(bundleURL, resp.Body, progress)
}
