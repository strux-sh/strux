package api

import (
	"fmt"
	"reflect"
	"slices"
	"sync"
)

// MethodSpec describes a method on a Strux standard API.
type MethodSpec struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// FeatureSpec declares an OPTIONAL group of methods (and events) a provider MAY
// implement on top of a capability's mandatory contract. The provider opts in
// simply by satisfying Requires — a Go interface type, built with
// InterfaceType[I](). The framework detects this at runtime (reflect Implements)
// and reports per-feature availability through strux.capabilities, so the
// frontend can show or hide UI without the BSP stubbing methods it cannot back.
//
// A feature's Methods are always present on the reflected service surface; when
// the active provider does not implement Requires, calling one returns an
// UnsupportedFeatureError (see featureOf).
type FeatureSpec struct {
	Name        string
	Description string
	// Requires is the optional interface a provider must satisfy for this
	// feature to be live. Build it with InterfaceType[I](). Must be an interface.
	Requires reflect.Type
	Methods  []MethodSpec
	Events   []EventSpec
}

// FeatureInfo is the introspection view of a FeatureSpec: its static metadata
// plus Available, computed from whether the registered provider satisfies the
// feature's interface. Surfaced in CapabilityInfo.Features and, through that,
// in strux.capabilities.
type FeatureInfo struct {
	Name        string       `json:"name"`
	Description string       `json:"description,omitempty"`
	Available   bool         `json:"available"` // active provider implements Requires
	Methods     []MethodSpec `json:"methods"`
	Events      []EventSpec  `json:"events"`
}

// InterfaceType returns the reflect.Type of interface I. It is the helper used
// to populate FeatureSpec.Requires:
//
//	Requires: InterfaceType[AudioAutoSwitch]()
func InterfaceType[I any]() reflect.Type {
	return reflect.TypeOf((*I)(nil)).Elem()
}

// EventSpec describes an event a Strux standard API emits to the frontend
// (window.strux.<namespace>.on(name, cb)). It is the human- and JS-readable
// counterpart to the typed Go events interface (e.g. AudioEvents): the interface
// is what the compiler enforces, EventSpec is what surfaces in strux.capabilities.
type EventSpec struct {
	Name        string `json:"name"`              // event name, e.g. "changed"
	Description string `json:"description,omitempty"`
	Payload     string `json:"payload,omitempty"` // payload type name, e.g. "AudioState"
}

// CapabilityInfo describes whether a Strux standard API capability is backed by the active BSP.
type CapabilityInfo struct {
	Name        string       `json:"name"`
	Namespace   string       `json:"namespace"`
	Description string       `json:"description,omitempty"`
	Supported   bool          `json:"supported"`
	Provider    string        `json:"provider,omitempty"`
	Methods     []MethodSpec  `json:"methods"`
	Events      []EventSpec   `json:"events"`
	Features    []FeatureInfo `json:"features"`
}

// CapabilitySpec describes a Strux standard API capability contract.
type CapabilitySpec struct {
	Name        string
	Namespace   string
	Description string
	Methods     []MethodSpec
	Events      []EventSpec
	// Features declares optional method groups a provider may implement on top
	// of the mandatory contract. See FeatureSpec.
	Features []FeatureSpec
}

type registeredCapability interface {
	Name() string
	Info() CapabilityInfo
	Supports() bool
}

// Capability is a typed Strux standard API capability contract.
type Capability[T any] struct {
	name        string
	namespace   string
	description string
	methods     []MethodSpec
	events      []EventSpec
	features    []FeatureSpec

	mu          sync.RWMutex
	provider    T
	hasProvider bool
}

var (
	capabilitiesMu sync.RWMutex
	capabilities   = make(map[string]registeredCapability)
	capabilityIDs  []string
)

// DefineCapability creates and registers a typed Strux standard API capability.
func DefineCapability[T any](spec CapabilitySpec) *Capability[T] {
	if spec.Name == "" {
		panic("capability name cannot be empty")
	}
	if spec.Namespace == "" {
		panic(fmt.Sprintf("capability %s namespace cannot be empty", spec.Name))
	}
	for _, f := range spec.Features {
		if f.Requires == nil {
			panic(fmt.Sprintf("capability %s feature %q must set Requires (use InterfaceType[I]())", spec.Name, f.Name))
		}
		if f.Requires.Kind() != reflect.Interface {
			panic(fmt.Sprintf("capability %s feature %q Requires must be an interface type, got %s", spec.Name, f.Name, f.Requires.Kind()))
		}
	}

	capability := &Capability[T]{
		name:        spec.Name,
		namespace:   spec.Namespace,
		description: spec.Description,
		methods:     slices.Clone(spec.Methods),
		events:      slices.Clone(spec.Events),
		features:    slices.Clone(spec.Features),
	}

	capabilitiesMu.Lock()
	defer capabilitiesMu.Unlock()
	if _, exists := capabilities[spec.Name]; exists {
		panic(fmt.Sprintf("capability %s already defined", spec.Name))
	}
	capabilities[spec.Name] = capability
	capabilityIDs = append(capabilityIDs, spec.Name)
	slices.Sort(capabilityIDs)

	return capability
}

// Name returns the stable capability identifier.
func (c *Capability[T]) Name() string {
	return c.name
}

// Register sets the provider for this capability.
func (c *Capability[T]) Register(provider T) error {
	if isNil(provider) {
		return fmt.Errorf("%s provider cannot be nil", c.name)
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if c.hasProvider {
		return fmt.Errorf("%s provider already registered", c.name)
	}

	c.provider = provider
	c.hasProvider = true
	return nil
}

// RegisterOrPanic sets the provider for this capability and panics on failure.
func (c *Capability[T]) RegisterOrPanic(provider T) {
	if err := c.Register(provider); err != nil {
		panic(err)
	}
}

// Provider returns the currently registered provider for this capability.
func (c *Capability[T]) Provider() (T, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.provider, c.hasProvider
}

// providerOf returns the registered provider for a capability, or an
// UnsupportedError naming it when no BSP has registered one. It centralizes the
// "is this board's capability available?" check every Service method makes, so a
// delegating method collapses to: get provider (or return unsupported), forward.
func providerOf[T any](c *Capability[T]) (T, error) {
	provider, ok := c.Provider()
	if !ok {
		var zero T
		return zero, UnsupportedError{Capability: c.Name()}
	}
	return provider, nil
}

// capabilityRef is the non-generic view of a Capability that featureOf needs:
// its name, its provider as an untyped value, and feature-name lookup. Every
// *Capability[T] satisfies it.
type capabilityRef interface {
	Name() string
	providerAny() (any, bool)
	featureName(reflect.Type) string
}

// featureOf returns the active provider asserted to optional feature interface
// F. It is the feature-aware counterpart to providerOf:
//
//   - no provider registered      → UnsupportedError
//   - provider lacks the feature  → UnsupportedFeatureError (named via the spec)
//   - provider implements F       → the feature handle, ready to call
//
// A delegating service method collapses to: get feature (or return the error),
// forward.
func featureOf[F any](c capabilityRef) (F, error) {
	var zero F
	provider, ok := c.providerAny()
	if !ok {
		return zero, UnsupportedError{Capability: c.Name()}
	}
	feature, ok := provider.(F)
	if !ok {
		return zero, UnsupportedFeatureError{
			Capability: c.Name(),
			Feature:    c.featureName(InterfaceType[F]()),
		}
	}
	return feature, nil
}

// Supports returns true when a provider has been registered for this capability.
func (c *Capability[T]) Supports() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.hasProvider
}

// Info returns public introspection metadata for this capability.
func (c *Capability[T]) Info() CapabilityInfo {
	c.mu.RLock()
	defer c.mu.RUnlock()

	info := CapabilityInfo{
		Name:        c.name,
		Namespace:   c.namespace,
		Description: c.description,
		Supported:   c.hasProvider,
		Methods:     slices.Clone(c.methods),
		Events:      slices.Clone(c.events),
		Features:    c.featureInfo(),
	}
	if c.hasProvider {
		info.Provider = providerTypeName(c.provider)
	}

	return info
}

// featureInfo builds the per-feature introspection view, computing Available
// from whether the registered provider satisfies each feature's interface.
// Caller holds c.mu (RLock); Info() is the only caller.
func (c *Capability[T]) featureInfo() []FeatureInfo {
	if len(c.features) == 0 {
		return nil
	}
	var providerType reflect.Type
	if c.hasProvider {
		providerType = reflect.TypeOf(c.provider)
	}

	out := make([]FeatureInfo, 0, len(c.features))
	for _, f := range c.features {
		out = append(out, FeatureInfo{
			Name:        f.Name,
			Description: f.Description,
			Available:   providerType != nil && f.Requires != nil && providerType.Implements(f.Requires),
			Methods:     slices.Clone(f.Methods),
			Events:      slices.Clone(f.Events),
		})
	}
	return out
}

// providerAny returns the registered provider as an untyped value, for feature
// interface assertions in featureOf. It mirrors Provider() without the generic
// type parameter so a non-generic helper can reach it.
func (c *Capability[T]) providerAny() (any, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if !c.hasProvider {
		return nil, false
	}
	return any(c.provider), true
}

// featureName returns the declared name of the feature whose Requires interface
// is requires, or "" when no such feature is declared. Used to label
// UnsupportedFeatureError.
func (c *Capability[T]) featureName(requires reflect.Type) string {
	for _, f := range c.features {
		if f.Requires == requires {
			return f.Name
		}
	}
	return ""
}

// ListCapabilities returns every defined Strux standard API capability.
func ListCapabilities() []CapabilityInfo {
	capabilitiesMu.RLock()
	defer capabilitiesMu.RUnlock()

	list := make([]CapabilityInfo, 0, len(capabilityIDs))
	for _, name := range capabilityIDs {
		list = append(list, capabilities[name].Info())
	}
	return list
}

// SupportsCapability returns true when the named Strux standard API capability has a registered provider.
func SupportsCapability(name string) bool {
	capabilitiesMu.RLock()
	defer capabilitiesMu.RUnlock()

	capability, ok := capabilities[name]
	if !ok {
		return false
	}
	return capability.Supports()
}

// UnsupportedError reports that the active BSP does not implement a capability.
type UnsupportedError struct {
	Capability string `json:"capability"`
}

func (e UnsupportedError) Error() string {
	return fmt.Sprintf("capability %s is not supported by the active BSP", e.Capability)
}

// UnsupportedFeatureError reports that the active BSP implements a capability but
// not one of its optional features (see FeatureSpec). Distinct from
// UnsupportedError, which means the whole capability is absent.
type UnsupportedFeatureError struct {
	Capability string `json:"capability"`
	Feature    string `json:"feature,omitempty"`
}

func (e UnsupportedFeatureError) Error() string {
	if e.Feature == "" {
		return fmt.Sprintf("capability %s does not support the requested optional feature on the active BSP", e.Capability)
	}
	return fmt.Sprintf("capability %s optional feature %q is not supported by the active BSP", e.Capability, e.Feature)
}

const CapabilitiesNamespace = "capabilities"

// CapabilitiesService exposes Strux standard API support to Go applications.
type CapabilitiesService struct{}

// List returns every Strux standard capability and whether the active BSP supports it.
func (s *CapabilitiesService) List() []CapabilityInfo {
	return ListCapabilities()
}

// Supports returns true when the named Strux standard capability has a registered provider.
func (s *CapabilitiesService) Supports(name string) bool {
	return SupportsCapability(name)
}

func isNil(value interface{}) bool {
	if value == nil {
		return true
	}
	val := reflect.ValueOf(value)
	switch val.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Ptr, reflect.Slice:
		return val.IsNil()
	default:
		return false
	}
}

func providerTypeName(provider interface{}) string {
	typ := reflect.TypeOf(provider)
	if typ == nil {
		return ""
	}
	if typ.Kind() == reflect.Ptr {
		typ = typ.Elem()
	}
	if typ.PkgPath() == "" {
		return typ.Name()
	}
	return typ.PkgPath() + "." + typ.Name()
}
