package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
)

// ExtensionInfo holds information about an extension
type ExtensionInfo struct {
	Namespace    string       `json:"namespace"`
	SubNamespace string       `json:"subNamespace"`
	Methods      []MethodInfo `json:"methods"`
}

// MethodInfo holds information about a method
type MethodInfo struct {
	Name       string     `json:"name"`
	Params     []ParamDef `json:"params"`
	ReturnType string     `json:"returnType,omitempty"`
	HasError   bool       `json:"hasError"`
}

// ParamDef describes a method parameter
type ParamDef struct {
	Name   string `json:"name"`
	GoType string `json:"goType"`
	TSType string `json:"tsType"`
}

// RuntimeTypes is the output structure
type RuntimeTypes struct {
	Extensions []ExtensionInfo `json:"extensions"`
}

func main() {
	outputFormat := flag.String("format", "ts", "Output format: ts (TypeScript), json")
	extensionDir := flag.String("dir", "pkg/runtime/extension", "Directory containing extension Go files")
	flag.Parse()

	extensions, err := parseExtensions(*extensionDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	switch *outputFormat {
	case "json":
		outputJSON(extensions)
	case "ts":
		outputTypeScript(extensions)
	default:
		fmt.Fprintf(os.Stderr, "Unknown format: %s\n", *outputFormat)
		os.Exit(1)
	}
}

func parseExtensions(dir string) ([]ExtensionInfo, error) {
	var extensions []ExtensionInfo

	// Maps to store extension metadata and methods
	extensionMeta := make(map[string]struct{ namespace, subNamespace string }) // TypeName -> namespace info
	methodsTypes := make(map[string][]MethodInfo)                              // TypeName -> methods

	// Parse all Go files in the directory
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}

		fset := token.NewFileSet()
		node, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
		if err != nil {
			return fmt.Errorf("failed to parse %s: %w", path, err)
		}

		ast.Inspect(node, func(n ast.Node) bool {
			// Look for method declarations
			if funcDecl, ok := n.(*ast.FuncDecl); ok {
				if funcDecl.Recv == nil || len(funcDecl.Recv.List) == 0 {
					return true
				}

				// Get receiver type name
				recvType := funcDecl.Recv.List[0].Type
				var recvTypeName string
				switch t := recvType.(type) {
				case *ast.StarExpr:
					if ident, ok := t.X.(*ast.Ident); ok {
						recvTypeName = ident.Name
					}
				case *ast.Ident:
					recvTypeName = t.Name
				}

				if recvTypeName == "" {
					return true
				}

				methodName := funcDecl.Name.Name

				// Check if this is a Namespace() or SubNamespace() method on an Extension type
				if methodName == "Namespace" && strings.HasSuffix(recvTypeName, "Extension") {
					if retVal := extractStringReturn(funcDecl); retVal != "" {
						meta := extensionMeta[recvTypeName]
						meta.namespace = retVal
						extensionMeta[recvTypeName] = meta
					}
					return true
				}

				if methodName == "SubNamespace" && strings.HasSuffix(recvTypeName, "Extension") {
					if retVal := extractStringReturn(funcDecl); retVal != "" {
						meta := extensionMeta[recvTypeName]
						meta.subNamespace = retVal
						extensionMeta[recvTypeName] = meta
					}
					return true
				}

				// Check if this is a method on a Methods type
				if strings.HasSuffix(recvTypeName, "Methods") && isExported(methodName) {
					method := extractMethod(funcDecl)
					methodsTypes[recvTypeName] = append(methodsTypes[recvTypeName], method)
				}
			}

			return true
		})

		return nil
	})

	if err != nil {
		return nil, err
	}

	// Match extensions with their methods
	// Convention: BootExtension pairs with BootMethods
	for extType, meta := range extensionMeta {
		if meta.namespace == "" || meta.subNamespace == "" {
			continue
		}

		// Derive methods type name from extension type name
		// BootExtension -> BootMethods
		baseName := strings.TrimSuffix(extType, "Extension")
		methodsTypeName := baseName + "Methods"

		methods := methodsTypes[methodsTypeName]

		extensions = append(extensions, ExtensionInfo{
			Namespace:    meta.namespace,
			SubNamespace: meta.subNamespace,
			Methods:      methods,
		})
	}

	return extensions, nil
}

// extractStringReturn extracts the string return value from a simple return statement
// e.g., func (b *BootExtension) Namespace() string { return "strux" }
func extractStringReturn(funcDecl *ast.FuncDecl) string {
	if funcDecl.Body == nil || len(funcDecl.Body.List) == 0 {
		return ""
	}

	// Look for a return statement with a string literal
	for _, stmt := range funcDecl.Body.List {
		if retStmt, ok := stmt.(*ast.ReturnStmt); ok {
			if len(retStmt.Results) == 1 {
				if lit, ok := retStmt.Results[0].(*ast.BasicLit); ok {
					if lit.Kind == token.STRING {
						// Remove quotes
						return strings.Trim(lit.Value, "\"")
					}
				}
			}
		}
	}

	return ""
}

func extractMethod(funcDecl *ast.FuncDecl) MethodInfo {
	methodName := funcDecl.Name.Name
	var params []ParamDef

	// Extract parameters
	if funcDecl.Type.Params != nil {
		paramIndex := 0
		for _, field := range funcDecl.Type.Params.List {
			goType := exprToString(field.Type)
			tsType := goTypeToTS(goType)

			if len(field.Names) == 0 {
				params = append(params, ParamDef{
					Name:   fmt.Sprintf("arg%d", paramIndex),
					GoType: goType,
					TSType: tsType,
				})
				paramIndex++
			} else {
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

	// Extract return type
	var returnType string
	hasError := false

	if funcDecl.Type.Results != nil && len(funcDecl.Type.Results.List) > 0 {
		results := funcDecl.Type.Results.List
		lastReturn := exprToString(results[len(results)-1].Type)

		if lastReturn == "error" {
			hasError = true
		}

		firstReturn := exprToString(results[0].Type)
		if firstReturn != "error" {
			returnType = goTypeToTS(firstReturn)
		}
	}

	return MethodInfo{
		Name:       methodName,
		Params:     params,
		ReturnType: returnType,
		HasError:   hasError,
	}
}

func outputJSON(extensions []ExtensionInfo) {
	output := RuntimeTypes{Extensions: extensions}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	encoder.Encode(output)
}

func outputTypeScript(extensions []ExtensionInfo) {
	fmt.Println("// Auto-generated Strux Runtime API types")
	fmt.Println("// Generated by: go run ./cmd/gen-runtime-types")
	fmt.Println("// DO NOT EDIT - regenerate with: go run ./cmd/gen-runtime-types -format=ts > src/types/strux-runtime.ts")
	fmt.Println()

	// Build the interface string
	var sb strings.Builder

	// Group extensions by namespace
	namespaces := make(map[string][]ExtensionInfo)
	for _, ext := range extensions {
		namespaces[ext.Namespace] = append(namespaces[ext.Namespace], ext)
	}

	// Generate interface for each namespace
	for namespace, exts := range namespaces {
		// Capitalize first letter for interface name
		interfaceName := strings.ToUpper(namespace[:1]) + namespace[1:]

		sb.WriteString(fmt.Sprintf("interface %s {\n", interfaceName))

		for _, ext := range exts {
			sb.WriteString(fmt.Sprintf("  %s: {\n", ext.SubNamespace))

			for _, method := range ext.Methods {
				params := formatParams(method.Params)
				returnType := formatReturnType(method)
				sb.WriteString(fmt.Sprintf("    %s(%s): %s;\n", method.Name, params, returnType))
			}

			sb.WriteString("  };\n")
		}

		sb.WriteString("}\n")
	}

	// Append strux.ipc types (injected by WPE extension, not a Go extension)
	// These are hardcoded here because they're implemented in C, not discoverable via Go AST
	ipcTypes := `  ipc: {
    /**
     * Register a listener for an event from the Go backend.
     * Returns an unsubscribe function.
     */
    on(event: string, callback: (data: any) => void): () => void;
    /**
     * Remove a previously registered event listener.
     */
    off(event: string, callback: (data: any) => void): void;
    /**
     * Send an event to the Go backend.
     */
    send(event: string, data?: any): void;
  };
`
	// Inject ipc into the Strux interface (before the closing brace)
	struxInterface := sb.String()
	closingBrace := "}\n"
	if idx := strings.LastIndex(struxInterface, closingBrace); idx >= 0 {
		struxInterface = struxInterface[:idx] + ipcTypes + closingBrace
	}

	// Output as exportable constant
	fmt.Printf("export const STRUX_RUNTIME_TYPES = `// Strux Runtime API\n%s`;\n", struxInterface)
}

func formatParams(params []ParamDef) string {
	var parts []string
	for _, p := range params {
		parts = append(parts, fmt.Sprintf("%s: %s", p.Name, p.TSType))
	}
	return strings.Join(parts, ", ")
}

func formatReturnType(method MethodInfo) string {
	baseType := "void"
	if method.ReturnType != "" {
		baseType = method.ReturnType
		if method.HasError {
			baseType += " | null"
		}
	}
	return fmt.Sprintf("Promise<%s>", baseType)
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
	default:
		return "unknown"
	}
}

func goTypeToTS(goType string) string {
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
		if strings.HasPrefix(goType, "[]") {
			return goTypeToTS(goType[2:]) + "[]"
		}
		if strings.HasPrefix(goType, "map[") {
			return "Record<string, any>"
		}
		if strings.HasPrefix(goType, "*") {
			return goTypeToTS(goType[1:])
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
