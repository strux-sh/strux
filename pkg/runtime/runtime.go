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

// ChannelHandshake is the first message sent by the WPE extension on each socket
// to identify which channel the connection belongs to.
type ChannelHandshake struct {
	Type    string `json:"type"`
	Channel string `json:"channel"` // "sync", "async", or "events"
}

// structTreeNode represents a node in the struct binding tree.
// Each node corresponds to a struct-typed field and holds its methods,
// primitive fields, and children (nested struct fields).
type structTreeNode struct {
	fieldPath string                     // dotted path from app root, e.g. "Settings.Audio"
	methods   map[string]reflect.Value   // method name -> bound method
	fields    map[string]int             // primitive field name -> index in this struct
	children  map[string]*structTreeNode // field name -> child node (struct fields only)
	value     reflect.Value
	typ       reflect.Type
}

// Runtime manages the IPC bridge between Go and JavaScript
type Runtime struct {
	app        interface{}
	methods    map[string]reflect.Value // flat map: full path -> method (e.g. "Settings.Audio.SetMasterVolume")
	tree       *structTreeNode          // tree representation of the app struct
	listener   net.Listener
	mu         sync.RWMutex
	stopChan   chan struct{}
	structName string
	pkgName    string
	extensions *extension.Registry
	events     *eventState
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
		stopChan:   make(chan struct{}),
		extensions: extension.NewRegistry(),
		events:     newEventState(),
	}

	rt.extractMetadata()

	// Build the struct tree from the app, discovering all methods and fields
	val := reflect.ValueOf(app)
	typ := val.Type()
	if typ.Kind() == reflect.Ptr {
		val = val.Elem()
		typ = typ.Elem()
	}
	rt.tree = rt.buildStructTree(val, typ, "")

	// Register built-in Strux framework extensions
	rt.registerBuiltinExtensions()

	return rt
}

// buildStructTree recursively builds the binding tree from a struct value.
// pathPrefix is the dotted field path from the app root (empty for the root).
func (rt *Runtime) buildStructTree(val reflect.Value, typ reflect.Type, pathPrefix string) *structTreeNode {
	node := &structTreeNode{
		fieldPath: pathPrefix,
		methods:   make(map[string]reflect.Value),
		fields:    make(map[string]int),
		children:  make(map[string]*structTreeNode),
		value:     val,
		typ:       typ,
	}

	// Discover methods (pointer receiver first, then value receiver)
	if val.CanAddr() {
		ptrVal := val.Addr()
		ptrType := ptrVal.Type()
		for i := 0; i < ptrType.NumMethod(); i++ {
			name := ptrType.Method(i).Name
			if name[0] >= 'A' && name[0] <= 'Z' {
				method := ptrVal.Method(i)
				node.methods[name] = method
				fullName := name
				if pathPrefix != "" {
					fullName = pathPrefix + "." + name
				}
				rt.methods[fullName] = method
			}
		}
	}
	for i := 0; i < val.NumMethod(); i++ {
		name := typ.Method(i).Name
		if name[0] >= 'A' && name[0] <= 'Z' {
			if _, exists := node.methods[name]; !exists {
				method := val.Method(i)
				node.methods[name] = method
				fullName := name
				if pathPrefix != "" {
					fullName = pathPrefix + "." + name
				}
				rt.methods[fullName] = method
			}
		}
	}

	// Discover fields and children
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if field.PkgPath != "" || !(field.Name[0] >= 'A' && field.Name[0] <= 'Z') {
			continue
		}

		fieldVal := val.Field(i)
		fieldType := field.Type

		// Dereference pointer
		if fieldType.Kind() == reflect.Ptr {
			if fieldVal.IsNil() {
				continue
			}
			fieldVal = fieldVal.Elem()
			fieldType = fieldType.Elem()
		}

		if fieldType.Kind() == reflect.Struct {
			// Struct field becomes a child node
			childPath := field.Name
			if pathPrefix != "" {
				childPath = pathPrefix + "." + field.Name
			}
			node.children[field.Name] = rt.buildStructTree(fieldVal, fieldType, childPath)
		} else {
			// Primitive field
			node.fields[field.Name] = i
		}
	}

	return node
}

// serializeTreeNode converts a tree node to a JSON-serializable map for __getBindings
func (rt *Runtime) serializeTreeNode(node *structTreeNode) map[string]interface{} {
	// Methods
	methods := make([]MethodInfo, 0, len(node.methods))
	for name, method := range node.methods {
		typ := method.Type()
		paramTypes := make([]string, typ.NumIn())
		for i := 0; i < typ.NumIn(); i++ {
			paramTypes[i] = typ.In(i).Kind().String()
		}
		methods = append(methods, MethodInfo{
			Name:       name,
			ParamCount: typ.NumIn(),
			ParamTypes: paramTypes,
		})
	}

	// Primitive fields only
	fields := make([]FieldInfo, 0, len(node.fields))
	for name, idx := range node.fields {
		field := node.typ.Field(idx)
		fields = append(fields, FieldInfo{
			Name: name,
			Type: field.Type.Kind().String(),
		})
	}

	// Children
	children := make(map[string]interface{}, len(node.children))
	for name, child := range node.children {
		children[name] = rt.serializeTreeNode(child)
	}

	result := map[string]interface{}{
		"methods":  methods,
		"fields":   fields,
		"children": children,
	}

	return result
}

// registerBuiltinExtensions registers all built-in Strux framework extensions
func (rt *Runtime) registerBuiltinExtensions() {
	rt.registerExtension(&extension.BootExtension{}, &extension.BootMethods{})
	rt.registerExtension(&extension.DevExtension{}, extension.NewDevMethods())
}

// extractMetadata gets package and struct name from the app type
func (rt *Runtime) extractMetadata() {
	typ := reflect.TypeOf(rt.app)
	if typ.Kind() == reflect.Ptr {
		typ = typ.Elem()
	}
	rt.structName = typ.Name()
	pkgPath := typ.PkgPath()
	if pkgPath != "" {
		parts := strings.Split(pkgPath, "/")
		rt.pkgName = parts[len(parts)-1]
	} else {
		rt.pkgName = "main"
	}
}

// GetMethodInfo returns metadata about top-level app methods (from tree root)
func (rt *Runtime) GetMethodInfo() []MethodInfo {
	rt.mu.RLock()
	defer rt.mu.RUnlock()

	if rt.tree == nil {
		return nil
	}
	info := make([]MethodInfo, 0, len(rt.tree.methods))
	for name, method := range rt.tree.methods {
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

// GetFieldInfo returns metadata about top-level app fields (from tree root)
func (rt *Runtime) GetFieldInfo() []FieldInfo {
	rt.mu.RLock()
	defer rt.mu.RUnlock()

	if rt.tree == nil {
		return nil
	}
	info := make([]FieldInfo, 0, len(rt.tree.fields))
	for name, idx := range rt.tree.fields {
		field := rt.tree.typ.Field(idx)
		info = append(info, FieldInfo{
			Name: name,
			Type: field.Type.Kind().String(),
		})
	}
	return info
}

// Start begins listening for IPC connections
func (rt *Runtime) Start() error {
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

// handleConnection processes messages from a single connection.
func (rt *Runtime) handleConnection(conn net.Conn) {
	defer conn.Close()
	decoder := json.NewDecoder(conn)
	encoder := json.NewEncoder(conn)

	var firstMsg json.RawMessage
	if err := decoder.Decode(&firstMsg); err != nil {
		return
	}

	var handshake ChannelHandshake
	if err := json.Unmarshal(firstMsg, &handshake); err == nil && handshake.Type == "handshake" {
		encoder.Encode(map[string]interface{}{"type": "handshake", "ok": true})

		if handshake.Channel == "events" {
			rt.events.eventConnsMu.Lock()
			rt.events.eventConns[conn] = struct{}{}
			rt.events.eventConnsMu.Unlock()
			fmt.Printf("Strux Runtime: Event channel connected\n")
			rt.handleEventConnection(conn)
			return
		}
		fmt.Printf("Strux Runtime: %s channel connected\n", handshake.Channel)
	} else {
		var msg Message
		if err := json.Unmarshal(firstMsg, &msg); err != nil {
			return
		}
		rt.handleMessage(msg, encoder)
	}

	for {
		var msg Message
		if err := decoder.Decode(&msg); err != nil {
			return
		}
		rt.handleMessage(msg, encoder)
	}
}

// handleMessage processes a single JSON-RPC message
func (rt *Runtime) handleMessage(msg Message, encoder *json.Encoder) {
	// __getBindings: return the struct tree + extensions
	if msg.Method == "__getBindings" {
		appBindings := rt.serializeTreeNode(rt.tree)

		bindings := map[string]interface{}{
			rt.pkgName: map[string]interface{}{
				rt.structName: appBindings,
			},
		}

		// Add extension bindings
		extensionBindings := rt.extensions.GetAllBindings()
		for namespace, subNamespaces := range extensionBindings {
			bindings[namespace] = subNamespaces
		}

		encoder.Encode(Response{ID: msg.ID, Result: bindings})
		return
	}

	// __getField: support dotted paths (e.g. "Settings.Audio.MasterVolume")
	if msg.Method == "__getField" {
		var params []interface{}
		if len(msg.Params) > 0 {
			json.Unmarshal(msg.Params, &params)
		}
		if len(params) < 1 {
			encoder.Encode(Response{ID: msg.ID, Error: "field name required"})
			return
		}
		fieldName, ok := params[0].(string)
		if !ok {
			encoder.Encode(Response{ID: msg.ID, Error: "field name must be a string"})
			return
		}
		value, err := rt.getField(fieldName)
		errStr := ""
		if err != nil {
			errStr = err.Error()
		}
		encoder.Encode(Response{ID: msg.ID, Result: value, Error: errStr})
		return
	}

	// __setField: support dotted paths
	if msg.Method == "__setField" {
		var params []interface{}
		if len(msg.Params) > 0 {
			json.Unmarshal(msg.Params, &params)
		}
		if len(params) < 2 {
			encoder.Encode(Response{ID: msg.ID, Error: "field name and value required"})
			return
		}
		fieldName, ok := params[0].(string)
		if !ok {
			encoder.Encode(Response{ID: msg.ID, Error: "field name must be a string"})
			return
		}
		err := rt.setField(fieldName, params[1])
		errStr := ""
		if err != nil {
			errStr = err.Error()
		}
		encoder.Encode(Response{ID: msg.ID, Error: errStr})
		return
	}

	// Execute method
	result, err := rt.executeMethod(msg.Method, msg.Params)
	resp := Response{ID: msg.ID}
	if err != nil {
		resp.Error = err.Error()
	} else {
		resp.Result = result
	}
	encoder.Encode(resp)
}

// executeMethod calls a bound method. Checks the flat methods map first (which
// contains both app methods and nested struct methods with full paths), then
// falls back to extensions only for unmatched names.
func (rt *Runtime) executeMethod(methodName string, paramsRaw json.RawMessage) (interface{}, error) {
	// Look up in flat methods map (covers app + all nested struct methods)
	rt.mu.RLock()
	method, exists := rt.methods[methodName]
	rt.mu.RUnlock()

	if !exists {
		// Fallback: check extensions (format: namespace.subnamespace.Method)
		parts := strings.Split(methodName, ".")
		if len(parts) == 3 {
			var params []interface{}
			if len(paramsRaw) > 0 {
				if err := json.Unmarshal(paramsRaw, &params); err != nil {
					return nil, fmt.Errorf("invalid parameters: %w", err)
				}
			}
			return rt.extensions.ExecuteMethod(parts[0], parts[1], parts[2], params)
		}
		return nil, fmt.Errorf("method %s not found", methodName)
	}

	methodType := method.Type()
	numParams := methodType.NumIn()

	var params []interface{}
	if len(paramsRaw) > 0 {
		if err := json.Unmarshal(paramsRaw, &params); err != nil {
			return nil, fmt.Errorf("invalid parameters: %w", err)
		}
	}

	if len(params) != numParams {
		return nil, fmt.Errorf("expected %d parameters, got %d", numParams, len(params))
	}

	args := make([]reflect.Value, numParams)
	for i := 0; i < numParams; i++ {
		expectedType := methodType.In(i)
		paramJSON, _ := json.Marshal(params[i])
		paramValue := reflect.New(expectedType)
		if err := json.Unmarshal(paramJSON, paramValue.Interface()); err != nil {
			return nil, fmt.Errorf("parameter %d type mismatch: %w", i, err)
		}
		args[i] = paramValue.Elem()
	}

	results := method.Call(args)

	if len(results) == 0 {
		return nil, nil
	}

	lastResult := results[len(results)-1]
	if lastResult.Type().Implements(reflect.TypeOf((*error)(nil)).Elem()) {
		if !lastResult.IsNil() {
			return nil, lastResult.Interface().(error)
		}
		results = results[:len(results)-1]
	}

	if len(results) == 0 {
		return nil, nil
	}
	if len(results) == 1 {
		return results[0].Interface(), nil
	}

	resultArray := make([]interface{}, len(results))
	for i, r := range results {
		resultArray[i] = r.Interface()
	}
	return resultArray, nil
}

// getField retrieves a field value, supporting dotted paths (e.g. "Settings.Audio.MasterVolume")
func (rt *Runtime) getField(fieldName string) (interface{}, error) {
	parts := strings.Split(fieldName, ".")

	val := reflect.ValueOf(rt.app)
	if val.Kind() == reflect.Ptr {
		val = val.Elem()
	}

	for _, part := range parts {
		typ := val.Type()
		if typ.Kind() != reflect.Struct {
			return nil, fmt.Errorf("cannot access field %s on non-struct type %s", part, typ)
		}

		found := false
		for i := 0; i < typ.NumField(); i++ {
			if typ.Field(i).Name == part {
				val = val.Field(i)
				if val.Kind() == reflect.Ptr {
					if val.IsNil() {
						return nil, fmt.Errorf("field %s is nil", part)
					}
					val = val.Elem()
				}
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("field %s not found", part)
		}
	}

	return val.Interface(), nil
}

// setField sets a field value, supporting dotted paths (e.g. "Settings.Audio.MasterVolume")
func (rt *Runtime) setField(fieldName string, value interface{}) error {
	parts := strings.Split(fieldName, ".")

	val := reflect.ValueOf(rt.app)
	if val.Kind() == reflect.Ptr {
		val = val.Elem()
	}

	// Traverse to the parent of the target field
	for _, part := range parts[:len(parts)-1] {
		typ := val.Type()
		if typ.Kind() != reflect.Struct {
			return fmt.Errorf("cannot access field %s on non-struct type %s", part, typ)
		}

		found := false
		for i := 0; i < typ.NumField(); i++ {
			if typ.Field(i).Name == part {
				val = val.Field(i)
				if val.Kind() == reflect.Ptr {
					if val.IsNil() {
						return fmt.Errorf("field %s is nil", part)
					}
					val = val.Elem()
				}
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("field %s not found", part)
		}
	}

	// Set the final field
	targetName := parts[len(parts)-1]
	typ := val.Type()
	if typ.Kind() != reflect.Struct {
		return fmt.Errorf("cannot access field %s on non-struct type %s", targetName, typ)
	}

	for i := 0; i < typ.NumField(); i++ {
		if typ.Field(i).Name == targetName {
			fieldValue := val.Field(i)
			if !fieldValue.CanSet() {
				return fmt.Errorf("field %s cannot be set", fieldName)
			}

			newValue := reflect.ValueOf(value)
			if newValue.Type() != fieldValue.Type() {
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
	}

	return fmt.Errorf("field %s not found", targetName)
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
