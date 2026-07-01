package api

import (
	"context"
	"fmt"
)

const (
	AudioNamespace = "audio"

	// CapabilityAudio is implemented by BSPs that provide audio output control.
	CapabilityAudio = "audio"
)

// AudioOutput is one selectable audio output (speaker, headphone, hdmi, …).
type AudioOutput struct {
	ID        string `json:"id"`        // stable identifier, e.g. "speaker"
	Kind      string `json:"kind"`      // category, e.g. "speaker" | "headphone" | "hdmi"
	Label     string `json:"label"`     // human-readable label
	Available bool   `json:"available"` // present right now (e.g. headphone only when jacked in)
}

// AudioInput is one selectable capture device (built-in mic, headset, USB, …).
// Part of the optional "capture" feature (see AudioCapture).
type AudioInput struct {
	ID        string `json:"id"`        // stable identifier, e.g. "builtin-mic"
	Kind      string `json:"kind"`      // category, e.g. "builtin" | "headset" | "usb" | "bluetooth"
	Label     string `json:"label"`     // human-readable label
	Available bool   `json:"available"` // present right now
}

// CaptureState is the microphone/capture state. It rides in AudioState.Capture
// and is populated by the framework only on boards that implement the optional
// AudioCapture feature; it is nil otherwise.
type CaptureState struct {
	Volume      int    `json:"volume"`      // capture gain, 0–100
	Muted       bool   `json:"muted"`       // capture muted
	ActiveInput string `json:"activeInput"` // AudioInput.ID currently captured
}

// AudioState is the full audio state reported to the frontend.
//
// Volume, Muted, ActiveOutput, and Outputs are universal — every audio BSP
// reports them. AutoSwitch and Capture are OPTIONAL: the framework fills each
// only when the provider implements the matching feature (AudioAutoSwitch /
// AudioCapture), and leaves it nil otherwise. A nil field is the frontend's
// signal that the board does not offer that control — see strux.capabilities for
// the same information ahead of time.
type AudioState struct {
	Volume       int           `json:"volume"`       // master volume, 0–100
	Muted        bool          `json:"muted"`        // output muted
	ActiveOutput string        `json:"activeOutput"` // AudioOutput.ID currently driven
	Outputs      []AudioOutput `json:"outputs"`      // selectable outputs + availability (folded in)
	// Optional-feature state: present only when the provider implements the
	// matching feature. The strux:"optional" tag makes the generated TypeScript
	// render these as `name?: T`, so the frontend type reflects their absence.
	AutoSwitch *bool         `json:"autoSwitch,omitempty" strux:"optional"`
	Capture    *CaptureState `json:"capture,omitempty" strux:"optional"`
}

// AudioEvents is the typed event surface a BSP emits through. The framework
// implements it; each method name IS the event name (Changed → "changed",
// delivered to window.strux.audio.on("changed", cb)). Adding an event means
// adding a method here — there are no event-name strings in BSP code.
type AudioEvents interface {
	Changed(state AudioState)
}

// AudioOps is the MANDATORY operation surface of the audio capability — the
// methods every audio BSP must provide, exposed as strux.audio.*. Both the
// provider (which implements them) and AudioService (which mirrors them for the
// frontend) speak this exact set; the compile-time assertion on AudioService
// below keeps the two in lock-step. Optional methods live on the feature
// interfaces (AudioAutoSwitch, AudioCapture), not here.
type AudioOps interface {
	GetState() (AudioState, error)
	ListOutputs() ([]AudioOutput, error)
	SetVolume(percent int) error
	SetMuted(muted bool) error
	SetOutput(id string) error
}

// AudioAutoSwitch is the OPTIONAL "autoSwitch" feature: a provider implements it
// when the board can automatically re-route output on headphone-jack insertion.
// Boards without jack detection simply omit these methods — the framework then
// reports the feature unavailable in strux.capabilities, returns
// UnsupportedFeatureError from strux.audio.SetAutoSwitch, and leaves
// AudioState.AutoSwitch nil.
type AudioAutoSwitch interface {
	SetAutoSwitch(enabled bool) error
	AutoSwitch() (bool, error)
}

// AudioCapture is the OPTIONAL "capture" feature: microphone/line-in control.
// Boards without a capture path omit it; the framework then reports the feature
// unavailable, returns UnsupportedFeatureError from the capture methods, and
// leaves AudioState.Capture nil.
type AudioCapture interface {
	ListInputs() ([]AudioInput, error)
	SetInput(id string) error
	GetCaptureState() (CaptureState, error)
	SetInputVolume(percent int) error
	SetInputMuted(muted bool) error
}

// AudioContract is what a BSP implements: the mandatory operations (AudioOps)
// plus the two lifecycle hooks, Start and Stop. Optional features are NOT part
// of the contract — a provider adds them by also satisfying AudioAutoSwitch
// and/or AudioCapture.
//
//   - Start performs one-time setup, then runs the change-monitor loop until ctx
//     is cancelled. The framework runs it in its own goroutine, so a plain
//     blocking loop is fine (the BSP never writes `go`). Returning an error
//     BEFORE ctx is done signals a setup/run failure; returning nil after
//     ctx.Done() is a clean stop.
//   - Stop performs deadline-bounded teardown — e.g. muting amplifiers before
//     power is cut to avoid a speaker pop. The framework calls it on shutdown
//     and waits up to the deadline carried by ctx.
//
// The BSP emits changes by calling the AudioEvents it is handed in Start (e.g.
// events.Changed(state)).
type AudioContract interface {
	AudioOps
	Start(ctx context.Context, events AudioEvents) error
	Stop(ctx context.Context) error
}

var Audio = DefineCapability[AudioContract](CapabilitySpec{
	Name:        CapabilityAudio,
	Namespace:   AudioNamespace,
	Description: "BSP audio control: master volume, mute, and output routing, with live change events. Optional features add jack auto-switching and microphone capture.",
	Methods: []MethodSpec{
		{Name: "GetState", Description: "Returns the current audio state (volume, mute, active output, outputs, and any optional fields)."},
		{Name: "ListOutputs", Description: "Returns the selectable audio outputs and their availability."},
		{Name: "SetVolume", Description: "Sets the master volume (0–100)."},
		{Name: "SetMuted", Description: "Mutes or unmutes audio output."},
		{Name: "SetOutput", Description: "Selects the active audio output by id."},
	},
	Events: []EventSpec{
		{Name: "changed", Description: "Emitted whenever audio state changes — volume, mute, active output, jack insertion, or capture.", Payload: "AudioState"},
	},
	Features: []FeatureSpec{
		{
			Name:        "autoSwitch",
			Description: "Automatic output switching on headphone-jack insertion.",
			Requires:    InterfaceType[AudioAutoSwitch](),
			Methods: []MethodSpec{
				{Name: "SetAutoSwitch", Description: "Enables or disables automatic speaker/headphone switching on jack insertion."},
				{Name: "AutoSwitch", Description: "Returns whether automatic output switching is currently enabled."},
			},
		},
		{
			Name:        "capture",
			Description: "Microphone / capture: input enumeration, selection, volume, and mute.",
			Requires:    InterfaceType[AudioCapture](),
			Methods: []MethodSpec{
				{Name: "ListInputs", Description: "Returns the selectable capture inputs and their availability."},
				{Name: "SetInput", Description: "Selects the active capture input by id."},
				{Name: "GetCaptureState", Description: "Returns the current capture state (volume, mute, active input)."},
				{Name: "SetInputVolume", Description: "Sets the capture (microphone) volume (0–100)."},
				{Name: "SetInputMuted", Description: "Mutes or unmutes capture (microphone) input."},
			},
		},
	},
})

// RegisterAudioProvider plugs a BSP's audio implementation into the capability.
func RegisterAudioProvider(provider AudioContract) {
	Audio.RegisterOrPanic(provider)
}

// AudioService is the app-facing surface (window.strux.audio.*). It embeds
// Service so it can emit namespaced events, and monitor so the framework can run
// and tear down the provider's background loop. Mandatory methods delegate to
// the registered AudioContract; optional-feature methods delegate via featureOf,
// returning UnsupportedFeatureError when the active provider does not implement
// the feature.
type AudioService struct {
	Service
	monitor
}

// Compile-time guarantees. AudioService must mirror the mandatory operation
// surface AND expose every optional-feature method (so the reflected surface is
// complete); the event forwarder must cover every declared event. Add a method
// to any of these interfaces and forget it here → the build fails.
var (
	_ AudioOps        = AudioService{}
	_ AudioAutoSwitch = AudioService{}
	_ AudioCapture    = AudioService{}
	_ AudioEvents     = audioEvents{}
)

// --- mandatory operations ---------------------------------------------------

func (AudioService) GetState() (AudioState, error) {
	provider, err := providerOf(Audio)
	if err != nil {
		return AudioState{}, err
	}
	state, err := provider.GetState()
	if err != nil {
		return AudioState{}, err
	}
	return enrichAudioState(state), nil
}

func (AudioService) ListOutputs() ([]AudioOutput, error) {
	provider, err := providerOf(Audio)
	if err != nil {
		return nil, err
	}
	return provider.ListOutputs()
}

func (AudioService) SetVolume(percent int) error {
	if percent < 0 || percent > 100 {
		return fmt.Errorf("volume must be between 0 and 100")
	}
	provider, err := providerOf(Audio)
	if err != nil {
		return err
	}
	return provider.SetVolume(percent)
}

func (AudioService) SetMuted(muted bool) error {
	provider, err := providerOf(Audio)
	if err != nil {
		return err
	}
	return provider.SetMuted(muted)
}

func (AudioService) SetOutput(id string) error {
	provider, err := providerOf(Audio)
	if err != nil {
		return err
	}
	return provider.SetOutput(id)
}

// --- optional feature: autoSwitch -------------------------------------------

func (AudioService) SetAutoSwitch(enabled bool) error {
	feature, err := featureOf[AudioAutoSwitch](Audio)
	if err != nil {
		return err
	}
	return feature.SetAutoSwitch(enabled)
}

func (AudioService) AutoSwitch() (bool, error) {
	feature, err := featureOf[AudioAutoSwitch](Audio)
	if err != nil {
		return false, err
	}
	return feature.AutoSwitch()
}

// --- optional feature: capture ----------------------------------------------

func (AudioService) ListInputs() ([]AudioInput, error) {
	feature, err := featureOf[AudioCapture](Audio)
	if err != nil {
		return nil, err
	}
	return feature.ListInputs()
}

func (AudioService) SetInput(id string) error {
	feature, err := featureOf[AudioCapture](Audio)
	if err != nil {
		return err
	}
	return feature.SetInput(id)
}

func (AudioService) GetCaptureState() (CaptureState, error) {
	feature, err := featureOf[AudioCapture](Audio)
	if err != nil {
		return CaptureState{}, err
	}
	return feature.GetCaptureState()
}

func (AudioService) SetInputVolume(percent int) error {
	if percent < 0 || percent > 100 {
		return fmt.Errorf("input volume must be between 0 and 100")
	}
	feature, err := featureOf[AudioCapture](Audio)
	if err != nil {
		return err
	}
	return feature.SetInputVolume(percent)
}

func (AudioService) SetInputMuted(muted bool) error {
	feature, err := featureOf[AudioCapture](Audio)
	if err != nil {
		return err
	}
	return feature.SetInputMuted(muted)
}

// --- state composition ------------------------------------------------------

// enrichAudioState overlays the framework-composed fields onto a provider's core
// AudioState: the output list (always) and the optional AutoSwitch / Capture
// fields (only when the provider implements the matching feature). It runs on
// BOTH paths — the pull path (AudioService.GetState) and the push path
// (audioEvents.Changed) — so every snapshot the frontend sees is complete and
// consistent, and a provider's GetState only ever needs to fill the core fields.
func enrichAudioState(state AudioState) AudioState {
	provider, ok := Audio.Provider()
	if !ok {
		return state
	}
	if state.Outputs == nil {
		if outputs, err := provider.ListOutputs(); err == nil {
			state.Outputs = outputs
		}
	}
	if state.AutoSwitch == nil {
		if sw, ok := any(provider).(AudioAutoSwitch); ok {
			if on, err := sw.AutoSwitch(); err == nil {
				state.AutoSwitch = &on
			}
		}
	}
	if state.Capture == nil {
		if capture, ok := any(provider).(AudioCapture); ok {
			if cs, err := capture.GetCaptureState(); err == nil {
				state.Capture = &cs
			}
		}
	}
	return state
}

// --- events wiring (framework-internal) ------------------------------------

// audioEvents implements AudioEvents by forwarding to the service's namespaced
// emitter: Changed(st) → Emit("changed", st) → window.strux.audio.on("changed").
// It enriches the provider-supplied state first, so pushed events carry the same
// composed shape (outputs + optional fields) as a GetState pull.
type audioEvents struct {
	emit func(event string, data any)
}

func (e audioEvents) Changed(state AudioState) {
	e.emit("changed", enrichAudioState(state))
}

// start is the unexported lifecycle hook the runtime calls once after this
// service is registered and bound. All it supplies is the capability-specific
// glue — the ctx/goroutine/error plumbing lives in monitor.run. Unexported so it
// is never reflected to the frontend nor callable from app Go.
func (s *AudioService) start() {
	provider, ok := Audio.Provider()
	if !ok {
		return
	}
	s.run("audio", func(ctx context.Context) error {
		return provider.Start(ctx, audioEvents{emit: s.Emit})
	})
}

// stop is the unexported teardown hook the runtime calls on shutdown, bounded by
// ctx's deadline. monitor.stopWith runs the provider's Stop (mute amps) first,
// then unwinds the monitor loop — never past the deadline.
func (s *AudioService) stop(ctx context.Context) error {
	provider, ok := Audio.Provider()
	if !ok {
		return nil
	}
	return s.stopWith(ctx, provider.Stop)
}
