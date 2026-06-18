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

// CapabilityInfo describes whether a Strux standard API capability is backed by the active BSP.
type CapabilityInfo struct {
	Name        string       `json:"name"`
	Namespace   string       `json:"namespace"`
	Description string       `json:"description,omitempty"`
	Supported   bool         `json:"supported"`
	Provider    string       `json:"provider,omitempty"`
	Methods     []MethodSpec `json:"methods"`
}

// CapabilitySpec describes a Strux standard API capability contract.
type CapabilitySpec struct {
	Name        string
	Namespace   string
	Description string
	Methods     []MethodSpec
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

	capability := &Capability[T]{
		name:        spec.Name,
		namespace:   spec.Namespace,
		description: spec.Description,
		methods:     slices.Clone(spec.Methods),
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
	}
	if c.hasProvider {
		info.Provider = providerTypeName(c.provider)
	}

	return info
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
