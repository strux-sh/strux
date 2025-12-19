package runtime

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"reflect"
	"strings"
	"sync"

	"github.com/strux-dev/strux/pkg/runtime/extension"
)

const socketPath = "/tmp/strux-ipc.sock"

// Runtime manages the IPC bridge between Go and JavaScript
type Runtime struct {
	app        interface{}
	methods    map[string]reflect.Value
	fields     map[string]int // field name -> field index
	listener   net.Listener
	mu         sync.RWMutex
	stopChan   chan struct{}
	structName string
	pkgName    string
	extensions *extension.Registry
}

// Message represents a JSON-RPC style message
type Message struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// Response represents a JSON-RPC style response
type Response struct {
	ID     string      `json:"id"`
	Result interface{} `json:"result,omitempty"`
	Error  string      `json:"error,omitempty"`
}

// MethodInfo describes a bound method for the frontend
type MethodInfo struct {
	Name       string   `json:"name"`
	ParamCount int      `json:"paramCount"`
	ParamTypes []string `json:"paramTypes"`
}

// FieldInfo describes a bound field for the frontend
type FieldInfo struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// New creates a new Runtime instance
func New(app interface{}) *Runtime {
	rt := &Runtime{
		app:        app,
		methods:    make(map[string]reflect.Value),
		fields:     make(map[string]int),
		stopChan:   make(chan struct{}),
		extensions: extension.NewRegistry(),
	}
	rt.discoverMethods()
	rt.discoverFields()
	rt.extractMetadata()

	// Register built-in Strux framework extensions
	rt.registerBuiltinExtensions()

	return rt
}

// registerBuiltinExtensions registers all built-in Strux framework extensions
// Add new framework features here as extensions for clean organization
func (rt *Runtime) registerBuiltinExtensions() {
	// Boot management (strux.boot)
	rt.registerExtension(&extension.BootExtension{}, &extension.BootMethods{})

	// Add more built-in extensions here:
	// rt.registerExtension(&StorageExtension{}, &StorageMethods{})
	// rt.registerExtension(&NetworkExtension{}, &NetworkMethods{})

}

// discoverMethods uses reflection to find all exported methods
func (rt *Runtime) discoverMethods() {
	val := reflect.ValueOf(rt.app)
	typ := val.Type()

	for i := 0; i < val.NumMethod(); i++ {
		method := val.Method(i)
		methodName := typ.Method(i).Name

		// Only bind exported methods (start with uppercase)
		if methodName[0] >= 'A' && methodName[0] <= 'Z' {
			rt.methods[methodName] = method
		}
	}
}

// discoverFields uses reflection to find all exported fields
func (rt *Runtime) discoverFields() {
	val := reflect.ValueOf(rt.app)
	typ := val.Type()

	// Handle pointer types
	if typ.Kind() == reflect.Ptr {
		typ = typ.Elem()
	}

	if typ.Kind() != reflect.Struct {
		return
	}

	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)

		// Only bind exported fields (start with uppercase)
		if field.PkgPath == "" && field.Name[0] >= 'A' && field.Name[0] <= 'Z' {
			rt.fields[field.Name] = i
		}
	}
}

// extractMetadata gets package and struct name from the app type
func (rt *Runtime) extractMetadata() {
	typ := reflect.TypeOf(rt.app)

	// Handle pointer types
	if typ.Kind() == reflect.Ptr {
		typ = typ.Elem()
	}

	// Get struct name
	rt.structName = typ.Name()

	// Get package name (e.g., "main")
	pkgPath := typ.PkgPath()
	if pkgPath != "" {
		// Extract just the package name from the full path
		parts := strings.Split(pkgPath, "/")
		rt.pkgName = parts[len(parts)-1]
	} else {
		rt.pkgName = "main"
	}
}

// GetMethodInfo returns metadata about all bound methods
func (rt *Runtime) GetMethodInfo() []MethodInfo {
	rt.mu.RLock()
	defer rt.mu.RUnlock()

	info := make([]MethodInfo, 0, len(rt.methods))
	for name, method := range rt.methods {
		typ := method.Type()
		paramTypes := make([]string, typ.NumIn())
		for i := 0; i < typ.NumIn(); i++ {
			paramTypes[i] = typ.In(i).Kind().String()
		}

		info = append(info, MethodInfo{
			Name:       name,
			ParamCount: typ.NumIn(),
			ParamTypes: paramTypes,
		})
	}
	return info
}

// GetFieldInfo returns metadata about all bound fields
func (rt *Runtime) GetFieldInfo() []FieldInfo {
	rt.mu.RLock()
	defer rt.mu.RUnlock()

	typ := reflect.TypeOf(rt.app)
	if typ.Kind() == reflect.Ptr {
		typ = typ.Elem()
	}

	info := make([]FieldInfo, 0, len(rt.fields))
	for name, idx := range rt.fields {
		field := typ.Field(idx)
		info = append(info, FieldInfo{
			Name: name,
			Type: field.Type.Kind().String(),
		})
	}
	return info
}

// Start begins listening for IPC connections
func (rt *Runtime) Start() error {
	// Remove existing socket if present
	os.Remove(socketPath)

	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("failed to create socket: %w", err)
	}
	rt.listener = listener

	fmt.Printf("Strux Runtime: IPC server listening on %s\n", socketPath)

	go rt.acceptConnections()
	return nil
}

// acceptConnections handles incoming IPC connections
func (rt *Runtime) acceptConnections() {
	for {
		select {
		case <-rt.stopChan:
			return
		default:
			conn, err := rt.listener.Accept()
			if err != nil {
				continue
			}
			go rt.handleConnection(conn)
		}
	}
}

// handleConnection processes messages from a single connection
func (rt *Runtime) handleConnection(conn net.Conn) {
	defer conn.Close()
	decoder := json.NewDecoder(conn)
	encoder := json.NewEncoder(conn)

	for {
		var msg Message
		if err := decoder.Decode(&msg); err != nil {
			return
		}

		// Special case: request for method and field metadata
		if msg.Method == "__getBindings" {
			methods := rt.GetMethodInfo()
			fields := rt.GetFieldInfo()

			// Structure bindings: user app + all registered extensions
			bindings := map[string]interface{}{
				rt.pkgName: map[string]interface{}{
					rt.structName: map[string]interface{}{
						"methods": methods,
						"fields":  fields,
					},
				},
			}

			// Add all extension bindings
			extensionBindings := rt.extensions.GetAllBindings()
			for namespace, subNamespaces := range extensionBindings {
				bindings[namespace] = subNamespaces
			}

			encoder.Encode(Response{
				ID:     msg.ID,
				Result: bindings,
			})
			continue
		}

		// Special case: get field value
		if msg.Method == "__getField" {
			var params []interface{}
			if len(msg.Params) > 0 {
				json.Unmarshal(msg.Params, &params)
			}

			if len(params) < 1 {
				encoder.Encode(Response{
					ID:    msg.ID,
					Error: "field name required",
				})
				continue
			}

			fieldName, ok := params[0].(string)
			if !ok {
				encoder.Encode(Response{
					ID:    msg.ID,
					Error: "field name must be a string",
				})
				continue
			}

			value, err := rt.getField(fieldName)
			encoder.Encode(Response{
				ID:     msg.ID,
				Result: value,
				Error: func() string {
					if err != nil {
						return err.Error()
					}
					return ""
				}(),
			})
			continue
		}

		// Special case: set field value
		if msg.Method == "__setField" {
			var params []interface{}
			if len(msg.Params) > 0 {
				json.Unmarshal(msg.Params, &params)
			}

			if len(params) < 2 {
				encoder.Encode(Response{
					ID:    msg.ID,
					Error: "field name and value required",
				})
				continue
			}

			fieldName, ok := params[0].(string)
			if !ok {
				encoder.Encode(Response{
					ID:    msg.ID,
					Error: "field name must be a string",
				})
				continue
			}

			err := rt.setField(fieldName, params[1])
			encoder.Encode(Response{
				ID: msg.ID,
				Error: func() string {
					if err != nil {
						return err.Error()
					}
					return ""
				}(),
			})
			continue
		}

		// Execute the method
		result, err := rt.executeMethod(msg.Method, msg.Params)

		resp := Response{ID: msg.ID}
		if err != nil {
			resp.Error = err.Error()
		} else {
			resp.Result = result
		}

		encoder.Encode(resp)
	}
}

// executeMethod calls a bound method with the provided parameters
func (rt *Runtime) executeMethod(methodName string, paramsRaw json.RawMessage) (interface{}, error) {
	// Check if it's an extension method (format: namespace.subnamespace.Method)
	parts := strings.Split(methodName, ".")
	if len(parts) == 3 {
		namespace := parts[0]
		subNamespace := parts[1]
		method := parts[2]

		// Parse parameters
		var params []interface{}
		if len(paramsRaw) > 0 {
			if err := json.Unmarshal(paramsRaw, &params); err != nil {
				return nil, fmt.Errorf("invalid parameters: %w", err)
			}
		}

		return rt.extensions.ExecuteMethod(namespace, subNamespace, method, params)
	}

	rt.mu.RLock()
	method, exists := rt.methods[methodName]
	rt.mu.RUnlock()

	if !exists {
		return nil, fmt.Errorf("method %s not found", methodName)
	}

	methodType := method.Type()
	numParams := methodType.NumIn()

	// Parse parameters
	var params []interface{}
	if len(paramsRaw) > 0 {
		if err := json.Unmarshal(paramsRaw, &params); err != nil {
			return nil, fmt.Errorf("invalid parameters: %w", err)
		}
	}

	if len(params) != numParams {
		return nil, fmt.Errorf("expected %d parameters, got %d", numParams, len(params))
	}

	// Convert parameters to the correct types
	args := make([]reflect.Value, numParams)
	for i := 0; i < numParams; i++ {
		expectedType := methodType.In(i)

		// Re-marshal and unmarshal to convert to the correct type
		paramJSON, _ := json.Marshal(params[i])
		paramValue := reflect.New(expectedType)
		if err := json.Unmarshal(paramJSON, paramValue.Interface()); err != nil {
			return nil, fmt.Errorf("parameter %d type mismatch: %w", i, err)
		}
		args[i] = paramValue.Elem()
	}

	// Call the method
	results := method.Call(args)

	// Handle return values
	if len(results) == 0 {
		return nil, nil
	}

	// If last return value is error, check it
	lastResult := results[len(results)-1]
	if lastResult.Type().Implements(reflect.TypeOf((*error)(nil)).Elem()) {
		if !lastResult.IsNil() {
			return nil, lastResult.Interface().(error)
		}
		// Remove error from results
		results = results[:len(results)-1]
	}

	// Return all non-error results
	if len(results) == 0 {
		return nil, nil
	}

	// If only one result, return it directly
	if len(results) == 1 {
		return results[0].Interface(), nil
	}

	// Multiple results - return as array for JS
	resultArray := make([]interface{}, len(results))
	for i, r := range results {
		resultArray[i] = r.Interface()
	}
	return resultArray, nil
}

// getField retrieves the value of a field
func (rt *Runtime) getField(fieldName string) (interface{}, error) {
	rt.mu.RLock()
	fieldIdx, exists := rt.fields[fieldName]
	rt.mu.RUnlock()

	if !exists {
		return nil, fmt.Errorf("field %s not found", fieldName)
	}

	val := reflect.ValueOf(rt.app)
	if val.Kind() == reflect.Ptr {
		val = val.Elem()
	}

	fieldValue := val.Field(fieldIdx)
	return fieldValue.Interface(), nil
}

// setField sets the value of a field
func (rt *Runtime) setField(fieldName string, value interface{}) error {
	rt.mu.RLock()
	fieldIdx, exists := rt.fields[fieldName]
	rt.mu.RUnlock()

	if !exists {
		return fmt.Errorf("field %s not found", fieldName)
	}

	val := reflect.ValueOf(rt.app)
	if val.Kind() == reflect.Ptr {
		val = val.Elem()
	}

	fieldValue := val.Field(fieldIdx)

	if !fieldValue.CanSet() {
		return fmt.Errorf("field %s cannot be set", fieldName)
	}

	// Convert value to the correct type
	newValue := reflect.ValueOf(value)

	// Handle type conversion through JSON for consistency
	if newValue.Type() != fieldValue.Type() {
		// Marshal and unmarshal through JSON to convert types
		jsonData, err := json.Marshal(value)
		if err != nil {
			return fmt.Errorf("failed to convert value: %w", err)
		}

		newValuePtr := reflect.New(fieldValue.Type())
		if err := json.Unmarshal(jsonData, newValuePtr.Interface()); err != nil {
			return fmt.Errorf("failed to convert value to %s: %w", fieldValue.Type(), err)
		}

		newValue = newValuePtr.Elem()
	}

	fieldValue.Set(newValue)
	return nil
}

// Stop shuts down the IPC server
func (rt *Runtime) Stop() {
	close(rt.stopChan)
	if rt.listener != nil {
		rt.listener.Close()
	}
	os.Remove(socketPath)
}

// registerExtension is an internal method for registering framework extensions
func (rt *Runtime) registerExtension(ext extension.Extension, instance interface{}) error {
	return rt.extensions.Register(ext, instance)
}
