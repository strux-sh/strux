package api

import (
	"errors"
	"reflect"
	"testing"
)

func TestDeviceSigningCapabilityMetadata(t *testing.T) {
	info := DeviceSigning.Info()
	if info.Name != "device-signing" || info.Namespace != "deviceSigning" {
		t.Fatalf("unexpected capability identity: %#v", info)
	}
	if info.Supported {
		t.Fatal("device signing should remain unsupported when no BSP provider is registered")
	}

	wantMethods := []string{"GetStatus", "GenerateKey", "GetPublicKey", "SignChallenge"}
	if len(info.Methods) != len(wantMethods) {
		t.Fatalf("expected %d methods, got %#v", len(wantMethods), info.Methods)
	}
	for index, want := range wantMethods {
		if info.Methods[index].Name != want {
			t.Errorf("method %d: want %q, got %q", index, want, info.Methods[index].Name)
		}
	}
}

func TestDeviceSigningWithoutProviderIsUnsupported(t *testing.T) {
	service := DeviceSigningService{}
	operations := []func() error{
		func() error { _, err := service.GetStatus(); return err },
		func() error { _, err := service.GenerateKey(); return err },
		func() error { _, err := service.GetPublicKey(); return err },
		func() error { _, err := service.SignChallenge(DeviceSignRequest{}); return err },
	}

	for index, operation := range operations {
		var unsupported UnsupportedError
		if err := operation(); !errors.As(err, &unsupported) {
			t.Fatalf("operation %d: expected UnsupportedError, got %T: %v", index, err, err)
		}
		if unsupported.Capability != CapabilityDeviceSigning {
			t.Fatalf("operation %d: expected capability %q, got %q", index, CapabilityDeviceSigning, unsupported.Capability)
		}
	}
}

func TestDeviceSigningRequestBounds(t *testing.T) {
	valid := DeviceSignRequest{Purpose: "enrollment", Audience: "fleet.example", Nonce: "nonce"}
	if err := validateDeviceSignRequest(valid); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}

	tests := []DeviceSignRequest{
		{Purpose: "", Audience: valid.Audience, Nonce: valid.Nonce},
		{Purpose: valid.Purpose, Audience: "", Nonce: valid.Nonce},
		{Purpose: valid.Purpose, Audience: valid.Audience, Nonce: ""},
		{Purpose: string(make([]byte, 65)), Audience: valid.Audience, Nonce: valid.Nonce},
		{Purpose: valid.Purpose, Audience: string(make([]byte, 257)), Nonce: valid.Nonce},
		{Purpose: valid.Purpose, Audience: valid.Audience, Nonce: string(make([]byte, 1025))},
	}
	for index, request := range tests {
		if err := validateDeviceSignRequest(request); err == nil {
			t.Errorf("invalid request %d was accepted", index)
		}
	}
}

func TestDeviceSigningDTOsDoNotExposePrivateKeyFields(t *testing.T) {
	for _, typ := range []reflect.Type{
		reflect.TypeOf(DeviceSigningStatus{}),
		reflect.TypeOf(DevicePublicKey{}),
		reflect.TypeOf(GenerateDeviceSigningKeyResult{}),
		reflect.TypeOf(DeviceSignature{}),
	} {
		for index := 0; index < typ.NumField(); index++ {
			field := typ.Field(index)
			if field.Name == "PrivateKey" || field.Tag.Get("json") == "privateKey" {
				t.Fatalf("%s exposes private key material through field %s", typ.Name(), field.Name)
			}
		}
	}
}
