package api

import "context"

const (
	BatteryNamespace = "battery"

	// CapabilityBattery is implemented by BSPs whose devices have a battery.
	CapabilityBattery = "battery"
)

// BatteryState is a normalized snapshot of the device battery and external
// power state. Status uses Linux power-supply names normalized to lowercase:
// charging, discharging, full, not-charging, or unknown.
type BatteryState struct {
	Percent        int    `json:"percent"`
	Status         string `json:"status"`
	Charging       bool   `json:"charging"`
	PowerConnected bool   `json:"powerConnected"`
	Health         string `json:"health"`
}

// BatteryEvents is the typed event surface a BSP emits through.
type BatteryEvents interface {
	Changed(state BatteryState)
}

// BatteryOps is the mandatory battery operation surface.
type BatteryOps interface {
	GetState() (BatteryState, error)
}

// BatteryContract is implemented by battery-capable BSPs. Start monitors the
// hardware until ctx is cancelled and emits a Changed event for each update.
type BatteryContract interface {
	BatteryOps
	Start(ctx context.Context, events BatteryEvents) error
	Stop(ctx context.Context) error
}

var Battery = DefineCapability[BatteryContract](CapabilitySpec{
	Name:        CapabilityBattery,
	Namespace:   BatteryNamespace,
	Description: "BSP battery status: charge percentage, charging state, external power, and health, with live change events.",
	Methods: []MethodSpec{
		{Name: "GetState", Description: "Returns the current battery and external-power state."},
	},
	Events: []EventSpec{
		{Name: "changed", Description: "Emitted whenever the battery percentage or charging state changes.", Payload: "BatteryState"},
	},
})

// RegisterBatteryProvider plugs a BSP battery implementation into the capability.
func RegisterBatteryProvider(provider BatteryContract) {
	Battery.RegisterOrPanic(provider)
}

// BatteryService is the app-facing window.strux.battery surface.
type BatteryService struct {
	Service
	monitor
}

var (
	_ BatteryOps    = BatteryService{}
	_ BatteryEvents = batteryEvents{}
)

func (BatteryService) GetState() (BatteryState, error) {
	provider, err := providerOf(Battery)
	if err != nil {
		return BatteryState{}, err
	}
	return provider.GetState()
}

type batteryEvents struct {
	emit func(event string, data any)
}

func (e batteryEvents) Changed(state BatteryState) {
	e.emit("changed", state)
}

func (s *BatteryService) start() {
	provider, ok := Battery.Provider()
	if !ok {
		return
	}
	s.run("battery", func(ctx context.Context) error {
		return provider.Start(ctx, batteryEvents{emit: s.Emit})
	})
}

func (s *BatteryService) stop(ctx context.Context) error {
	provider, ok := Battery.Provider()
	if !ok {
		return nil
	}
	return s.stopWith(ctx, provider.Stop)
}
