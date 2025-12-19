package extension

import (
	"fmt"
	"reflect"
	"sync"
)

// Extension represents a collection of methods that can be registered
// with the Strux runtime to extend the JavaScript API
type Extension interface {
	// Namespace returns the top-level namespace (e.g., "strux")
	Namespace() string

	// SubNamespace returns the sub-namespace (e.g., "boot", "storage", "system")
	SubNamespace() string
}

// MethodInfo describes a bound method for the frontend
type MethodInfo struct {
	Name       string   `json:"name"`
	ParamCount int      `json:"paramCount"`
	ParamTypes []string `json:"paramTypes"`
}

// Registry manages all registered extensions
type Registry struct {
	extensions map[string]map[string]interface{} // namespace -> subnamespace -> extension instance
	mu         sync.RWMutex
}

// NewRegistry creates a new extension registry
func NewRegistry() *Registry {
	return &Registry{
		extensions: make(map[string]map[string]interface{}),
	}
}

// Register adds an extension to the registry
func (r *Registry) Register(ext Extension, instance interface{}) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	namespace := ext.Namespace()
	subNamespace := ext.SubNamespace()

	if namespace == "" || subNamespace == "" {
		return fmt.Errorf("namespace and sub-namespace cannot be empty")
	}

	// Create namespace map if it doesn't exist
	if r.extensions[namespace] == nil {
		r.extensions[namespace] = make(map[string]interface{})
	}

	// Check if already registered
	if _, exists := r.extensions[namespace][subNamespace]; exists {
		return fmt.Errorf("extension %s.%s already registered", namespace, subNamespace)
	}

	r.extensions[namespace][subNamespace] = instance
	return nil
}

// GetAllBindings returns all extension bindings in the format expected by the IPC protocol
func (r *Registry) GetAllBindings() map[string]interface{} {
	r.mu.RLock()
	defer r.mu.RUnlock()

	bindings := make(map[string]interface{})

	for namespace, subNamespaces := range r.extensions {
		namespaceBindings := make(map[string]interface{})

		for subNamespace, instance := range subNamespaces {
			methods := r.extractMethods(instance)
			namespaceBindings[subNamespace] = map[string]interface{}{
				"methods": methods,
			}
		}

		bindings[namespace] = namespaceBindings
	}

	return bindings
}

// extractMethods uses reflection to extract method information from an extension instance
func (r *Registry) extractMethods(instance interface{}) []MethodInfo {
	val := reflect.ValueOf(instance)
	typ := val.Type()

	var methods []MethodInfo

	for i := 0; i < val.NumMethod(); i++ {
		method := val.Method(i)
		methodType := method.Type()
		methodName := typ.Method(i).Name

		// Only include exported methods
		if methodName[0] >= 'A' && methodName[0] <= 'Z' {
			paramTypes := make([]string, methodType.NumIn())
			for j := 0; j < methodType.NumIn(); j++ {
				paramTypes[j] = methodType.In(j).Kind().String()
			}

			methods = append(methods, MethodInfo{
				Name:       methodName,
				ParamCount: methodType.NumIn(),
				ParamTypes: paramTypes,
			})
		}
	}

	return methods
}

// ExecuteMethod executes a method on a registered extension
func (r *Registry) ExecuteMethod(namespace, subNamespace, methodName string, params []interface{}) (interface{}, error) {
	r.mu.RLock()
	subNamespaces, exists := r.extensions[namespace]
	if !exists {
		r.mu.RUnlock()
		return nil, fmt.Errorf("namespace %s not found", namespace)
	}

	instance, exists := subNamespaces[subNamespace]
	if !exists {
		r.mu.RUnlock()
		return nil, fmt.Errorf("sub-namespace %s.%s not found", namespace, subNamespace)
	}
	r.mu.RUnlock()

	// Get method
	val := reflect.ValueOf(instance)
	method := val.MethodByName(methodName)
	if !method.IsValid() {
		return nil, fmt.Errorf("method %s not found on %s.%s", methodName, namespace, subNamespace)
	}

	methodType := method.Type()
	numParams := methodType.NumIn()

	if len(params) != numParams {
		return nil, fmt.Errorf("expected %d parameters, got %d", numParams, len(params))
	}

	// Convert parameters to the correct types
	args := make([]reflect.Value, numParams)
	for i := 0; i < numParams; i++ {
		expectedType := methodType.In(i)

		// Try to convert the parameter
		if params[i] != nil {
			sourceValue := reflect.ValueOf(params[i])
			if sourceValue.Type().ConvertibleTo(expectedType) {
				args[i] = sourceValue.Convert(expectedType)
			} else {
				return nil, fmt.Errorf("parameter %d cannot be converted to %s", i, expectedType)
			}
		} else {
			args[i] = reflect.Zero(expectedType)
		}
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
