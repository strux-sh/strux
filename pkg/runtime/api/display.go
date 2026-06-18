package api

import (
	"errors"
	"fmt"
)

const (
	DisplayNamespace = "display"

	// CapabilityDisplay is implemented by BSPs that provide backlight control.
	CapabilityDisplay = "display"
)

// ErrUnknownDisplayOutput is returned when no matching output exists for List/Get lookups.
var ErrUnknownDisplayOutput = errors.New("unknown display output")

// ErrNoDisplayOutputChanges reports an empty Apply call.
var ErrNoDisplayOutputChanges = errors.New("no display changes to apply")

// OutputTransform is rotation or mirroring of the output image.
type OutputTransform string

const (
	TransformNormal     OutputTransform = "normal"
	Transform90         OutputTransform = "90"
	Transform180        OutputTransform = "180"
	Transform270        OutputTransform = "270"
	TransformFlipped    OutputTransform = "flipped"
	TransformFlipped90  OutputTransform = "flipped-90"
	TransformFlipped180 OutputTransform = "flipped-180"
	TransformFlipped270 OutputTransform = "flipped-270"
)

// DisplayMode is one video timing the system reports for a display.
type DisplayMode struct {
	WidthPX   int     `json:"widthPx"`
	HeightPX  int     `json:"heightPx"`
	RefreshHz float64 `json:"refreshHz,omitempty"`
	Preferred bool    `json:"preferred"`
	IsCurrent bool    `json:"current"`
}

// DisplayOutput is a snapshot of one logical display and its configuration.
type DisplayOutput struct {
	Name             string          `json:"name"`
	Description      string          `json:"description"`
	PhysicalWidthMM  int32           `json:"physicalWidthMm"`
	PhysicalHeightMM int32           `json:"physicalHeightMm"`
	Enabled          bool            `json:"enabled"`
	Modes            []DisplayMode   `json:"modes"`
	Current          *DisplayMode    `json:"current,omitempty"`
	PositionX        int32           `json:"positionX"`
	PositionY        int32           `json:"positionY"`
	Transform        OutputTransform `json:"transform"`
	Scale            float64         `json:"scale"`
}

// ListedModeSelection picks a timing from the advertised list (width, height, optional refresh).
// RefreshMilliHz 0 matches the first entry for that size regardless of refresh.
type ListedModeSelection struct {
	Width          int `json:"width"`
	Height         int `json:"height"`
	RefreshMilliHz int `json:"refreshMilliHz"`
}

// CustomModeSelection requests a timing that may not appear in the advertised list.
type CustomModeSelection struct {
	Width          int `json:"width"`
	Height         int `json:"height"`
	RefreshMilliHz int `json:"refreshMilliHz"`
}

// DisplayOutputChange describes updates for one logical display inside an Apply batch.
type DisplayOutputChange struct {
	Name string `json:"name"`

	On *bool `json:"on,omitempty"`

	ListedMode   *ListedModeSelection `json:"listedMode,omitempty"`
	CustomMode   *CustomModeSelection `json:"customMode,omitempty"`
	UsePreferred bool                 `json:"usePreferred,omitempty"`

	PositionX *int32 `json:"positionX,omitempty"`
	PositionY *int32 `json:"positionY,omitempty"`

	Scale *float64 `json:"scale,omitempty"`

	Transform *OutputTransform `json:"transform,omitempty"`
}

// DisplayApplyOptions modifies Apply behavior (e.g. validate without committing).
type DisplayApplyOptions struct {
	DryRun bool `json:"dryRun,omitempty"`
}

// DisplayProvider supplies BSP-specific backlight control. Other display APIs are
// implemented by the runtime and do not use this hook.
type DisplayProvider interface {
	GetBacklight(displayName string) (int, error)
	SetBacklight(displayName string, value int) error
}

var Display = DefineCapability[DisplayProvider](CapabilitySpec{
	Name:        CapabilityDisplay,
	Namespace:   DisplayNamespace,
	Description: "BSP backlight integration. Standard display listing and configuration are provided by the runtime.",
	Methods: []MethodSpec{
		{Name: "List", Description: "Returns every connected logical display with advertised timings, active timing, layout, scale, and transform."},
		{Name: "Get", Description: "Returns the same snapshot as List for a single display name."},
		{Name: "Apply", Description: "Applies several display updates in one step so multi-head kiosks stay consistent."},
		{Name: "SetListedMode", Description: "Switches a display to an advertised width, height, and optional refresh rate."},
		{Name: "SetCustomMode", Description: "Drives a display with a timing that may not be in the advertised list."},
		{Name: "SetPreferredMode", Description: "Selects the display's preferred timing when the driver exposes one."},
		{Name: "SetOutputEnabled", Description: "Turns video to that display on or off (compositor stops or resumes driving the output)."},
		{Name: "SetLayout", Description: "Sets the display's position in the global compositor layout."},
		{Name: "SetScale", Description: "Sets fractional UI scaling for that display."},
		{Name: "SetTransform", Description: "Sets rotation or mirroring for that display."},
		{Name: "GetBacklight", Description: "Returns the current backlight level for that display (typically 0-100)."},
		{Name: "SetBacklight", Description: "Sets the backlight level for that display (typically 0-100)."},
	},
})

func RegisterDisplayProvider(provider DisplayProvider) {
	Display.RegisterOrPanic(provider)
}

// DisplayService exposes Strux-standard display tooling to kiosk apps through the IPC bridge.
type DisplayService struct{}

// List returns all logical displays and their current configuration.
func (DisplayService) List() ([]DisplayOutput, error) {
	return displayList()
}

// Get returns snapshot data for a validated output identifier.
func (DisplayService) Get(name string) (DisplayOutput, error) {
	list, err := displayList()
	if err != nil {
		return DisplayOutput{}, err
	}

	if err := validateDisplayOutputIdentifier(name); err != nil {
		return DisplayOutput{}, err
	}

	for _, out := range list {
		if out.Name == name {
			return out, nil
		}
	}

	return DisplayOutput{}, fmt.Errorf("%w: %s", ErrUnknownDisplayOutput, name)
}

// Apply applies one or more display updates in a single operation.
func (DisplayService) Apply(changes []DisplayOutputChange, opts DisplayApplyOptions) error {
	return execWlrRandrApply(contextFromEnv(), changes, opts)
}

// SetListedMode switches one display to an advertised timing.
func (DisplayService) SetListedMode(output string, mode ListedModeSelection, opts DisplayApplyOptions) error {
	m := mode
	return execWlrRandrApply(contextFromEnv(), []DisplayOutputChange{{Name: output, ListedMode: &m}}, opts)
}

// SetCustomMode drives one display with a timing outside the advertised list.
func (DisplayService) SetCustomMode(output string, mode CustomModeSelection, opts DisplayApplyOptions) error {
	m := mode
	return execWlrRandrApply(contextFromEnv(), []DisplayOutputChange{{Name: output, CustomMode: &m}}, opts)
}

// SetPreferredMode selects the preferred timing for one display when available.
func (DisplayService) SetPreferredMode(output string, opts DisplayApplyOptions) error {
	return execWlrRandrApply(contextFromEnv(), []DisplayOutputChange{{Name: output, UsePreferred: true}}, opts)
}

// SetOutputEnabled turns compositor video output on or off for that display.
func (DisplayService) SetOutputEnabled(output string, on bool, opts DisplayApplyOptions) error {
	flag := on
	return execWlrRandrApply(contextFromEnv(), []DisplayOutputChange{{Name: output, On: &flag}}, opts)
}

// SetLayout moves a display within the compositor layout.
func (DisplayService) SetLayout(output string, x int32, y int32, opts DisplayApplyOptions) error {
	px, py := x, y
	return execWlrRandrApply(contextFromEnv(), []DisplayOutputChange{{
		Name:      output,
		PositionX: &px,
		PositionY: &py,
	}}, opts)
}

// SetScale sets output scaling for fractional UI density.
func (DisplayService) SetScale(output string, scale float64, opts DisplayApplyOptions) error {
	s := scale
	return execWlrRandrApply(contextFromEnv(), []DisplayOutputChange{{Name: output, Scale: &s}}, opts)
}

// SetTransform sets rotation or mirroring for one display.
func (DisplayService) SetTransform(output string, transform OutputTransform, opts DisplayApplyOptions) error {
	t := transform
	return execWlrRandrApply(contextFromEnv(), []DisplayOutputChange{{Name: output, Transform: &t}}, opts)
}

func (DisplayService) GetBacklight(outputName string) (int, error) {
	provider, ok := Display.Provider()
	if !ok {
		return 0, UnsupportedError{Capability: CapabilityDisplay}
	}
	return provider.GetBacklight(outputName)
}

func (DisplayService) SetBacklight(outputName string, value int) error {
	if value < 0 || value > 100 {
		return fmt.Errorf("backlight value must be between 0 and 100")
	}

	provider, ok := Display.Provider()
	if !ok {
		return UnsupportedError{Capability: CapabilityDisplay}
	}
	return provider.SetBacklight(outputName, value)
}

func displayList() ([]DisplayOutput, error) {
	stdout, _, err := execWlrRandrCapture(contextFromEnv())
	if err != nil {
		return nil, err
	}
	out, parseErr := parseWlrRandrStdout(string(stdout))
	if parseErr != nil {
		return nil, parseErr
	}
	return out, nil
}
