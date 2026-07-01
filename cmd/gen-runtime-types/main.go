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

// RuntimeExtensionDef describes a runtime API registered under a namespace.
type RuntimeExtensionDef struct {
	Methods []MethodDef `json:"methods"`
}

// MethodDef describes a method.
type MethodDef struct {
	Name        string     `json:"name"`
	Params      []ParamDef `json:"params"`
	ReturnTypes []TypeDef  `json:"returnTypes"`
	HasError    bool       `json:"hasError"`
}

// TypeDef describes a type.
type TypeDef struct {
	GoType string `json:"goType"`
	TSType string `json:"tsType"`
}

// ParamDef describes a method parameter.
type ParamDef struct {
	Name   string `json:"name"`
	GoType string `json:"goType"`
	TSType string `json:"tsType"`
}

// FieldDef describes an exported field on a generated TypeScript interface.
//
// Optional marks a field that may be absent from the payload — rendered as a TS
// optional member `name?: T`. It is set ONLY for fields explicitly tagged
// `strux:"optional"`, which is how optional-feature state (e.g.
// AudioState.AutoSwitch) is modeled: present when the BSP implements the
// feature, absent otherwise. Plain pointers are NOT made optional — a pointer is
// an implementation detail, not a contract that the value can be missing.
type FieldDef struct {
	Name     string `json:"name"`
	GoType   string `json:"goType"`
	TSType   string `json:"tsType"`
	Optional bool   `json:"optional,omitempty"`
}

// StructDef describes a struct definition.
type StructDef struct {
	Fields  []FieldDef  `json:"fields"`
	Methods []MethodDef `json:"methods,omitempty"`
}

// RuntimeTypes is the output structure.
type RuntimeTypes struct {
	Extensions map[string]map[string]RuntimeExtensionDef `json:"extensions"`
	Structs    map[string]StructDef                      `json:"structs"`
}

type rawTypeInfo struct {
	name      string
	kind      string
	fields    []FieldDef
	aliasType string
}

type extensionRef struct {
	namespace       string
	subNamespace    string
	methodsTypeName string
}

func main() {
	outputFormat := flag.String("format", "ts", "Output format: ts (TypeScript const), dts (declaration body), json")
	extensionDir := flag.String("dir", "pkg/runtime/api", "Directory containing runtime API Go files. Multiple dirs may be comma-separated.")
	flag.Parse()

	runtimeTypes, err := parseExtensionDirs(splitDirs(*extensionDir))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	switch *outputFormat {
	case "json":
		outputJSON(runtimeTypes)
	case "dts":
		fmt.Print(generateTypeScriptDeclarations(runtimeTypes, false))
	case "ts":
		fmt.Print(generateTypeScript(runtimeTypes))
	default:
		fmt.Fprintf(os.Stderr, "Unknown format: %s\n", *outputFormat)
		os.Exit(1)
	}
}

func parseExtensions(dir string) (RuntimeTypes, error) {
	return parseExtensionDirs([]string{dir})
}

func parseExtensionDirs(dirs []string) (RuntimeTypes, error) {
	extensionMeta := make(map[string]struct {
		namespace    string
		subNamespace string
	})
	methodsByType := make(map[string][]MethodDef)
	namespaceByServiceBase := make(map[string]string)
	knownTypes := make(map[string]rawTypeInfo)
	var registeredExtensions []extensionRef

	for _, dir := range dirs {
		if dir == "" {
			continue
		}

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
				if genDecl, ok := n.(*ast.GenDecl); ok && genDecl.Tok == token.CONST {
					for _, spec := range genDecl.Specs {
						valueSpec, ok := spec.(*ast.ValueSpec)
						if !ok {
							continue
						}
						for i, name := range valueSpec.Names {
							if !strings.HasSuffix(name.Name, "Namespace") || i >= len(valueSpec.Values) {
								continue
							}
							namespace := extractStringLiteral(valueSpec.Values[i])
							if namespace == "" {
								continue
							}
							baseName := strings.TrimSuffix(name.Name, "Namespace")
							namespaceByServiceBase[baseName] = namespace
						}
					}
				}

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

				if funcDecl, ok := n.(*ast.FuncDecl); ok {
					if funcDecl.Name.Name == "init" && funcDecl.Body != nil {
						registeredExtensions = append(registeredExtensions, extractRegisteredExtensions(funcDecl.Body)...)
					}
					if funcDecl.Recv == nil || len(funcDecl.Recv.List) == 0 {
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

					if isExported(methodName) {
						method := extractMethod(funcDecl, knownTypes)
						methodsByType[recvTypeName] = append(methodsByType[recvTypeName], method)
					}

					return true
				}

				return true
			})

			return nil
		})
		if err != nil {
			return RuntimeTypes{}, err
		}
	}

	runtimeTypes := RuntimeTypes{
		Extensions: make(map[string]map[string]RuntimeExtensionDef),
		Structs:    make(map[string]StructDef),
	}

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
		methods := methodsByType[methodsTypeName]

		for _, method := range methods {
			for _, param := range method.Params {
				collectReferencedTypes(param.GoType, knownTypes, referencedTypes)
			}
			for _, returnType := range method.ReturnTypes {
				collectReferencedTypes(returnType.GoType, knownTypes, referencedTypes)
			}
		}

		addRuntimeExtension(runtimeTypes, meta.namespace, meta.subNamespace, methods)
	}

	serviceNames := make([]string, 0, len(namespaceByServiceBase))
	for baseName := range namespaceByServiceBase {
		if _, ok := methodsByType[baseName+"Service"]; ok {
			serviceNames = append(serviceNames, baseName)
		}
	}
	slices.Sort(serviceNames)

	for _, baseName := range serviceNames {
		methods := methodsByType[baseName+"Service"]
		for _, method := range methods {
			for _, param := range method.Params {
				collectReferencedTypes(param.GoType, knownTypes, referencedTypes)
			}
			for _, returnType := range method.ReturnTypes {
				collectReferencedTypes(returnType.GoType, knownTypes, referencedTypes)
			}
		}

		addRuntimeExtension(runtimeTypes, "strux", namespaceByServiceBase[baseName], methods)
	}

	slices.SortFunc(registeredExtensions, func(a, b extensionRef) int {
		if a.namespace != b.namespace {
			return strings.Compare(a.namespace, b.namespace)
		}
		if a.subNamespace != b.subNamespace {
			return strings.Compare(a.subNamespace, b.subNamespace)
		}
		return strings.Compare(a.methodsTypeName, b.methodsTypeName)
	})

	seenExtensions := make(map[string]bool)
	for namespace, subNamespaces := range runtimeTypes.Extensions {
		for subNamespace := range subNamespaces {
			seenExtensions[namespace+"."+subNamespace] = true
		}
	}

	for _, ext := range registeredExtensions {
		key := ext.namespace + "." + ext.subNamespace
		if seenExtensions[key] {
			continue
		}

		methods := methodsByType[ext.methodsTypeName]
		for _, method := range methods {
			for _, param := range method.Params {
				collectReferencedTypes(param.GoType, knownTypes, referencedTypes)
			}
			for _, returnType := range method.ReturnTypes {
				collectReferencedTypes(returnType.GoType, knownTypes, referencedTypes)
			}
		}

		addRuntimeExtension(runtimeTypes, ext.namespace, ext.subNamespace, methods)
		seenExtensions[key] = true
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
					Name:     field.Name,
					GoType:   field.GoType,
					TSType:   goTypeToTS(field.GoType, knownTypes, false),
					Optional: field.Optional,
				})
			}
			runtimeTypes.Structs[name] = StructDef{Fields: fields}
		case "alias":
			// Runtime JSON uses the same struct/method shape as strux-introspect.
			// Aliases are resolved to their underlying TypeScript type at reference sites.
		}
	}

	return runtimeTypes, nil
}

func splitDirs(value string) []string {
	parts := strings.Split(value, ",")
	dirs := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			dirs = append(dirs, part)
		}
	}
	return dirs
}

func addRuntimeExtension(runtimeTypes RuntimeTypes, namespace string, subNamespace string, methods []MethodDef) {
	if runtimeTypes.Extensions[namespace] == nil {
		runtimeTypes.Extensions[namespace] = make(map[string]RuntimeExtensionDef)
	}
	runtimeTypes.Extensions[namespace][subNamespace] = RuntimeExtensionDef{Methods: methods}
}

func extractRegisteredExtensions(body *ast.BlockStmt) []extensionRef {
	var refs []extensionRef

	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}

		namespace, subNamespace, methodsTypeName, ok := extractRegistrationCall(call)
		if !ok {
			return true
		}
		if namespace == "" || subNamespace == "" || methodsTypeName == "" {
			return true
		}

		refs = append(refs, extensionRef{
			namespace:       namespace,
			subNamespace:    subNamespace,
			methodsTypeName: methodsTypeName,
		})
		return true
	})

	return refs
}

func extractRegistrationCall(call *ast.CallExpr) (string, string, string, bool) {
	name := callName(call)

	switch {
	case name == "RegisterCustomExtension" && len(call.Args) == 2:
		return "strux", extractStringLiteral(call.Args[0]), extractInstanceType(call.Args[1]), true
	case name == "RegisterExtension" && len(call.Args) == 3:
		return extractStringLiteral(call.Args[0]), extractStringLiteral(call.Args[1]), extractInstanceType(call.Args[2]), true
	default:
		return "", "", "", false
	}
}

func callName(call *ast.CallExpr) string {
	switch fun := call.Fun.(type) {
	case *ast.SelectorExpr:
		return fun.Sel.Name
	case *ast.Ident:
		return fun.Name
	default:
		return ""
	}
}

func extractStringLiteral(expr ast.Expr) string {
	lit, ok := expr.(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return ""
	}
	return strings.Trim(lit.Value, `"`)
}

func extractInstanceType(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.UnaryExpr:
		if t.Op == token.AND {
			return extractInstanceType(t.X)
		}
	case *ast.CompositeLit:
		return exprToTypeName(t.Type)
	}
	return ""
}

func exprToTypeName(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.SelectorExpr:
		return t.Sel.Name
	case *ast.StarExpr:
		return exprToTypeName(t.X)
	default:
		return ""
	}
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
				Name:     fieldName,
				GoType:   goType,
				Optional: fieldIsOptional(field),
			})
		}
	}
	return fields
}

// fieldIsOptional reports whether a field is explicitly marked optional for the
// generated TypeScript via a `strux:"optional"` tag. This is how optional-feature
// state fields (e.g. AudioState.AutoSwitch) render as `name?: T` — present only
// when the BSP implements the feature — without making every pointer optional.
func fieldIsOptional(field *ast.Field) bool {
	if field.Tag == nil {
		return false
	}
	tagValue := strings.Trim(field.Tag.Value, "`")
	return slices.Contains(strings.Split(reflect.StructTag(tagValue).Get("strux"), ","), "optional")
}

// formatFieldDTS renders a struct field as a TypeScript interface member,
// honoring Optional (name?: T).
func formatFieldDTS(field FieldDef) string {
	if field.Optional {
		return fmt.Sprintf("%s?: %s", field.Name, field.TSType)
	}
	return fmt.Sprintf("%s: %s", field.Name, field.TSType)
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

func extractMethod(funcDecl *ast.FuncDecl, knownTypes map[string]rawTypeInfo) MethodDef {
	methodName := funcDecl.Name.Name
	params := []ParamDef{}

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

	returnTypes := []TypeDef{}
	hasError := false

	if funcDecl.Type.Results != nil && len(funcDecl.Type.Results.List) > 0 {
		results := funcDecl.Type.Results.List
		lastReturn := exprToString(results[len(results)-1].Type)
		if lastReturn == "error" {
			hasError = true
		}

		for _, result := range results {
			goType := exprToString(result.Type)
			if goType == "error" {
				continue
			}
			if len(result.Names) > 1 {
				for range result.Names {
					returnTypes = append(returnTypes, TypeDef{
						GoType: goType,
						TSType: goTypeToTS(goType, knownTypes, true),
					})
				}
				continue
			}
			returnTypes = append(returnTypes, TypeDef{
				GoType: goType,
				TSType: goTypeToTS(goType, knownTypes, true),
			})
		}
	}

	return MethodDef{
		Name:        methodName,
		Params:      params,
		ReturnTypes: returnTypes,
		HasError:    hasError,
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

	data, err := json.MarshalIndent(runtimeTypes, "", "  ")
	if err != nil {
		panic(err)
	}
	out.WriteString("export const STRUX_RUNTIME_TYPES = ")
	out.Write(data)
	out.WriteString(" as const;\n")
	return out.String()
}

func generateTypeScriptDeclarations(runtimeTypes RuntimeTypes, includeIPC bool) string {
	var sb strings.Builder
	sb.WriteString("// Strux Runtime API\n")

	if len(runtimeTypes.Structs) > 0 {
		sb.WriteString("declare namespace StruxRuntime {\n")
		typeNames := make([]string, 0, len(runtimeTypes.Structs))
		for name := range runtimeTypes.Structs {
			typeNames = append(typeNames, name)
		}
		slices.Sort(typeNames)
		for i, name := range typeNames {
			if i > 0 {
				sb.WriteString("\n")
			}
			structDef := runtimeTypes.Structs[name]
			sb.WriteString(fmt.Sprintf("  interface %s {\n", name))
			for _, field := range structDef.Fields {
				sb.WriteString(fmt.Sprintf("    %s;\n", formatFieldDTS(field)))
			}
			sb.WriteString("  }\n")
		}
		sb.WriteString("}\n\n")
	}

	namespaceNames := make([]string, 0, len(runtimeTypes.Extensions))
	for namespace := range runtimeTypes.Extensions {
		namespaceNames = append(namespaceNames, namespace)
	}
	slices.Sort(namespaceNames)

	for _, namespace := range namespaceNames {
		interfaceName := strings.ToUpper(namespace[:1]) + namespace[1:]
		sb.WriteString(fmt.Sprintf("interface %s {\n", interfaceName))

		subNamespaceNames := make([]string, 0, len(runtimeTypes.Extensions[namespace]))
		for subNamespace := range runtimeTypes.Extensions[namespace] {
			subNamespaceNames = append(subNamespaceNames, subNamespace)
		}
		slices.Sort(subNamespaceNames)

		for _, subNamespace := range subNamespaceNames {
			ext := runtimeTypes.Extensions[namespace][subNamespace]
			sb.WriteString(fmt.Sprintf("  %s: {\n", subNamespace))
			for _, method := range ext.Methods {
				sb.WriteString(fmt.Sprintf("    %s(%s): %s;\n", method.Name, formatParams(method.Params), formatReturnType(method)))
			}
			sb.WriteString("  };\n")
		}

		sb.WriteString("}\n")
	}

	if includeIPC {
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
		return struxInterface
	}

	return sb.String()
}

func formatParams(params []ParamDef) string {
	var parts []string
	for _, p := range params {
		parts = append(parts, fmt.Sprintf("%s: %s", p.Name, p.TSType))
	}
	return strings.Join(parts, ", ")
}

func formatReturnType(method MethodDef) string {
	baseType := "void"
	if len(method.ReturnTypes) == 1 {
		baseType = method.ReturnTypes[0].TSType
		if method.HasError {
			baseType += " | null"
		}
	} else if len(method.ReturnTypes) > 1 {
		parts := make([]string, 0, len(method.ReturnTypes))
		for _, returnType := range method.ReturnTypes {
			parts = append(parts, returnType.TSType)
		}
		baseType = "[" + strings.Join(parts, ", ") + "]"
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
		if typeInfo, ok := knownTypes[name]; ok {
			if typeInfo.kind == "alias" {
				return goTypeToTS(typeInfo.aliasType, knownTypes, qualifyKnownTypes)
			}
			if qualifyKnownTypes {
				return "StruxRuntime." + name
			}
			return name
		}
		return "unknown"
	}

	if typeInfo, ok := knownTypes[goType]; ok {
		if typeInfo.kind == "alias" {
			return goTypeToTS(typeInfo.aliasType, knownTypes, qualifyKnownTypes)
		}
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
	case strings.HasSuffix(goType, "[]"):
		return extractReferencedTypeNames(strings.TrimSuffix(goType, "[]"), knownTypes)
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
