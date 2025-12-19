package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
)

// IntrospectionOutput is the top-level JSON structure
type IntrospectionOutput struct {
	App        AppInfo              `json:"app"`
	Structs    map[string]StructDef `json:"structs"`
	Extensions map[string]any       `json:"extensions,omitempty"`
}

// AppInfo describes the main application struct
type AppInfo struct {
	Name        string      `json:"name"`
	PackageName string      `json:"packageName"`
	Fields      []FieldDef  `json:"fields"`
	Methods     []MethodDef `json:"methods"`
}

// StructDef describes a struct definition
type StructDef struct {
	Fields []FieldDef `json:"fields"`
}

// FieldDef describes a struct field
type FieldDef struct {
	Name   string `json:"name"`
	GoType string `json:"goType"`
	TSType string `json:"tsType"`
}

// MethodDef describes a method
type MethodDef struct {
	Name        string     `json:"name"`
	Params      []ParamDef `json:"params"`
	ReturnTypes []TypeDef  `json:"returnTypes"`
	HasError    bool       `json:"hasError"`
}

// ParamDef describes a method parameter
type ParamDef struct {
	Name   string `json:"name,omitempty"`
	GoType string `json:"goType"`
	TSType string `json:"tsType"`
}

// TypeDef describes a type
type TypeDef struct {
	GoType string `json:"goType"`
	TSType string `json:"tsType"`
}

func main() {
	if len(os.Args) < 2 {
		// Default to main.go in current directory
		if err := introspect("main.go"); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	filePath := os.Args[1]
	if err := introspect(filePath); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func introspect(filePath string) error {
	// Check if file exists
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		return fmt.Errorf("%s not found", filePath)
	}

	// Parse the Go file
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, filePath, nil, parser.ParseComments)
	if err != nil {
		return fmt.Errorf("failed to parse %s: %w", filePath, err)
	}

	// Get package name
	packageName := node.Name.Name

	// Collect all structs and their fields
	structFields := make(map[string][]FieldDef)
	knownStructs := make(map[string]bool)

	// First pass: discover all struct types
	ast.Inspect(node, func(n ast.Node) bool {
		if typeSpec, ok := n.(*ast.TypeSpec); ok {
			if _, ok := typeSpec.Type.(*ast.StructType); ok {
				knownStructs[typeSpec.Name.Name] = true
			}
		}
		return true
	})

	// Second pass: extract struct fields and methods
	var appStructName string
	var methods []MethodDef

	ast.Inspect(node, func(n ast.Node) bool {
		// Find type declarations
		if typeSpec, ok := n.(*ast.TypeSpec); ok {
			if structType, ok := typeSpec.Type.(*ast.StructType); ok {
				structName := typeSpec.Name.Name
				var fields []FieldDef

				// Extract fields
				for _, field := range structType.Fields.List {
					if len(field.Names) > 0 {
						fieldName := field.Names[0].Name
						// Only process exported fields
						if isExported(fieldName) {
							goType := exprToString(field.Type)
							fields = append(fields, FieldDef{
								Name:   fieldName,
								GoType: goType,
								TSType: goTypeToTS(goType, knownStructs),
							})
						}
					}
				}
				structFields[structName] = fields
			}
		}

		// Find method declarations to determine which struct is the "App"
		if funcDecl, ok := n.(*ast.FuncDecl); ok {
			if funcDecl.Recv != nil && len(funcDecl.Recv.List) > 0 {
				// This is a method
				recvType := funcDecl.Recv.List[0].Type

				// Extract receiver type name
				var recvTypeName string
				switch t := recvType.(type) {
				case *ast.StarExpr:
					if ident, ok := t.X.(*ast.Ident); ok {
						recvTypeName = ident.Name
					}
				case *ast.Ident:
					recvTypeName = t.Name
				}

				// Set appStructName to the first struct we find methods on
				if appStructName == "" && recvTypeName != "" {
					appStructName = recvTypeName
				}

				// Only process methods on the App struct
				if recvTypeName == appStructName {
					methodName := funcDecl.Name.Name

					// Only process exported methods
					if isExported(methodName) {
						method := extractMethod(funcDecl, knownStructs)
						methods = append(methods, method)
					}
				}
			}
		}

		return true
	})

	// Default to "App" if no struct was found
	if appStructName == "" {
		appStructName = "App"
	}

	// Build the output
	output := IntrospectionOutput{
		App: AppInfo{
			Name:        appStructName,
			PackageName: packageName,
			Fields:      structFields[appStructName],
			Methods:     methods,
		},
		Structs:    make(map[string]StructDef),
		Extensions: make(map[string]any),
	}

	// Add all structs except the app struct
	for name, fields := range structFields {
		if name != appStructName {
			output.Structs[name] = StructDef{Fields: fields}
		}
	}

	// Output JSON to stdout
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(output)
}

func extractMethod(funcDecl *ast.FuncDecl, knownStructs map[string]bool) MethodDef {
	methodName := funcDecl.Name.Name

	// Extract parameters - initialize as empty slice, not nil
	params := []ParamDef{}
	if funcDecl.Type.Params != nil {
		paramIndex := 0
		for _, field := range funcDecl.Type.Params.List {
			goType := exprToString(field.Type)
			tsType := goTypeToTS(goType, knownStructs)

			if len(field.Names) == 0 {
				// Anonymous parameter
				params = append(params, ParamDef{
					Name:   fmt.Sprintf("arg%d", paramIndex),
					GoType: goType,
					TSType: tsType,
				})
				paramIndex++
			} else {
				// Named parameter(s)
				for _, name := range field.Names {
					params = append(params, ParamDef{
						Name:   name.Name,
						GoType: goType,
						TSType: tsType,
					})
					paramIndex++
				}
			}
		}
	}

	// Extract return types
	returnTypes := []TypeDef{}
	hasError := false

	if funcDecl.Type.Results != nil && len(funcDecl.Type.Results.List) > 0 {
		results := funcDecl.Type.Results.List

		// Check if last return is error
		lastReturn := exprToString(results[len(results)-1].Type)
		if lastReturn == "error" {
			hasError = true
		}

		// Collect all non-error return types
		for _, result := range results {
			goType := exprToString(result.Type)
			if goType == "error" {
				continue // Skip error types
			}

			// Handle multiple names on same type (e.g., "x, y int")
			if len(result.Names) > 1 {
				for range result.Names {
					returnTypes = append(returnTypes, TypeDef{
						GoType: goType,
						TSType: goTypeToTS(goType, knownStructs),
					})
				}
			} else {
				returnTypes = append(returnTypes, TypeDef{
					GoType: goType,
					TSType: goTypeToTS(goType, knownStructs),
				})
			}
		}
	}

	return MethodDef{
		Name:        methodName,
		Params:      params,
		ReturnTypes: returnTypes,
		HasError:    hasError,
	}
}

func exprToString(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.StarExpr:
		return "*" + exprToString(t.X)
	case *ast.ArrayType:
		return "[]" + exprToString(t.Elt)
	case *ast.MapType:
		return "map[" + exprToString(t.Key) + "]" + exprToString(t.Value)
	case *ast.SelectorExpr:
		return exprToString(t.X) + "." + t.Sel.Name
	case *ast.InterfaceType:
		return "interface{}"
	case *ast.Ellipsis:
		return "..." + exprToString(t.Elt)
	default:
		return "unknown"
	}
}

func goTypeToTS(goType string, knownStructs map[string]bool) string {
	switch goType {
	case "string":
		return "string"
	case "int", "int8", "int16", "int32", "int64",
		"uint", "uint8", "uint16", "uint32", "uint64",
		"float32", "float64":
		return "number"
	case "bool":
		return "boolean"
	case "error":
		return "Error"
	case "interface{}":
		return "any"
	default:
		// Handle arrays
		if strings.HasPrefix(goType, "[]") {
			elemType := goTypeToTS(goType[2:], knownStructs)
			return elemType + "[]"
		}
		// Handle maps - parse key and value types
		if strings.HasPrefix(goType, "map[") {
			keyType, valueType := parseMapType(goType)
			tsKey := goTypeToTS(keyType, knownStructs)
			tsValue := goTypeToTS(valueType, knownStructs)
			return fmt.Sprintf("Record<%s, %s>", tsKey, tsValue)
		}
		// Handle pointers
		if strings.HasPrefix(goType, "*") {
			return goTypeToTS(goType[1:], knownStructs)
		}
		// Handle variadic
		if strings.HasPrefix(goType, "...") {
			elemType := goTypeToTS(goType[3:], knownStructs)
			return elemType + "[]"
		}
		// Check if it's a known struct type
		if knownStructs != nil && knownStructs[goType] {
			return goType
		}
		return "any"
	}
}

func isExported(name string) bool {
	if len(name) == 0 {
		return false
	}
	return name[0] >= 'A' && name[0] <= 'Z'
}

// parseMapType extracts key and value types from a map type string
// e.g., "map[string]int" returns ("string", "int")
// e.g., "map[string]map[string]int" returns ("string", "map[string]int")
func parseMapType(mapType string) (keyType, valueType string) {
	// Remove "map[" prefix
	if !strings.HasPrefix(mapType, "map[") {
		return "string", "any"
	}

	inner := mapType[4:] // Remove "map["

	// Find the matching ] for the key type
	// Need to handle nested brackets like map[string]map[string]int
	bracketCount := 1
	keyEnd := 0

	for i, ch := range inner {
		if ch == '[' {
			bracketCount++
		} else if ch == ']' {
			bracketCount--
			if bracketCount == 0 {
				keyEnd = i
				break
			}
		}
	}

	if keyEnd == 0 {
		return "string", "any"
	}

	keyType = inner[:keyEnd]
	valueType = inner[keyEnd+1:]

	return keyType, valueType
}
