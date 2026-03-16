package runtime

import (
	"fmt"
	"os"
	"reflect"
	"strings"

	"github.com/strux-dev/strux/pkg/runtime/extension"
)

// GenerateTypeScript creates TypeScript type definitions for the bound methods and extensions
func (rt *Runtime) GenerateTypeScript(outputPath string) error {
	var sb strings.Builder

	sb.WriteString("// Auto-generated TypeScript definitions for Strux bindings\n")
	sb.WriteString("// Generated from Go struct methods and extensions\n\n")

	// Generate extension namespaces first
	extensionBindings := rt.extensions.GetAllBindings()
	for namespace, subNamespaces := range extensionBindings {
		sb.WriteString(fmt.Sprintf("// %s namespace\n", namespace))
		sb.WriteString(fmt.Sprintf("declare namespace %s {\n", namespace))

		subNamespacesMap, ok := subNamespaces.(map[string]interface{})
		if ok {
			for subNamespace, subData := range subNamespacesMap {
				subDataMap, ok := subData.(map[string]interface{})
				if !ok {
					continue
				}

				methods, ok := subDataMap["methods"].([]extension.MethodInfo)
				if !ok {
					continue
				}

				sb.WriteString(fmt.Sprintf("  export namespace %s {\n", subNamespace))

				for _, method := range methods {
					// Build parameter list
					params := []string{}
					for i, paramType := range method.ParamTypes {
						tsType := kindStringToTS(paramType)
						params = append(params, fmt.Sprintf("arg%d: %s", i, tsType))
					}

					// All extension methods return Promise<void> for now
					// (we could enhance this with return type metadata)
					returnType := "Promise<void>"
					sb.WriteString(fmt.Sprintf("    export function %s(%s): %s;\n",
						method.Name, strings.Join(params, ", "), returnType))
				}

				sb.WriteString("  }\n")
			}
		}

		sb.WriteString("}\n\n")
	}

	// Generate interface for user app methods
	val := reflect.ValueOf(rt.app)
	typ := val.Type()

	sb.WriteString("// User application bindings\n")
	sb.WriteString("interface StruxBindings {\n")

	for i := 0; i < val.NumMethod(); i++ {
		method := val.Method(i)
		methodType := method.Type()
		methodName := typ.Method(i).Name

		// Only process exported methods
		if methodName[0] < 'A' || methodName[0] > 'Z' {
			continue
		}

		// Build parameter list
		params := []string{}
		for j := 0; j < methodType.NumIn(); j++ {
			paramType := methodType.In(j)
			tsType := goTypeToTS(paramType)
			params = append(params, fmt.Sprintf("arg%d: %s", j, tsType))
		}

		// Determine return type
		returnType := "void"
		if methodType.NumOut() > 0 {
			// Get first return value (ignore error if it's the last one)
			firstReturn := methodType.Out(0)

			// Check if last return is error
			hasError := false
			if methodType.NumOut() > 1 {
				lastReturn := methodType.Out(methodType.NumOut() - 1)
				if lastReturn.Implements(reflect.TypeOf((*error)(nil)).Elem()) {
					hasError = true
				}
			}

			if methodType.NumOut() == 1 && firstReturn.Implements(reflect.TypeOf((*error)(nil)).Elem()) {
				// Only returns error
				returnType = "void"
			} else {
				returnType = goTypeToTS(firstReturn)
				if hasError {
					returnType += " | null" // Can be null if error occurs
				}
			}
		}

		returnType = fmt.Sprintf("Promise<%s>", returnType)
		sb.WriteString(fmt.Sprintf("  %s(%s): %s;\n", methodName, strings.Join(params, ", "), returnType))
	}

	sb.WriteString("}\n\n")

	// Generate strux.ipc event types
	sb.WriteString("// Strux IPC event system\n")
	sb.WriteString("declare namespace strux {\n")
	sb.WriteString("  export namespace ipc {\n")
	sb.WriteString("    /**\n")
	sb.WriteString("     * Register a listener for an event from the Go backend.\n")
	sb.WriteString("     * @param event The event name to listen for\n")
	sb.WriteString("     * @param callback Function called when the event is received\n")
	sb.WriteString("     * @returns A function that removes the listener when called\n")
	sb.WriteString("     */\n")
	sb.WriteString("    export function on(event: string, callback: (data: any) => void): () => void;\n")
	sb.WriteString("    /**\n")
	sb.WriteString("     * Remove a previously registered event listener.\n")
	sb.WriteString("     * @param event The event name\n")
	sb.WriteString("     * @param callback The same callback reference passed to on()\n")
	sb.WriteString("     */\n")
	sb.WriteString("    export function off(event: string, callback: (data: any) => void): void;\n")
	sb.WriteString("    /**\n")
	sb.WriteString("     * Send an event to the Go backend.\n")
	sb.WriteString("     * @param event The event name\n")
	sb.WriteString("     * @param data Optional data to send with the event\n")
	sb.WriteString("     */\n")
	sb.WriteString("    export function send(event: string, data?: any): void;\n")
	sb.WriteString("  }\n")
	sb.WriteString("}\n\n")

	// Extend Window interface
	sb.WriteString("// Extend Window interface with Strux bindings\n")
	sb.WriteString("declare global {\n")
	sb.WriteString("  interface Window extends StruxBindings {}\n")
	sb.WriteString("}\n\n")

	sb.WriteString("export {};\n")

	// Write to file
	return os.WriteFile(outputPath, []byte(sb.String()), 0644)
}

// goTypeToTS maps Go types to TypeScript types
func goTypeToTS(t reflect.Type) string {
	switch t.Kind() {
	case reflect.String:
		return "string"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64,
		reflect.Float32, reflect.Float64:
		return "number"
	case reflect.Bool:
		return "boolean"
	case reflect.Slice, reflect.Array:
		elemType := goTypeToTS(t.Elem())
		return elemType + "[]"
	case reflect.Map:
		keyType := goTypeToTS(t.Key())
		valueType := goTypeToTS(t.Elem())
		return fmt.Sprintf("Record<%s, %s>", keyType, valueType)
	case reflect.Struct:
		return "object"
	case reflect.Ptr:
		return goTypeToTS(t.Elem())
	case reflect.Interface:
		return "any"
	default:
		return "unknown"
	}
}

// kindStringToTS converts a string representation of a Go kind to TypeScript
func kindStringToTS(kindStr string) string {
	switch kindStr {
	case "string":
		return "string"
	case "int", "int8", "int16", "int32", "int64",
		"uint", "uint8", "uint16", "uint32", "uint64",
		"float32", "float64":
		return "number"
	case "bool":
		return "boolean"
	case "slice", "array":
		return "any[]"
	case "map":
		return "Record<string, any>"
	case "struct":
		return "object"
	case "ptr":
		return "any"
	case "interface":
		return "any"
	default:
		return "unknown"
	}
}
