package api

import (
	"fmt"
	"strings"
)

const (
	DeviceSigningNamespace = "deviceSigning"

	// CapabilityDeviceSigning is implemented by BSPs with a device-bound
	// signing backend. A registered provider may still report unavailable while
	// its normal-world client, trusted application, or key is not provisioned.
	CapabilityDeviceSigning = "device-signing"
)

// DeviceSigningReason is a stable machine-readable explanation for an
// unavailable device-signing provider.
type DeviceSigningReason string

const (
	DeviceSigningReasonNone                   DeviceSigningReason = "none"
	DeviceSigningReasonTEEDeviceMissing       DeviceSigningReason = "tee-device-missing"
	DeviceSigningReasonSupplicantMissing      DeviceSigningReason = "tee-supplicant-missing"
	DeviceSigningReasonSupplicantInactive     DeviceSigningReason = "tee-supplicant-inactive"
	DeviceSigningReasonClientLibraryMissing   DeviceSigningReason = "tee-client-library-missing"
	DeviceSigningReasonClientConnectionFailed DeviceSigningReason = "tee-client-connection-failed"
	DeviceSigningReasonTrustedAppMissing      DeviceSigningReason = "trusted-app-not-provisioned"
	DeviceSigningReasonKeyMissing             DeviceSigningReason = "signing-key-not-provisioned"
)

// DeviceSigningStatus describes both the signing backend and the lower-level
// OP-TEE readiness checks needed to diagnose an unavailable provider. Supported
// in strux.capabilities means a BSP provider is compiled in; Available here is
// the stronger promise that signing operations are ready.
type DeviceSigningStatus struct {
	Available                 bool                `json:"available"`
	NormalWorldReady          bool                `json:"normalWorldReady"`
	Reason                    DeviceSigningReason `json:"reason"`
	Detail                    string              `json:"detail,omitempty"`
	Backend                   string              `json:"backend"`
	Algorithm                 string              `json:"algorithm,omitempty"`
	Storage                   string              `json:"storage"`
	KeyPresent                bool                `json:"keyPresent"`
	KeyID                     string              `json:"keyId,omitempty"`
	HardwareBacked            bool                `json:"hardwareBacked"`
	HardwareBound             bool                `json:"hardwareBound"`
	RollbackProtected         bool                `json:"rollbackProtected"`
	TEEDevicePresent          bool                `json:"teeDevicePresent"`
	TEEPrivDevicePresent      bool                `json:"teePrivDevicePresent"`
	SupplicantInstalled       bool                `json:"supplicantInstalled"`
	SupplicantActive          bool                `json:"supplicantActive"`
	ClientLibraryPresent      bool                `json:"clientLibraryPresent"`
	ClientConnected           bool                `json:"clientConnected"`
	ClientResult              string              `json:"clientResult,omitempty"`
	TrustedApplicationPresent bool                `json:"trustedApplicationPresent"`
}

// DevicePublicKey is the public half of a device-bound signing key. Key never
// contains private key material.
type DevicePublicKey struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	Format    string `json:"format"`
	Encoding  string `json:"encoding"`
	Key       string `json:"key"`
}

// GenerateDeviceSigningKeyResult reports whether GenerateKey created a key or
// returned the already-provisioned key. GenerateKey is intentionally
// idempotent; rotation and deletion are not part of this initial contract.
type GenerateDeviceSigningKeyResult struct {
	Created   bool            `json:"created"`
	PublicKey DevicePublicKey `json:"publicKey"`
}

// DeviceSignRequest is a bounded, domain-oriented challenge. Providers must
// not reinterpret it as an arbitrary-data signing interface.
type DeviceSignRequest struct {
	Purpose  string `json:"purpose"`
	Audience string `json:"audience"`
	Nonce    string `json:"nonce"`
}

// DeviceSignature contains only public signature metadata and bytes.
type DeviceSignature struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	Encoding  string `json:"encoding"`
	Signature string `json:"signature"`
}

// DeviceSigningOps is the standard operation surface. Providers must fail
// closed when their trusted application or signing key is not provisioned.
type DeviceSigningOps interface {
	GetStatus() (DeviceSigningStatus, error)
	GenerateKey() (GenerateDeviceSigningKeyResult, error)
	GetPublicKey() (DevicePublicKey, error)
	SignChallenge(request DeviceSignRequest) (DeviceSignature, error)
}

type DeviceSigningContract interface {
	DeviceSigningOps
}

var DeviceSigning = DefineCapability[DeviceSigningContract](CapabilitySpec{
	Name:        CapabilityDeviceSigning,
	Namespace:   DeviceSigningNamespace,
	Description: "Device-bound signing readiness and challenge signing. Providers never expose private key material and fail closed until their trusted backend is provisioned.",
	Methods: []MethodSpec{
		{Name: "GetStatus", Description: "Returns live backend, TEE normal-world readiness, trusted-application, and signing-key status."},
		{Name: "GenerateKey", Description: "Idempotently creates or returns the device signing public key when a trusted backend is provisioned."},
		{Name: "GetPublicKey", Description: "Returns the current device signing public key and key identifier."},
		{Name: "SignChallenge", Description: "Signs a bounded, domain-separated server challenge inside the trusted backend."},
	},
})

func RegisterDeviceSigningProvider(provider DeviceSigningContract) {
	DeviceSigning.RegisterOrPanic(provider)
}

// DeviceSigningUnavailableError is returned by a registered but unhealthy or
// unprovisioned provider. It is distinct from UnsupportedError, which means the
// active BSP has no device-signing provider at all.
type DeviceSigningUnavailableError struct {
	Reason DeviceSigningReason `json:"reason"`
	Detail string              `json:"detail,omitempty"`
}

func (e DeviceSigningUnavailableError) Error() string {
	if e.Detail == "" {
		return fmt.Sprintf("device signing unavailable: %s", e.Reason)
	}
	return fmt.Sprintf("device signing unavailable: %s: %s", e.Reason, e.Detail)
}

type DeviceSigningService struct{}

var _ DeviceSigningOps = DeviceSigningService{}

func (DeviceSigningService) GetStatus() (DeviceSigningStatus, error) {
	provider, err := providerOf(DeviceSigning)
	if err != nil {
		return DeviceSigningStatus{}, err
	}
	return provider.GetStatus()
}

func (DeviceSigningService) GenerateKey() (GenerateDeviceSigningKeyResult, error) {
	provider, err := providerOf(DeviceSigning)
	if err != nil {
		return GenerateDeviceSigningKeyResult{}, err
	}
	return provider.GenerateKey()
}

func (DeviceSigningService) GetPublicKey() (DevicePublicKey, error) {
	provider, err := providerOf(DeviceSigning)
	if err != nil {
		return DevicePublicKey{}, err
	}
	return provider.GetPublicKey()
}

func (DeviceSigningService) SignChallenge(request DeviceSignRequest) (DeviceSignature, error) {
	provider, err := providerOf(DeviceSigning)
	if err != nil {
		return DeviceSignature{}, err
	}

	request.Purpose = strings.TrimSpace(request.Purpose)
	request.Audience = strings.TrimSpace(request.Audience)
	request.Nonce = strings.TrimSpace(request.Nonce)
	if err := validateDeviceSignRequest(request); err != nil {
		return DeviceSignature{}, err
	}
	return provider.SignChallenge(request)
}

func validateDeviceSignRequest(request DeviceSignRequest) error {
	if strings.TrimSpace(request.Purpose) == "" || len(request.Purpose) > 64 {
		return fmt.Errorf("device signing purpose must contain 1-64 characters")
	}
	if strings.TrimSpace(request.Audience) == "" || len(request.Audience) > 256 {
		return fmt.Errorf("device signing audience must contain 1-256 characters")
	}
	if strings.TrimSpace(request.Nonce) == "" || len(request.Nonce) > 1024 {
		return fmt.Errorf("device signing nonce must contain 1-1024 characters")
	}
	return nil
}
