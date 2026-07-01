package api

import (
	"errors"
	"testing"
)

// A tiny capability with one optional feature, used to exercise the
// feature-availability detection and featureOf dispatch.

type featContract interface {
	Ping() error
}

type featExtra interface {
	Extra() error
}

// baseProvider satisfies only the contract — the optional feature is absent.
type baseProvider struct{}

func (baseProvider) Ping() error { return nil }

// fullProvider also satisfies the optional feature.
type fullProvider struct{}

func (fullProvider) Ping() error  { return nil }
func (fullProvider) Extra() error { return nil }

func newFeatureCap(name string) *Capability[featContract] {
	return DefineCapability[featContract](CapabilitySpec{
		Name:      name,
		Namespace: name,
		Methods:   []MethodSpec{{Name: "Ping"}},
		Features: []FeatureSpec{{
			Name:     "extra",
			Requires: InterfaceType[featExtra](),
			Methods:  []MethodSpec{{Name: "Extra"}},
		}},
	})
}

func featureInfoByName(info CapabilityInfo, name string) (FeatureInfo, bool) {
	for _, f := range info.Features {
		if f.Name == name {
			return f, true
		}
	}
	return FeatureInfo{}, false
}

func TestFeatureUnavailableWhenProviderLacksInterface(t *testing.T) {
	cap := newFeatureCap("feat-base")
	cap.RegisterOrPanic(baseProvider{})

	feat, ok := featureInfoByName(cap.Info(), "extra")
	if !ok {
		t.Fatal("expected an 'extra' feature in capability info")
	}
	if feat.Available {
		t.Error("feature should be unavailable when the provider does not implement it")
	}

	if _, err := featureOf[featExtra](cap); err == nil {
		t.Fatal("featureOf should fail when the provider lacks the feature")
	} else {
		var ufe UnsupportedFeatureError
		if !errors.As(err, &ufe) {
			t.Fatalf("expected UnsupportedFeatureError, got %T: %v", err, err)
		}
		if ufe.Feature != "extra" {
			t.Errorf("error should name the feature %q, got %q", "extra", ufe.Feature)
		}
	}
}

func TestFeatureAvailableWhenProviderImplementsInterface(t *testing.T) {
	cap := newFeatureCap("feat-full")
	cap.RegisterOrPanic(fullProvider{})

	feat, ok := featureInfoByName(cap.Info(), "extra")
	if !ok {
		t.Fatal("expected an 'extra' feature in capability info")
	}
	if !feat.Available {
		t.Error("feature should be available when the provider implements it")
	}

	if _, err := featureOf[featExtra](cap); err != nil {
		t.Errorf("featureOf should succeed when the provider implements the feature: %v", err)
	}
}

func TestFeatureOfWithoutProviderIsUnsupported(t *testing.T) {
	cap := newFeatureCap("feat-empty")

	if _, err := featureOf[featExtra](cap); err == nil {
		t.Fatal("featureOf should fail when no provider is registered")
	} else {
		var ue UnsupportedError
		if !errors.As(err, &ue) {
			t.Fatalf("expected UnsupportedError when no provider, got %T: %v", err, err)
		}
	}
}

func TestDefineCapabilityRejectsNonInterfaceFeature(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("DefineCapability should panic when a feature's Requires is not an interface")
		}
	}()

	DefineCapability[featContract](CapabilitySpec{
		Name:      "feat-bad",
		Namespace: "feat-bad",
		Features: []FeatureSpec{{
			Name:     "broken",
			Requires: InterfaceType[int](), // not an interface
		}},
	})
}
