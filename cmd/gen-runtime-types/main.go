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
	"reflect"
	"slices"
	"strings"
)

// ExtensionInfo holds information about an extension.
type ExtensionInfo struct {
	Namespace    string       `json:"namespace"`
	SubNamespace string       `json:"subNamespace"`
	Methods      []MethodInfo `json:"methods"`
}

// MethodInfo holds information about a method.
type MethodInfo struct {
	Name       string     `json:"name"`
	Params     []ParamDef `json:"params"`
	ReturnType string     `json:"returnType,omitempty"`
	HasError   bool       `json:"hasError"`
}

// ParamDef describes a method parameter.
type ParamDef struct {
	Name   string `json:"name"`
	GoType string `json:"goType"`
	TSType string `json:"tsType"`
}

// FieldDef describes an exported field on a generated TypeScript interface.
type FieldDef struct {
	Name   string `json:"name"`
	GoType string `json:"goType"`
	TSType string `json:"tsType"`
}

// TypeInfo describes a named exported type referenced by runtime extension APIs.
type TypeInfo struct {
	Name   string     `json:"name"`
	Kind   string     `json:"kind"` // "struct" or "alias"
	Fields []FieldDef `json:"fields,omitempty"`
	TSType string     `json:"tsType,omitempty"`
}

// RuntimeTypes is the output structure.
type RuntimeTypes struct {
	Extensions []ExtensionInfo `json:"extensions"`
	Types      []TypeInfo      `json:"types,omitempty"`
}

type rawTypeInfo struct {
	name      string
	kind      string
	fields    []FieldDef
	aliasType string
}

func main() {
	outputFormat := flag.String("format", "ts", "Output format: ts (TypeScript), json")
	extensionDir := flag.String("dir", "pkg/runtime/extension", "Directory containing extension Go files")
	flag.Parse()

	runtimeTypes, err := parseExtensions(*extensionDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	switch *outputFormat {
	case "json":
		outputJSON(runtimeTypes)
	case "ts":
		fmt.Print(generateTypeScript(runtimeTypes))
	default:
		fmt.Fprintf(os.Stderr, "Unknown format: %s\n", *outputFormat)
		os.Exit(1)
	}
}

func parseExtensions(dir string) (RuntimeTypes, error) {
	extensionMeta := make(map[string]struct {
		namespace    string
		subNamespace string
	})
	methodsTypes := make(map[string][]MethodInfo)
	knownTypes := make(map[string]rawTypeInfo)

	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}

		fset := token.NewFileSet()
		node, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
		if err != nil {
			return fmt.Errorf("failed to parse %s: %w", path, err)
		}

		ast.Inspect(node, func(n ast.Node) bool {
			if typeSpec, ok := n.(*ast.TypeSpec); ok && isExported(typeSpec.Name.Name) {
				switch t := typeSpec.Type.(type) {
				case *ast.StructType:
					knownTypes[typeSpec.Name.Name] = rawTypeInfo{
						name:   typeSpec.Name.Name,
						kind:   "struct",
						fields: extractStructFields(t),
					}
				default:
					knownTypes[typeSpec.Name.Name] = rawTypeInfo{
						name:      typeSpec.Name.Name,
						kind:      "alias",
						aliasType: exprToString(typeSpec.Type),
					}
				}
			}

			funcDecl, ok := n.(*ast.FuncDecl)
			if !ok || funcDecl.Recv == nil || len(funcDecl.Recv.List) == 0 {
				return true
			}

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

			if strings.HasSuffix(recvTypeName, "Methods") && isExported(methodName) {
				method := extractMethod(funcDecl, knownTypes)
				methodsTypes[recvTypeName] = append(methodsTypes[recvTypeName], method)
			}

			return true
		})

		return nil
	})
	if err != nil {
		return RuntimeTypes{}, err
	}

	runtimeTypes := RuntimeTypes{}

	extNames := make([]string, 0, len(extensionMeta))
	for extType, meta := range extensionMeta {
		if meta.namespace != "" && meta.subNamespace != "" {
			extNames = append(extNames, extType)
		}
	}
	slices.Sort(extNames)

	referencedTypes := make(map[string]bool)
	for _, extType := range extNames {
		meta := extensionMeta[extType]
		baseName := strings.TrimSuffix(extType, "Extension")
		methodsTypeName := baseName + "Methods"
		methods := methodsTypes[methodsTypeName]

		for _, method := range methods {
			for _, param := range method.Params {
				collectReferencedTypes(param.GoType, knownTypes, referencedTypes)
			}
			if method.ReturnType != "" {
				collectReferencedTypes(method.ReturnType, knownTypes, referencedTypes)
			}
		}

		runtimeTypes.Extensions = append(runtimeTypes.Extensions, ExtensionInfo{
			Namespace:    meta.namespace,
			SubNamespace: meta.subNamespace,
			Methods:      methods,
		})
	}

	typeNames := make([]string, 0, len(referencedTypes))
	for name := range referencedTypes {
		typeNames = append(typeNames, name)
	}
	slices.Sort(typeNames)

	for _, name := range typeNames {
		typeInfo := knownTypes[name]
		switch typeInfo.kind {
		case "struct":
			fields := make([]FieldDef, 0, len(typeInfo.fields))
			for _, field := range typeInfo.fields {
				fields = append(fields, FieldDef{
					Name:   field.Name,
					GoType: field.GoType,
					TSType: goTypeToTS(field.GoType, knownTypes, false),
				})
			}
			runtimeTypes.Types = append(runtimeTypes.Types, TypeInfo{
				Name:   name,
				Kind:   "struct",
				Fields: fields,
			})
		case "alias":
			runtimeTypes.Types = append(runtimeTypes.Types, TypeInfo{
				Name:   name,
				Kind:   "alias",
				TSType: goTypeToTS(typeInfo.aliasType, knownTypes, false),
			})
		}
	}

	return runtimeTypes, nil
}

func extractStructFields(structType *ast.StructType) []FieldDef {
	fields := make([]FieldDef, 0, len(structType.Fields.List))
	for _, field := range structType.Fields.List {
		goType := exprToString(field.Type)
		for _, name := range field.Names {
			if !isExported(name.Name) {
				continue
			}

			fieldName := name.Name
			if taggedName, ok := jsonFieldName(field); ok {
				fieldName = taggedName
			}
			if fieldName == "-" {
				continue
			}

			fields = append(fields, FieldDef{
				Name:   fieldName,
				GoType: goType,
			})
		}
	}
	return fields
}

func jsonFieldName(field *ast.Field) (string, bool) {
	if field.Tag == nil {
		return "", false
	}

	tagValue := strings.Trim(field.Tag.Value, "`")
	jsonTag := reflect.StructTag(tagValue).Get("json")
	if jsonTag == "" {
		return "", false
	}

	name := strings.Split(jsonTag, ",")[0]
	if name == "" {
		return "", false
	}

	return name, true
}

// extractStringReturn extracts the string return value from a simple return statement.
func extractStringReturn(funcDecl *ast.FuncDecl) string {
	if funcDecl.Body == nil || len(funcDecl.Body.List) == 0 {
		return ""
	}

	for _, stmt := range funcDecl.Body.List {
		if retStmt, ok := stmt.(*ast.ReturnStmt); ok && len(retStmt.Results) == 1 {
			if lit, ok := retStmt.Results[0].(*ast.BasicLit); ok && lit.Kind == token.STRING {
				return strings.Trim(lit.Value, "\"")
			}
		}
	}

	return ""
}

func extractMethod(funcDecl *ast.FuncDecl, knownTypes map[string]rawTypeInfo) MethodInfo {
	methodName := funcDecl.Name.Name
	var params []ParamDef

	if funcDecl.Type.Params != nil {
		paramIndex := 0
		for _, field := range funcDecl.Type.Params.List {
			goType := exprToString(field.Type)
			tsType := goTypeToTS(goType, knownTypes, true)

			if len(field.Names) == 0 {
				params = append(params, ParamDef{
					Name:   fmt.Sprintf("arg%d", paramIndex),
					GoType: goType,
					TSType: tsType,
				})
				paramIndex++
				continue
			}

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
			returnType = goTypeToTS(firstReturn, knownTypes, true)
		}
	}

	return MethodInfo{
		Name:       methodName,
		Params:     params,
		ReturnType: returnType,
		HasError:   hasError,
	}
}

func outputJSON(runtimeTypes RuntimeTypes) {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	encoder.Encode(runtimeTypes)
}

func generateTypeScript(runtimeTypes RuntimeTypes) string {
	var out strings.Builder

	out.WriteString("// Auto-generated Strux Runtime API types\n")
	out.WriteString("// Generated by: go run ./cmd/gen-runtime-types\n")
	out.WriteString("// DO NOT EDIT - regenerate with: go run ./cmd/gen-runtime-types -format=ts > src/types/strux-runtime.ts\n\n")

	var sb strings.Builder
	sb.WriteString("// Strux Runtime API\n")

	if len(runtimeTypes.Types) > 0 {
		sb.WriteString("declare namespace StruxRuntime {\n")
		for i, typeInfo := range runtimeTypes.Types {
			if i > 0 {
				sb.WriteString("\n")
			}
			switch typeInfo.Kind {
			case "struct":
				sb.WriteString(fmt.Sprintf("  interface %s {\n", typeInfo.Name))
				for _, field := range typeInfo.Fields {
					sb.WriteString(fmt.Sprintf("    %s: %s;\n", field.Name, field.TSType))
				}
				sb.WriteString("  }\n")
			case "alias":
				sb.WriteString(fmt.Sprintf("  type %s = %s;\n", typeInfo.Name, typeInfo.TSType))
			}
		}
		sb.WriteString("}\n\n")
	}

	namespaces := make(map[string][]ExtensionInfo)
	for _, ext := range runtimeTypes.Extensions {
		namespaces[ext.Namespace] = append(namespaces[ext.Namespace], ext)
	}

	namespaceNames := make([]string, 0, len(namespaces))
	for namespace := range namespaces {
		namespaceNames = append(namespaceNames, namespace)
	}
	slices.Sort(namespaceNames)

	for _, namespace := range namespaceNames {
		exts := namespaces[namespace]
		slices.SortFunc(exts, func(a, b ExtensionInfo) int {
			return strings.Compare(a.SubNamespace, b.SubNamespace)
		})

		interfaceName := strings.ToUpper(namespace[:1]) + namespace[1:]
		sb.WriteString(fmt.Sprintf("interface %s {\n", interfaceName))

		for _, ext := range exts {
			sb.WriteString(fmt.Sprintf("  %s: {\n", ext.SubNamespace))
			for _, method := range ext.Methods {
				sb.WriteString(fmt.Sprintf("    %s(%s): %s;\n", method.Name, formatParams(method.Params), formatReturnType(method)))
			}
			sb.WriteString("  };\n")
		}

		sb.WriteString("}\n")
	}

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

	struxInterface := sb.String()
	closingBrace := "}\n"
	if idx := strings.LastIndex(struxInterface, closingBrace); idx >= 0 {
		struxInterface = struxInterface[:idx] + ipcTypes + closingBrace
	}

	out.WriteString(fmt.Sprintf("export const STRUX_RUNTIME_TYPES = `%s`;\n", struxInterface))
	return out.String()
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

func goTypeToTS(goType string, knownTypes map[string]rawTypeInfo, qualifyKnownTypes bool) string {
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
	}

	if strings.HasPrefix(goType, "[]") {
		return goTypeToTS(goType[2:], knownTypes, qualifyKnownTypes) + "[]"
	}

	if strings.HasPrefix(goType, "*") {
		return goTypeToTS(goType[1:], knownTypes, qualifyKnownTypes)
	}

	if strings.HasPrefix(goType, "map[") {
		keyType, valueType, ok := parseMapType(goType)
		if !ok {
			return "Record<string, unknown>"
		}
		return fmt.Sprintf("Record<%s, %s>", goTypeToTS(keyType, knownTypes, qualifyKnownTypes), goTypeToTS(valueType, knownTypes, qualifyKnownTypes))
	}

	if strings.Contains(goType, ".") {
		parts := strings.Split(goType, ".")
		name := parts[len(parts)-1]
		if _, ok := knownTypes[name]; ok {
			return name
		}
		return "unknown"
	}

	if _, ok := knownTypes[goType]; ok {
		if qualifyKnownTypes {
			return "StruxRuntime." + goType
		}
		return goType
	}

	return "unknown"
}

func parseMapType(goType string) (string, string, bool) {
	if !strings.HasPrefix(goType, "map[") {
		return "", "", false
	}

	depth := 0
	for i := 4; i < len(goType); i++ {
		switch goType[i] {
		case '[':
			depth++
		case ']':
			if depth == 0 {
				return goType[4:i], goType[i+1:], true
			}
			depth--
		}
	}

	return "", "", false
}

func collectReferencedTypes(goType string, knownTypes map[string]rawTypeInfo, seen map[string]bool) {
	for _, name := range extractReferencedTypeNames(goType, knownTypes) {
		if seen[name] {
			continue
		}
		seen[name] = true

		typeInfo := knownTypes[name]
		if typeInfo.kind == "struct" {
			for _, field := range typeInfo.fields {
				collectReferencedTypes(field.GoType, knownTypes, seen)
			}
		}
		if typeInfo.kind == "alias" && typeInfo.aliasType != "" {
			collectReferencedTypes(typeInfo.aliasType, knownTypes, seen)
		}
	}
}

func extractReferencedTypeNames(goType string, knownTypes map[string]rawTypeInfo) []string {
	switch {
	case strings.HasPrefix(goType, "[]"):
		return extractReferencedTypeNames(goType[2:], knownTypes)
	case strings.HasPrefix(goType, "*"):
		return extractReferencedTypeNames(goType[1:], knownTypes)
	case strings.HasPrefix(goType, "map["):
		keyType, valueType, ok := parseMapType(goType)
		if !ok {
			return nil
		}
		names := extractReferencedTypeNames(keyType, knownTypes)
		names = append(names, extractReferencedTypeNames(valueType, knownTypes)...)
		return names
	case strings.Contains(goType, "."):
		parts := strings.Split(goType, ".")
		goType = parts[len(parts)-1]
	}

	if _, ok := knownTypes[goType]; ok {
		return []string{goType}
	}
	return nil
}

func isExported(name string) bool {
	if len(name) == 0 {
		return false
	}
	return name[0] >= 'A' && name[0] <= 'Z'
}
