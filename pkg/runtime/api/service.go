package api

import (
	"context"
	"fmt"
	"os"
	"runtime/debug"
)

// Per-service event system.
//
// Any API service can emit events to the frontend by embedding Service. Calling
// Emit("changed", data) on a service registered as "strux.audio" delivers the
// event to window.strux.audio.on("changed", cb) in the frontend.
//
// This is a framework channel, deliberately separate from the app-facing
// window.strux.ipc bus (rt.Emit): system/service events never collide with an
// application's own event names, and each service's events are part of its own
// namespace contract.

// reservedEventMethods are method names owned by the per-service event system.
// A service must not expose Go methods with these names: Emit is provided by the
// embedded Service, and on/off are injected onto the frontend service object.
// They are filtered out of the RPC method bindings (see Registry.extractMethods).
var reservedEventMethods = map[string]bool{
	"Emit": true,
	"On":   true,
	"Off":  true,
}

// IsReservedMethodName reports whether a method name is reserved by the
// per-service event system and must not be exposed as a callable RPC method.
func IsReservedMethodName(name string) bool {
	return reservedEventMethods[name]
}

// Service is embedded by API services to give them a namespaced event emitter.
//
//	type AudioService struct {
//	    api.Service
//	}
//	...
//	s.Emit("changed", state) // -> window.strux.audio.on("changed", cb)
//
// The namespace path and transport are wired automatically at registration via
// BindService, so a service only ever calls Emit.
type Service struct {
	eventPath string
	eventSink func(event string, data any)
}

// Emit publishes a system event under this service's namespace. For a service
// registered at path "strux.audio", Emit("changed", data) is delivered to
// window.strux.audio.on("changed", ...). It is a no-op until the service is
// bound (BindService), so calling it from an unregistered instance is safe.
func (s *Service) Emit(event string, data any) {
	if s.eventSink != nil && s.eventPath != "" {
		s.eventSink(s.eventPath+":"+event, data)
	}
}

// bindEvents is the framework hook used by BindService. It is unexported so it
// never appears in the reflected RPC method set.
func (s *Service) bindEvents(path string, sink func(event string, data any)) {
	s.eventPath = path
	s.eventSink = sink
}

// serviceEventBinder is satisfied by any type that embeds Service.
type serviceEventBinder interface {
	bindEvents(path string, sink func(event string, data any))
}

// BindService wires a service instance's embedded Service emitter to its
// frontend namespace path (e.g. "strux.audio") and the runtime's system-event
// sink. It is a no-op for instances that do not embed Service.
func BindService(instance any, path string, sink func(event string, data any)) {
	if b, ok := instance.(serviceEventBinder); ok {
		b.bindEvents(path, sink)
	}
}

// startable is the unexported lifecycle hook the runtime triggers once after a
// service is registered and bound. Services that need to do background setup
// (e.g. AudioService starting its provider's change loop) implement start().
// It is unexported so it never appears in the reflected RPC surface and is not
// callable from app Go.
type startable interface {
	start()
}

// StartService runs a service instance's lifecycle hook if it has one. Exported
// so the runtime (another package) can trigger it; the hook itself stays
// unexported. No-op for services without a start().
func StartService(instance any) {
	if s, ok := instance.(startable); ok {
		s.start()
	}
}

// stoppable is the unexported teardown counterpart to startable. A service that
// holds hardware or a background loop (e.g. AudioService) implements stop() to
// release it on shutdown, bounded by ctx's deadline. Unexported so it never
// appears in the reflected RPC surface.
type stoppable interface {
	stop(ctx context.Context) error
}

// StopService runs a service instance's teardown hook if it has one, bounded by
// ctx. The runtime calls this for every registered service on shutdown so a BSP
// can, for example, mute amplifiers before power is cut. No-op (nil) for
// services without a stop().
func StopService(ctx context.Context, instance any) error {
	if s, ok := instance.(stoppable); ok {
		return s.stop(ctx)
	}
	return nil
}

// monitor manages a provider's background lifecycle for a service: a cancellable
// context, the goroutine running the provider's Start loop, and a graceful,
// deadline-bounded Stop. A service that drives a provider embeds monitor (next
// to Service) and supplies only the capability-specific glue in start()/stop() —
// the ctx/goroutine/stop plumbing is identical across capabilities and lives
// here, once.
type monitor struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// run launches fn — the provider's Start loop — in a framework-owned goroutine
// with a cancellable context. An error that is not the result of our own
// shutdown cancel is logged under label; the app never crashes on a provider
// fault.
func (m *monitor) run(label string, fn func(ctx context.Context) error) {
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.done = make(chan struct{})
	go func() {
		defer close(m.done)
		// A provider panic must not take down the whole app (and with it the
		// backend health endpoint dev mode waits on). Recover, log, and leave the
		// capability degraded instead.
		defer func() {
			if r := recover(); r != nil {
				fmt.Fprintf(os.Stderr, "Strux Runtime: %s provider panicked: %v\n%s\n", label, r, debug.Stack())
			}
		}()
		if err := fn(ctx); err != nil && ctx.Err() == nil {
			fmt.Fprintf(os.Stderr, "Strux Runtime: %s provider start failed: %v\n", label, err)
		}
	}()
}

// stopWith runs the provider's deadline-bounded teardown (shutdown) first, then
// cancels the monitor loop and waits for the goroutine to exit — never past ctx.
// shutdown may be nil for a service whose provider has no Stop.
func (m *monitor) stopWith(ctx context.Context, shutdown func(context.Context) error) error {
	var err error
	if shutdown != nil {
		err = shutdown(ctx)
	}
	if m.cancel != nil {
		m.cancel()
	}
	if m.done != nil {
		select {
		case <-m.done:
		case <-ctx.Done():
		}
	}
	return err
}
