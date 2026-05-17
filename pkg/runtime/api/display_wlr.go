package api

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	wlrRandrTimeout = 30 * time.Second
)

var (
	displayOutputHeadLine = regexp.MustCompile(`^([A-Za-z0-9_-]+)\s+"((?:[^"\\]|\\.)*)"\s*$`)
	displayPhysicalMM     = regexp.MustCompile(`^\s+Physical size:\s+(\d+)x(\d+)\s+mm\s*$`)
	displayEnabledLine    = regexp.MustCompile(`^\s+Enabled:\s+(yes|no)\s*$`)
	displayModeLine       = regexp.MustCompile(`^\s+(\d+)x(\d+)\s+px(?:,\s*([0-9.]+)\s+Hz)?(.*)$`)
	displayPositionLine   = regexp.MustCompile(`^\s+Position:\s+(-?\d+),(-?\d+)\s*$`)
	displayTransformLine  = regexp.MustCompile(`^\s+Transform:\s+(\S+)\s*$`)
	displayScaleLine      = regexp.MustCompile(`^\s+Scale:\s+(\S+)\s*$`)
	validDisplayOutputID  = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

	validWlrTransforms = map[string]struct{}{
		"normal":      {},
		"90":          {},
		"180":         {},
		"270":         {},
		"flipped":     {},
		"flipped-90":  {},
		"flipped-180": {},
		"flipped-270": {},
	}
)

func contextFromEnv() context.Context {
	return context.Background()
}

func validateDisplayOutputIdentifier(name string) error {
	if name == "" {
		return fmt.Errorf("output name is empty")
	}
	if !validDisplayOutputID.MatchString(name) {
		return fmt.Errorf("invalid output name %q", name)
	}
	return nil
}

func lookupWlrRandrBin() (string, error) {
	p, err := exec.LookPath("wlr-randr")
	if err != nil {
		return "", fmt.Errorf("wlr-randr not found in PATH: %w", err)
	}
	return p, nil
}

func execWlrRandrCapture(ctx context.Context) ([]byte, []byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, wlrRandrTimeout)
	defer cancel()

	bin, err := lookupWlrRandrBin()
	if err != nil {
		return nil, nil, err
	}

	cmd := exec.CommandContext(ctx, bin)
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf

	if runErr := cmd.Run(); runErr != nil {
		msg := strings.TrimSpace(errBuf.String())
		if msg != "" {
			return outBuf.Bytes(), errBuf.Bytes(), fmt.Errorf("%w: %s", runErr, msg)
		}
		return outBuf.Bytes(), errBuf.Bytes(), runErr
	}

	return outBuf.Bytes(), errBuf.Bytes(), nil
}

func execWlrRandrApply(ctx context.Context, changes []DisplayOutputChange, opts DisplayApplyOptions) error {
	if len(changes) == 0 {
		return ErrNoDisplayOutputChanges
	}

	args, err := buildWlrRandrApplyArgv(changes, opts.DryRun)
	if err != nil {
		return err
	}

	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, wlrRandrTimeout)
	defer cancel()

	bin, err := lookupWlrRandrBin()
	if err != nil {
		return err
	}

	cmd := exec.CommandContext(ctx, bin, args...)
	var errBuf bytes.Buffer
	cmd.Stderr = &errBuf

	if runErr := cmd.Run(); runErr != nil {
		msg := strings.TrimSpace(errBuf.String())
		if msg != "" {
			return fmt.Errorf("%w: %s", runErr, msg)
		}
		return runErr
	}

	return nil
}

func buildWlrRandrApplyArgv(changes []DisplayOutputChange, dryRun bool) ([]string, error) {
	var args []string
	if dryRun {
		args = append(args, "--dryrun")
	}

	for _, ch := range changes {
		if err := validateDisplayOutputIdentifier(ch.Name); err != nil {
			return nil, err
		}

		modeKinds := 0
		if ch.ListedMode != nil {
			modeKinds++
		}
		if ch.CustomMode != nil {
			modeKinds++
		}
		if ch.UsePreferred {
			modeKinds++
		}

		off := ch.On != nil && !*ch.On
		if off && modeKinds > 0 {
			return nil, fmt.Errorf("%s: --off conflicts with listed/custom/preferred mode options", ch.Name)
		}
		if off {
			if ch.PositionX != nil || ch.PositionY != nil || ch.Scale != nil || ch.Transform != nil {
				return nil, fmt.Errorf("%s: --off rejects layout/transform/scale options", ch.Name)
			}
		}

		if modeKinds > 1 {
			return nil, fmt.Errorf("%s: pick only one listedMode, customMode, or usePreferred", ch.Name)
		}

		posUses := positionArgCount(ch)
		if posUses == 1 {
			return nil, fmt.Errorf("%s: specify both positionX and positionY or neither", ch.Name)
		}

		args = append(args, "--output", ch.Name)

		if ch.On != nil && *ch.On {
			args = append(args, "--on")
		}
		if off {
			args = append(args, "--off")
			continue
		}

		switch {
		case ch.ListedMode != nil:
			m := ch.ListedMode
			if m.Width <= 0 || m.Height <= 0 {
				return nil, fmt.Errorf("%s: listedMode width and height must be positive", ch.Name)
			}
			args = append(args, "--mode", formatRandrModeTriple(m.Width, m.Height, m.RefreshMilliHz))
		case ch.CustomMode != nil:
			m := ch.CustomMode
			if m.Width <= 0 || m.Height <= 0 {
				return nil, fmt.Errorf("%s: customMode width and height must be positive", ch.Name)
			}
			args = append(args, "--custom-mode", formatRandrModeTriple(m.Width, m.Height, m.RefreshMilliHz))
		case ch.UsePreferred:
			args = append(args, "--preferred")
		}

		if ch.PositionX != nil && ch.PositionY != nil {
			args = append(args, "--pos", fmt.Sprintf("%d,%d", *ch.PositionX, *ch.PositionY))
		}

		if ch.Transform != nil {
			ts := string(*ch.Transform)
			if _, ok := validWlrTransforms[ts]; !ok {
				return nil, fmt.Errorf("%s: invalid transform %q", ch.Name, ts)
			}
			args = append(args, "--transform", ts)
		}

		if ch.Scale != nil {
			if *ch.Scale <= 0 {
				return nil, fmt.Errorf("%s: scale must be greater than zero", ch.Name)
			}
			args = append(args, "--scale", strconv.FormatFloat(*ch.Scale, 'f', -1, 64))
		}
	}

	return args, nil
}

func positionArgCount(ch DisplayOutputChange) int {
	cnt := 0
	if ch.PositionX != nil {
		cnt++
	}
	if ch.PositionY != nil {
		cnt++
	}
	return cnt
}

func formatRandrModeTriple(width, height int, refreshMilliHz int) string {
	if refreshMilliHz <= 0 {
		return fmt.Sprintf("%dx%d", width, height)
	}
	hz := float64(refreshMilliHz) / 1000.0
	return fmt.Sprintf("%dx%d@%g Hz", width, height, hz)
}

func parseWlrRandrStdout(stdout string) ([]DisplayOutput, error) {
	lines := strings.Split(stdout, "\n")
	var outs []DisplayOutput
	var cur *DisplayOutput
	inModes := false

	flushHead := func() {
		if cur == nil {
			return
		}
		inModes = false
		finalizeModes(cur)
		outs = append(outs, *cur)
		cur = nil
	}

	for _, raw := range lines {
		line := strings.TrimRight(raw, "\r")

		if m := displayOutputHeadLine.FindStringSubmatch(line); m != nil {
			flushHead()
			desc := unescapeQuotedDescription(m[2])
			cur = &DisplayOutput{
				Name:        m[1],
				Description: desc,
				Scale:       1,
				Transform:   TransformNormal,
			}
			inModes = false
			continue
		}

		if cur == nil {
			continue
		}

		if strings.TrimSpace(line) == "Modes:" {
			inModes = true
			continue
		}

		if inModes {
			if mm := displayModeLine.FindStringSubmatch(line); mm != nil {
				w, _ := strconv.Atoi(mm[1])
				h, _ := strconv.Atoi(mm[2])
				var hz float64
				if mm[3] != "" {
					hz, _ = strconv.ParseFloat(mm[3], 64)
				}
				meta := strings.TrimSpace(mm[4])
				dm := DisplayMode{
					WidthPX:   w,
					HeightPX:  h,
					RefreshHz: hz,
					Preferred: strings.Contains(meta, "preferred"),
					IsCurrent: strings.Contains(meta, "current"),
				}
				cur.Modes = append(cur.Modes, dm)
				continue
			}
			inModes = false
		}

		if mm := displayPhysicalMM.FindStringSubmatch(line); mm != nil {
			cur.PhysicalWidthMM = mustParseInt32(mm[1])
			cur.PhysicalHeightMM = mustParseInt32(mm[2])
			continue
		}

		if em := displayEnabledLine.FindStringSubmatch(line); em != nil {
			cur.Enabled = em[1] == "yes"
			continue
		}

		if pm := displayPositionLine.FindStringSubmatch(line); pm != nil {
			cur.PositionX = mustParseInt32(pm[1])
			cur.PositionY = mustParseInt32(pm[2])
			continue
		}

		if tm := displayTransformLine.FindStringSubmatch(line); tm != nil {
			cur.Transform = OutputTransform(tm[1])
			continue
		}

		if sm := displayScaleLine.FindStringSubmatch(line); sm != nil {
			cur.Scale, _ = strconv.ParseFloat(sm[1], 64)
			continue
		}
	}

	flushHead()

	return outs, nil
}

func unescapeQuotedDescription(s string) string {
	return strings.ReplaceAll(s, `\"`, `"`)
}

func mustParseInt32(s string) int32 {
	v, _ := strconv.ParseInt(s, 10, 32)
	return int32(v)
}

func finalizeModes(out *DisplayOutput) {
	for idx := range out.Modes {
		if !out.Modes[idx].IsCurrent {
			continue
		}
		cell := out.Modes[idx]
		cellCopy := cell
		out.Current = &cellCopy
		return
	}

	out.Current = nil
}
