package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
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
	Fields  []FieldDef  `json:"fields"`
	Methods []MethodDef `json:"methods,omitempty"`
}

// FieldDef describes a struct field.
//
// Optional marks a field that may be absent from the payload — rendered as a TS
// optional member `name?: T`. It is carried only for the framework's committed
// runtime types (which arrive already classified via the runtime JSON, set from
// a `strux:"optional"` tag at generation time). App- and extension-introspected
// structs keep their prior rendering and never set it.
type FieldDef struct {
	Name     string `json:"name"`
	GoType   string `json:"goType"`
	TSType   string `json:"tsType"`
	Optional bool   `json:"optional,omitempty"`
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

// RuntimeExtensionDef describes a runtime API registered under a namespace.
type RuntimeExtensionDef struct {
	Methods []MethodDef `json:"methods"`
}

// RuntimeTypes describes Strux runtime APIs that are merged into the final d.ts.
type RuntimeTypes struct {
	Extensions map[string]map[string]RuntimeExtensionDef `json:"extensions"`
	Structs    map[string]StructDef                      `json:"structs"`
}

type runtimeExtensionRef struct {
	namespace       string
	subNamespace    string
	methodsTypeName string
}

type introspectOptions struct {
	filePath        string
	runtimeDTS      bool
	runtimeDTSDirs  string
	runtimeJSONPath string
}

func main() {
	opts, err := parseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	if opts.runtimeDTS {
		output, err := generateDTS(opts)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Print(output)
		return
	}

	if err := introspect(opts.filePath); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func parseArgs(args []string) (introspectOptions, error) {
	opts := introspectOptions{filePath: "main.go"}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch arg {
		case "--runtime-dts":
			opts.runtimeDTS = true
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
				i++
				opts.runtimeDTSDirs = args[i]
			}
		case "--runtime-json":
			i++
			if i >= len(args) {
				return opts, fmt.Errorf("--runtime-json requires a file path")
			}
			opts.runtimeJSONPath = args[i]
		default:
			if strings.HasPrefix(arg, "--") {
				return opts, fmt.Errorf("unknown option %s", arg)
			}
			opts.filePath = arg
		}
	}
	return opts, nil
}

func introspect(filePath string) error {
	output, err := introspectData(filePath)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(output)
}

func introspectData(filePath string) (IntrospectionOutput, error) {
	// Check if file exists
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		return IntrospectionOutput{}, fmt.Errorf("%s not found", filePath)
	}

	// Parse all Go files in the same directory to capture methods defined in other files
	dir := filepath.Dir(filePath)
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, dir, nil, parser.ParseComments)
	if err != nil {
		return IntrospectionOutput{}, fmt.Errorf("failed to parse directory %s: %w", dir, err)
	}

	// Find the package that contains the specified file
	var files []*ast.File
	var packageName string
	absFilePath, _ := filepath.Abs(filePath)

	for pkgName, pkg := range pkgs {
		for fpath, file := range pkg.Files {
			absFpath, _ := filepath.Abs(fpath)
			if absFpath == absFilePath {
				packageName = pkgName
				// Collect all files from this package
				for _, f := range pkg.Files {
					files = append(files, f)
				}
				_ = file
				break
			}
		}
		if packageName != "" {
			break
		}
	}

	// Fallback: if we couldn't match by path, use the first package
	if packageName == "" {
		for pkgName, pkg := range pkgs {
			packageName = pkgName
			for _, f := range pkg.Files {
				files = append(files, f)
			}
			break
		}
	}

	if len(files) == 0 {
		return IntrospectionOutput{}, fmt.Errorf("no Go files found in %s", dir)
	}

	// Collect all structs and their fields
	structFields := make(map[string][]FieldDef)
	knownStructs := make(map[string]bool)
	typeAliases := make(map[string]string) // named type -> underlying type (e.g., "AudioOutput" -> "string")

	// First pass: discover all struct types and type aliases across all files
	for _, file := range files {
		ast.Inspect(file, func(n ast.Node) bool {
			if typeSpec, ok := n.(*ast.TypeSpec); ok {
				if _, ok := typeSpec.Type.(*ast.StructType); ok {
					knownStructs[typeSpec.Name.Name] = true
				} else {
					// Track non-struct type aliases (e.g., type AudioOutput string)
					underlying := exprToString(typeSpec.Type)
					typeAliases[typeSpec.Name.Name] = underlying
					globalTypeAliases[typeSpec.Name.Name] = underlying
				}
			}
			return true
		})
	}

	// Determine the app struct by finding what's passed to runtime.Start()
	appStructName := findRuntimeStartStruct(files)

	// Default to "App" if runtime.Start() detection failed
	if appStructName == "" {
		appStructName = "App"
	}

	// Second pass: extract struct fields and methods across all files
	structMethods := make(map[string][]MethodDef)

	for _, file := range files {
		ast.Inspect(file, func(n ast.Node) bool {
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
								// App-owned structs intentionally keep their prior
								// rendering: a pointer field is NOT marked optional/
								// nullable here. The app developer owns these types and
								// their nullability; forcing null-checks across their own
								// model would be churn. Optionality is reserved for the
								// runtime API surface (framework + BSP extensions).
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

			// Collect methods on all known structs
			if funcDecl, ok := n.(*ast.FuncDecl); ok {
				if funcDecl.Recv != nil && len(funcDecl.Recv.List) > 0 {
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

					if recvTypeName != "" && knownStructs[recvTypeName] {
						methodName := funcDecl.Name.Name
						if isExported(methodName) {
							method := extractMethod(funcDecl, knownStructs)
							structMethods[recvTypeName] = append(structMethods[recvTypeName], method)
						}
					}
				}
			}

			return true
		})
	}

	// Extract app methods for convenience
	methods := structMethods[appStructName]

	// Resolve external package types recursively (e.g., security.TorStatus -> network.Connection -> ...)
	// Build the global import alias -> path map, starting from the main package files
	importMap := make(map[string]string) // alias -> import path
	for _, file := range files {
		collectImports(file, importMap)
	}

	// qualifiedToTS maps "security.TorStatus" -> "TorStatus" for TS name resolution
	qualifiedToTS := make(map[string]string)
	// resolvedTypes tracks which qualified types have already been resolved to avoid circular refs
	resolvedTypes := make(map[string]bool)

	// Seed the initial set of qualified types from all struct fields and methods
	var allMethods []MethodDef
	for _, ms := range structMethods {
		allMethods = append(allMethods, ms...)
	}
	var allFields []FieldDef
	for _, fs := range structFields {
		allFields = append(allFields, fs...)
	}
	pendingTypes := collectQualifiedTypes(allFields, allMethods)

	// Recursively resolve external types until no new ones are discovered
	for len(pendingTypes) > 0 {
		// Group pending types by package alias
		pkgTypes := make(map[string][]string) // alias -> []structName
		for _, qt := range pendingTypes {
			if resolvedTypes[qt] {
				continue
			}
			resolvedTypes[qt] = true

			parts := strings.SplitN(qt, ".", 2)
			if len(parts) == 2 {
				pkgAlias := parts[0]
				typeName := parts[1]
				if _, exists := importMap[pkgAlias]; exists {
					pkgTypes[pkgAlias] = append(pkgTypes[pkgAlias], typeName)
				}
			}
		}

		if len(pkgTypes) == 0 {
			break
		}

		// Resolve each external package
		var newlyResolved []FieldDef
		for pkgAlias, typeNames := range pkgTypes {
			importPath := importMap[pkgAlias]
			extStructs, extMethods, extImports := resolveExternalPackage(dir, importPath, typeNames, knownStructs)
			for name, fields := range extStructs {
				structFields[name] = fields
				knownStructs[name] = true
				qualifiedToTS[pkgAlias+"."+name] = name
				newlyResolved = append(newlyResolved, fields...)
			}
			for name, methods := range extMethods {
				structMethods[name] = append(structMethods[name], methods...)
			}
			// Merge the external package's imports so we can resolve its dependencies
			for alias, path := range extImports {
				if _, exists := importMap[alias]; !exists {
					importMap[alias] = path
				}
			}
		}

		// Scan newly resolved struct fields for more qualified types
		pendingTypes = collectQualifiedTypesFromFields(newlyResolved)
	}

	// Re-resolve TS types for everything now that all external structs are known
	if len(qualifiedToTS) > 0 {
		// Re-resolve app struct fields
		if appFields, ok := structFields[appStructName]; ok {
			for i, f := range appFields {
				appFields[i].TSType = goTypeToTSWithQualified(f.GoType, knownStructs, qualifiedToTS)
			}
			structFields[appStructName] = appFields
		}

		// Re-resolve method params and return types for all structs
		for structName, smethods := range structMethods {
			for i, m := range smethods {
				for j, p := range m.Params {
					structMethods[structName][i].Params[j].TSType = goTypeToTSWithQualified(p.GoType, knownStructs, qualifiedToTS)
				}
				for j, rt := range m.ReturnTypes {
					structMethods[structName][i].ReturnTypes[j].TSType = goTypeToTSWithQualified(rt.GoType, knownStructs, qualifiedToTS)
				}
			}
		}
		// Refresh app methods reference after re-resolution
		methods = structMethods[appStructName]

		// Re-resolve all external struct fields too
		for name, fields := range structFields {
			if name == appStructName {
				continue
			}
			for i, f := range fields {
				fields[i].TSType = goTypeToTSWithQualified(f.GoType, knownStructs, qualifiedToTS)
			}
			structFields[name] = fields
		}
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

	// Add all structs except the app struct, including their methods
	for name, fields := range structFields {
		if name != appStructName {
			output.Structs[name] = StructDef{
				Fields:  fields,
				Methods: structMethods[name],
			}
		}
	}

	return output, nil
}

func generateDTS(opts introspectOptions) (string, error) {
	app, err := introspectData(opts.filePath)
	if err != nil {
		return "", err
	}

	runtimeTypes := emptyRuntimeTypes()
	if opts.runtimeJSONPath != "" {
		builtin, err := readRuntimeTypes(opts.runtimeJSONPath)
		if err != nil {
			return "", err
		}
		mergeRuntimeTypes(&runtimeTypes, builtin)
	}

	localRuntimeTypes, err := parseRuntimeDirs(splitDirs(opts.runtimeDTSDirs))
	if err != nil {
		return "", err
	}
	mergeRuntimeTypes(&runtimeTypes, localRuntimeTypes)

	return generateTypeScriptDefinitions(app, runtimeTypes), nil
}

func readRuntimeTypes(path string) (RuntimeTypes, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return RuntimeTypes{}, fmt.Errorf("failed to read runtime JSON %s: %w", path, err)
	}

	runtimeTypes := emptyRuntimeTypes()
	if err := json.Unmarshal(data, &runtimeTypes); err != nil {
		return RuntimeTypes{}, fmt.Errorf("failed to parse runtime JSON %s: %w", path, err)
	}
	ensureRuntimeMaps(&runtimeTypes)
	return runtimeTypes, nil
}

func emptyRuntimeTypes() RuntimeTypes {
	return RuntimeTypes{
		Extensions: make(map[string]map[string]RuntimeExtensionDef),
		Structs:    make(map[string]StructDef),
	}
}

func ensureRuntimeMaps(runtimeTypes *RuntimeTypes) {
	if runtimeTypes.Extensions == nil {
		runtimeTypes.Extensions = make(map[string]map[string]RuntimeExtensionDef)
	}
	if runtimeTypes.Structs == nil {
		runtimeTypes.Structs = make(map[string]StructDef)
	}
}

func mergeRuntimeTypes(dst *RuntimeTypes, src RuntimeTypes) {
	ensureRuntimeMaps(dst)
	for name, structDef := range src.Structs {
		dst.Structs[name] = structDef
	}
	for namespace, subNamespaces := range src.Extensions {
		if dst.Extensions[namespace] == nil {
			dst.Extensions[namespace] = make(map[string]RuntimeExtensionDef)
		}
		for subNamespace, extension := range subNamespaces {
			dst.Extensions[namespace][subNamespace] = extension
		}
	}
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

func parseRuntimeDirs(dirs []string) (RuntimeTypes, error) {
	runtimeTypes := emptyRuntimeTypes()
	if len(dirs) == 0 {
		return runtimeTypes, nil
	}

	knownStructs := make(map[string]bool)
	typeAliases := make(map[string]string)
	structFields := make(map[string][]FieldDef)
	methodsByType := make(map[string][]MethodDef)
	var registeredExtensions []runtimeExtensionRef

	for _, dir := range dirs {
		err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			if info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}

			fset := token.NewFileSet()
			file, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
			if err != nil {
				return fmt.Errorf("failed to parse %s: %w", path, err)
			}

			ast.Inspect(file, func(n ast.Node) bool {
				typeSpec, ok := n.(*ast.TypeSpec)
				if !ok || !isExported(typeSpec.Name.Name) {
					return true
				}

				if _, ok := typeSpec.Type.(*ast.StructType); ok {
					knownStructs[typeSpec.Name.Name] = true
				} else {
					typeAliases[typeSpec.Name.Name] = exprToString(typeSpec.Type)
					globalTypeAliases[typeSpec.Name.Name] = exprToString(typeSpec.Type)
				}
				return true
			})

			return nil
		})
		if err != nil {
			return RuntimeTypes{}, err
		}
	}

	for _, dir := range dirs {
		err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			if info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}

			fset := token.NewFileSet()
			file, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
			if err != nil {
				return fmt.Errorf("failed to parse %s: %w", path, err)
			}

			ast.Inspect(file, func(n ast.Node) bool {
				if typeSpec, ok := n.(*ast.TypeSpec); ok && isExported(typeSpec.Name.Name) {
					if structType, ok := typeSpec.Type.(*ast.StructType); ok {
						structFields[typeSpec.Name.Name] = extractRuntimeStructFields(structType, knownStructs, typeAliases)
					}
				}

				if funcDecl, ok := n.(*ast.FuncDecl); ok {
					if funcDecl.Name.Name == "init" && funcDecl.Body != nil {
						registeredExtensions = append(registeredExtensions, extractRuntimeRegistrations(funcDecl.Body)...)
					}
					recvTypeName := receiverTypeName(funcDecl)
					if recvTypeName != "" && isExported(funcDecl.Name.Name) {
						methodsByType[recvTypeName] = append(methodsByType[recvTypeName], extractRuntimeMethod(funcDecl, knownStructs, typeAliases))
					}
				}

				return true
			})

			return nil
		})
		if err != nil {
			return RuntimeTypes{}, err
		}
	}

	referencedTypes := make(map[string]bool)
	sort.Slice(registeredExtensions, func(i, j int) bool {
		if registeredExtensions[i].namespace != registeredExtensions[j].namespace {
			return registeredExtensions[i].namespace < registeredExtensions[j].namespace
		}
		if registeredExtensions[i].subNamespace != registeredExtensions[j].subNamespace {
			return registeredExtensions[i].subNamespace < registeredExtensions[j].subNamespace
		}
		return registeredExtensions[i].methodsTypeName < registeredExtensions[j].methodsTypeName
	})

	for _, ext := range registeredExtensions {
		methods := methodsByType[ext.methodsTypeName]
		addRuntimeExtension(runtimeTypes, ext.namespace, ext.subNamespace, methods)
		for _, method := range methods {
			for _, param := range method.Params {
				collectRuntimeReferencedTypes(param.GoType, knownStructs, structFields, referencedTypes)
			}
			for _, returnType := range method.ReturnTypes {
				collectRuntimeReferencedTypes(returnType.GoType, knownStructs, structFields, referencedTypes)
			}
		}
	}

	typeNames := make([]string, 0, len(referencedTypes))
	for name := range referencedTypes {
		typeNames = append(typeNames, name)
	}
	sort.Strings(typeNames)
	for _, name := range typeNames {
		if fields, ok := structFields[name]; ok {
			runtimeTypes.Structs[name] = StructDef{Fields: fields}
		}
	}

	return runtimeTypes, nil
}

func addRuntimeExtension(runtimeTypes RuntimeTypes, namespace string, subNamespace string, methods []MethodDef) {
	if runtimeTypes.Extensions[namespace] == nil {
		runtimeTypes.Extensions[namespace] = make(map[string]RuntimeExtensionDef)
	}
	runtimeTypes.Extensions[namespace][subNamespace] = RuntimeExtensionDef{Methods: methods}
}

func receiverTypeName(funcDecl *ast.FuncDecl) string {
	if funcDecl.Recv == nil || len(funcDecl.Recv.List) == 0 {
		return ""
	}
	switch t := funcDecl.Recv.List[0].Type.(type) {
	case *ast.StarExpr:
		if ident, ok := t.X.(*ast.Ident); ok {
			return ident.Name
		}
	case *ast.Ident:
		return t.Name
	}
	return ""
}

func extractRuntimeStructFields(structType *ast.StructType, knownStructs map[string]bool, typeAliases map[string]string) []FieldDef {
	fields := []FieldDef{}
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
			// Locally-introspected runtime extension structs keep their prior
			// rendering (pointers stripped, non-optional). Optional/Nullable is
			// carried only for the framework's committed runtime types, which
			// arrive already classified via the runtime JSON (readRuntimeTypes).
			fields = append(fields, FieldDef{
				Name:   fieldName,
				GoType: goType,
				TSType: runtimeGoTypeToTS(goType, knownStructs, typeAliases, false),
			})
		}
	}
	return fields
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

func extractRuntimeMethod(funcDecl *ast.FuncDecl, knownStructs map[string]bool, typeAliases map[string]string) MethodDef {
	params := []ParamDef{}
	if funcDecl.Type.Params != nil {
		paramIndex := 0
		for _, field := range funcDecl.Type.Params.List {
			goType := exprToString(field.Type)
			tsType := runtimeGoTypeToTS(goType, knownStructs, typeAliases, true)

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
		if exprToString(results[len(results)-1].Type) == "error" {
			hasError = true
		}

		for _, result := range results {
			goType := exprToString(result.Type)
			if goType == "error" {
				continue
			}
			tsType := runtimeGoTypeToTS(goType, knownStructs, typeAliases, true)
			if len(result.Names) > 1 {
				for range result.Names {
					returnTypes = append(returnTypes, TypeDef{GoType: goType, TSType: tsType})
				}
				continue
			}
			returnTypes = append(returnTypes, TypeDef{GoType: goType, TSType: tsType})
		}
	}

	return MethodDef{
		Name:        funcDecl.Name.Name,
		Params:      params,
		ReturnTypes: returnTypes,
		HasError:    hasError,
	}
}

func runtimeGoTypeToTS(goType string, knownStructs map[string]bool, typeAliases map[string]string, qualifyKnownStructs bool) string {
	if underlying, ok := typeAliases[goType]; ok {
		return runtimeGoTypeToTS(underlying, knownStructs, typeAliases, qualifyKnownStructs)
	}
	if strings.HasPrefix(goType, "[]") {
		return runtimeGoTypeToTS(goType[2:], knownStructs, typeAliases, qualifyKnownStructs) + "[]"
	}
	if strings.HasPrefix(goType, "*") {
		return runtimeGoTypeToTS(goType[1:], knownStructs, typeAliases, qualifyKnownStructs)
	}
	if strings.HasPrefix(goType, "...") {
		return runtimeGoTypeToTS(goType[3:], knownStructs, typeAliases, qualifyKnownStructs) + "[]"
	}
	if strings.HasPrefix(goType, "map[") {
		keyType, valueType := parseMapType(goType)
		return fmt.Sprintf("Record<%s, %s>",
			runtimeGoTypeToTS(keyType, knownStructs, typeAliases, qualifyKnownStructs),
			runtimeGoTypeToTS(valueType, knownStructs, typeAliases, qualifyKnownStructs),
		)
	}
	if strings.Contains(goType, ".") {
		parts := strings.Split(goType, ".")
		goType = parts[len(parts)-1]
	}
	if knownStructs[goType] {
		if qualifyKnownStructs {
			return "StruxRuntime." + goType
		}
		return goType
	}
	return goTypeToTS(goType, nil)
}

func extractRuntimeRegistrations(body *ast.BlockStmt) []runtimeExtensionRef {
	refs := []runtimeExtensionRef{}
	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}

		namespace, subNamespace, methodsTypeName, ok := extractRuntimeRegistrationCall(call)
		if !ok || namespace == "" || subNamespace == "" || methodsTypeName == "" {
			return true
		}

		refs = append(refs, runtimeExtensionRef{
			namespace:       namespace,
			subNamespace:    subNamespace,
			methodsTypeName: methodsTypeName,
		})
		return true
	})
	return refs
}

func extractRuntimeRegistrationCall(call *ast.CallExpr) (string, string, string, bool) {
	switch runtimeCallName(call) {
	case "RegisterCustomExtension":
		if len(call.Args) != 2 {
			return "", "", "", false
		}
		return "strux", extractStringLiteral(call.Args[0]), extractRuntimeInstanceType(call.Args[1]), true
	case "RegisterExtension":
		if len(call.Args) != 3 {
			return "", "", "", false
		}
		return extractStringLiteral(call.Args[0]), extractStringLiteral(call.Args[1]), extractRuntimeInstanceType(call.Args[2]), true
	default:
		return "", "", "", false
	}
}

func runtimeCallName(call *ast.CallExpr) string {
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

func extractRuntimeInstanceType(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.UnaryExpr:
		if t.Op == token.AND {
			return extractRuntimeInstanceType(t.X)
		}
	case *ast.CompositeLit:
		return runtimeTypeName(t.Type)
	}
	return ""
}

func runtimeTypeName(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.SelectorExpr:
		return t.Sel.Name
	case *ast.StarExpr:
		return runtimeTypeName(t.X)
	default:
		return ""
	}
}

func collectRuntimeReferencedTypes(goType string, knownStructs map[string]bool, structFields map[string][]FieldDef, seen map[string]bool) {
	for _, name := range runtimeReferencedTypeNames(goType, knownStructs) {
		if seen[name] {
			continue
		}
		seen[name] = true
		for _, field := range structFields[name] {
			collectRuntimeReferencedTypes(field.GoType, knownStructs, structFields, seen)
		}
	}
}

func runtimeReferencedTypeNames(goType string, knownStructs map[string]bool) []string {
	switch {
	case strings.HasPrefix(goType, "[]"):
		return runtimeReferencedTypeNames(goType[2:], knownStructs)
	case strings.HasPrefix(goType, "*"):
		return runtimeReferencedTypeNames(goType[1:], knownStructs)
	case strings.HasPrefix(goType, "..."):
		return runtimeReferencedTypeNames(goType[3:], knownStructs)
	case strings.HasPrefix(goType, "map["):
		keyType, valueType := parseMapType(goType)
		names := runtimeReferencedTypeNames(keyType, knownStructs)
		names = append(names, runtimeReferencedTypeNames(valueType, knownStructs)...)
		return names
	case strings.Contains(goType, "."):
		parts := strings.Split(goType, ".")
		goType = parts[len(parts)-1]
	}
	if knownStructs[goType] {
		return []string{goType}
	}
	return nil
}

func generateTypeScriptDefinitions(introspection IntrospectionOutput, runtimeTypes RuntimeTypes) string {
	lines := []string{
		"// Auto-generated Strux type definitions",
		"// Run 'strux types' to regenerate from Go code",
		"// This file is automatically generated. DO NOT EDIT",
		"",
		"declare global {",
	}

	globalLines := generateRuntimeGlobalLines(runtimeTypes)
	if len(globalLines) > 0 {
		for _, line := range globalLines {
			lines = append(lines, indentLine(line))
		}
		lines = append(lines, "")
	}

	for _, line := range generateAppGlobalLines(introspection) {
		lines = append(lines, indentLine(line))
	}

	lines = append(lines, "}", "", "export {};")
	return strings.Join(lines, "\n")
}

func generateRuntimeGlobalLines(runtimeTypes RuntimeTypes) []string {
	lines := []string{}

	if len(runtimeTypes.Structs) > 0 {
		lines = append(lines, "namespace StruxRuntime {")
		typeNames := make([]string, 0, len(runtimeTypes.Structs))
		for name := range runtimeTypes.Structs {
			typeNames = append(typeNames, name)
		}
		sort.Strings(typeNames)
		for typeIndex, name := range typeNames {
			if typeIndex > 0 {
				lines = append(lines, "")
			}
			lines = append(lines, fmt.Sprintf("  interface %s {", name))
			for _, field := range runtimeTypes.Structs[name].Fields {
				lines = append(lines, fmt.Sprintf("    %s;", formatFieldDTS(field)))
			}
			lines = append(lines, "  }")
		}
		lines = append(lines, "}", "")
	}

	namespaceNames := make([]string, 0, len(runtimeTypes.Extensions))
	for namespace := range runtimeTypes.Extensions {
		namespaceNames = append(namespaceNames, namespace)
	}
	sort.Strings(namespaceNames)

	for namespaceIndex, namespace := range namespaceNames {
		if namespaceIndex > 0 {
			lines = append(lines, "")
		}
		interfaceName := strings.ToUpper(namespace[:1]) + namespace[1:]
		lines = append(lines, fmt.Sprintf("interface %s {", interfaceName))

		subNamespaceNames := make([]string, 0, len(runtimeTypes.Extensions[namespace]))
		for subNamespace := range runtimeTypes.Extensions[namespace] {
			subNamespaceNames = append(subNamespaceNames, subNamespace)
		}
		sort.Strings(subNamespaceNames)

		for _, subNamespace := range subNamespaceNames {
			extension := runtimeTypes.Extensions[namespace][subNamespace]
			lines = append(lines, fmt.Sprintf("  %s: {", subNamespace))
			for _, method := range extension.Methods {
				lines = append(lines, fmt.Sprintf("    %s(%s): %s;", method.Name, formatDTSParams(method.Params), formatDTSReturnType(method)))
			}
			lines = append(lines, "  };")
		}

		if namespace == "strux" {
			lines = append(lines, "  ipc: {")
			lines = append(lines, "    on(event: string, callback: (data: any) => void): () => void;")
			lines = append(lines, "    off(event: string, callback: (data: any) => void): void;")
			lines = append(lines, "    send(event: string, data?: any): void;")
			lines = append(lines, "  };")
		}

		lines = append(lines, "}")
	}

	return lines
}

func generateAppGlobalLines(introspection IntrospectionOutput) []string {
	lines := []string{}
	app := introspection.App
	structs := introspection.Structs

	for _, structName := range findUsedStructs(app, structs) {
		structDef, ok := structs[structName]
		if !ok {
			continue
		}
		if len(lines) > 0 && lines[len(lines)-1] != "" {
			lines = append(lines, "")
		}
		lines = append(lines, fmt.Sprintf("interface %s {", structName))
		for _, field := range structDef.Fields {
			lines = append(lines, fmt.Sprintf("  %s;", formatFieldDTS(field)))
		}
		if len(structDef.Fields) > 0 && len(structDef.Methods) > 0 {
			lines = append(lines, "")
		}
		for _, method := range structDef.Methods {
			lines = append(lines, fmt.Sprintf("  %s(%s): %s;", method.Name, formatDTSParams(method.Params), formatDTSReturnType(method)))
		}
		lines = append(lines, "}")
	}

	if len(lines) > 0 && lines[len(lines)-1] != "" {
		lines = append(lines, "")
	}

	lines = append(lines, fmt.Sprintf("interface %s {", app.Name))
	for _, field := range app.Fields {
		lines = append(lines, fmt.Sprintf("  %s;", formatFieldDTS(field)))
	}
	if len(app.Fields) > 0 && len(app.Methods) > 0 {
		lines = append(lines, "")
	}
	for _, method := range app.Methods {
		lines = append(lines, fmt.Sprintf("  %s(%s): %s;", method.Name, formatDTSParams(method.Params), formatDTSReturnType(method)))
	}
	lines = append(lines, "}", "")
	lines = append(lines, fmt.Sprintf("const %s: %s;", app.Name, app.Name))
	lines = append(lines, "")
	lines = append(lines, "const strux: Strux;")
	lines = append(lines, "interface Window {")
	lines = append(lines, "  strux: Strux;")
	lines = append(lines, fmt.Sprintf("  %s: %s;", app.Name, app.Name))
	lines = append(lines, "  go: {")
	lines = append(lines, fmt.Sprintf("    %s: {", app.PackageName))
	lines = append(lines, fmt.Sprintf("      %s: %s;", app.Name, app.Name))
	lines = append(lines, "    }")
	lines = append(lines, "  }")
	lines = append(lines, "}")

	return lines
}

func indentLine(line string) string {
	if line == "" {
		return ""
	}
	return "  " + line
}

func formatDTSParams(params []ParamDef) string {
	parts := make([]string, 0, len(params))
	for index, param := range params {
		name := param.Name
		if name == "" {
			name = fmt.Sprintf("arg%d", index)
		}
		parts = append(parts, fmt.Sprintf("%s: %s", name, param.TSType))
	}
	return strings.Join(parts, ", ")
}

func formatDTSReturnType(method MethodDef) string {
	baseType := "void"
	if len(method.ReturnTypes) == 1 {
		baseType = method.ReturnTypes[0].TSType
	} else if len(method.ReturnTypes) > 1 {
		parts := make([]string, 0, len(method.ReturnTypes))
		for _, returnType := range method.ReturnTypes {
			parts = append(parts, returnType.TSType)
		}
		baseType = "[" + strings.Join(parts, ", ") + "]"
	}
	if method.HasError && len(method.ReturnTypes) > 0 {
		baseType += " | null"
	}
	return fmt.Sprintf("Promise<%s>", baseType)
}

func findUsedStructs(app AppInfo, structs map[string]StructDef) []string {
	used := make(map[string]bool)
	knownStructs := make(map[string]bool)
	for name := range structs {
		knownStructs[name] = true
	}

	for _, field := range app.Fields {
		addUsedStructs(field.TSType, knownStructs, used)
	}
	for _, method := range app.Methods {
		for _, param := range method.Params {
			addUsedStructs(param.TSType, knownStructs, used)
		}
		for _, returnType := range method.ReturnTypes {
			addUsedStructs(returnType.TSType, knownStructs, used)
		}
	}
	for name, structDef := range structs {
		if len(structDef.Methods) > 0 {
			used[name] = true
		}
	}

	names := make([]string, 0, len(used))
	for name := range used {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func addUsedStructs(tsType string, knownStructs map[string]bool, used map[string]bool) {
	tsType = strings.TrimSuffix(tsType, "[]")
	if knownStructs[tsType] {
		used[tsType] = true
	}
}

// runtimeImportPath is the import path for the strux runtime package
const runtimeImportPath = "github.com/strux-dev/strux/pkg/runtime"

// globalTypeAliases maps named types to their underlying primitive type (e.g., "AudioOutput" -> "string").
// Populated during AST parsing and used by goTypeToTS to resolve non-struct named types.
var globalTypeAliases = make(map[string]string)

// findRuntimeStartStruct finds the struct type passed to runtime.Start() by:
// 1. Finding the import alias for the strux runtime package
// 2. Finding the call to <alias>.Start(arg)
// 3. Resolving the argument to a struct type name
func findRuntimeStartStruct(files []*ast.File) string {
	for _, file := range files {
		// Find the import alias for the runtime package
		runtimeAlias := ""
		for _, imp := range file.Imports {
			importPath := strings.Trim(imp.Path.Value, `"`)
			if importPath == runtimeImportPath {
				if imp.Name != nil {
					runtimeAlias = imp.Name.Name
				} else {
					// Default alias is the last path segment
					parts := strings.Split(importPath, "/")
					runtimeAlias = parts[len(parts)-1]
				}
				break
			}
		}

		if runtimeAlias == "" {
			continue
		}

		// Build a map of variable names to their types within function bodies
		// e.g., app := &App{} -> "app" maps to "App"
		var appStructName string

		ast.Inspect(file, func(n ast.Node) bool {
			if appStructName != "" {
				return false
			}

			funcDecl, ok := n.(*ast.FuncDecl)
			if !ok {
				return true
			}

			// Build variable type map for this function
			varTypes := make(map[string]string)

			ast.Inspect(funcDecl.Body, func(n ast.Node) bool {
				if appStructName != "" {
					return false
				}

				// Track variable assignments: app := &App{} or var app = &App{}
				if assignStmt, ok := n.(*ast.AssignStmt); ok {
					for i, lhs := range assignStmt.Lhs {
						if ident, ok := lhs.(*ast.Ident); ok && i < len(assignStmt.Rhs) {
							if typeName := resolveStructType(assignStmt.Rhs[i]); typeName != "" {
								varTypes[ident.Name] = typeName
							}
						}
					}
				}

				// Find calls to runtime.Start(...)
				callExpr, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}

				selExpr, ok := callExpr.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}

				ident, ok := selExpr.X.(*ast.Ident)
				if !ok {
					return true
				}

				if ident.Name == runtimeAlias && (selExpr.Sel.Name == "Start" || selExpr.Sel.Name == "Init") && len(callExpr.Args) >= 1 {
					arg := callExpr.Args[0]

					// Case 1: runtime.Start(&App{...}) - direct composite literal
					if typeName := resolveStructType(arg); typeName != "" {
						appStructName = typeName
						return false
					}

					// Case 2: runtime.Start(app) - variable reference
					if argIdent, ok := arg.(*ast.Ident); ok {
						if typeName, exists := varTypes[argIdent.Name]; exists {
							appStructName = typeName
							return false
						}
					}
				}

				return true
			})

			return appStructName == ""
		})

		if appStructName != "" {
			return appStructName
		}
	}

	return ""
}

// resolveStructType extracts the struct type name from an expression.
// Handles: &App{}, App{}, &App, new(App)
func resolveStructType(expr ast.Expr) string {
	switch e := expr.(type) {
	case *ast.UnaryExpr:
		// &App{} or &app
		if e.Op.String() == "&" {
			return resolveStructType(e.X)
		}
	case *ast.CompositeLit:
		// App{...}
		return identFromExpr(e.Type)
	case *ast.CallExpr:
		// new(App)
		if ident, ok := e.Fun.(*ast.Ident); ok && ident.Name == "new" && len(e.Args) == 1 {
			return identFromExpr(e.Args[0])
		}
	}
	return ""
}

// identFromExpr extracts an identifier name from an expression.
// Handles *ast.Ident and *ast.StarExpr (pointer types).
func identFromExpr(expr ast.Expr) string {
	switch e := expr.(type) {
	case *ast.Ident:
		return e.Name
	case *ast.StarExpr:
		if ident, ok := e.X.(*ast.Ident); ok {
			return ident.Name
		}
	}
	return ""
}

// collectImports extracts import alias -> path mappings from a Go file
func collectImports(file *ast.File, importMap map[string]string) {
	for _, imp := range file.Imports {
		importPath := strings.Trim(imp.Path.Value, `"`)
		var alias string
		if imp.Name != nil {
			alias = imp.Name.Name
		} else {
			parts := strings.Split(importPath, "/")
			alias = parts[len(parts)-1]
		}
		importMap[alias] = importPath
	}
}

// stripTypeWrappers removes pointer, slice, and variadic prefixes from a Go type string
func stripTypeWrappers(goType string) string {
	s := goType
	for strings.HasPrefix(s, "*") || strings.HasPrefix(s, "[]") || strings.HasPrefix(s, "...") {
		if strings.HasPrefix(s, "*") {
			s = s[1:]
		} else if strings.HasPrefix(s, "[]") {
			s = s[2:]
		} else if strings.HasPrefix(s, "...") {
			s = s[3:]
		}
	}
	return s
}

// extractQualifiedType returns the qualified type from a Go type string, or empty string if not qualified
func extractQualifiedType(goType string) string {
	stripped := stripTypeWrappers(goType)
	if strings.Contains(stripped, ".") && !strings.HasPrefix(stripped, "map[") {
		return stripped
	}
	return ""
}

// collectQualifiedTypes finds all qualified type references (e.g., "security.TorStatus")
// in app fields and methods
func collectQualifiedTypes(fields []FieldDef, methods []MethodDef) []string {
	seen := make(map[string]bool)
	var result []string

	collect := func(goType string) {
		if qt := extractQualifiedType(goType); qt != "" && !seen[qt] {
			seen[qt] = true
			result = append(result, qt)
		}
	}

	for _, f := range fields {
		collect(f.GoType)
	}
	for _, m := range methods {
		for _, p := range m.Params {
			collect(p.GoType)
		}
		for _, rt := range m.ReturnTypes {
			collect(rt.GoType)
		}
	}

	return result
}

// collectQualifiedTypesFromFields finds qualified type references in struct fields
func collectQualifiedTypesFromFields(fields []FieldDef) []string {
	seen := make(map[string]bool)
	var result []string
	for _, f := range fields {
		if qt := extractQualifiedType(f.GoType); qt != "" && !seen[qt] {
			seen[qt] = true
			result = append(result, qt)
		}
	}
	return result
}

// resolveExternalPackage parses an external Go package and extracts the requested struct definitions.
// It uses `go list -json` to find the package directory, then parses the source files.
// Same-package struct dependencies are transitively included (e.g., if Circuit references Connection,
// both are returned). Returns the resolved structs and the package's own import map (for recursive resolution).
func resolveExternalPackage(projectDir string, importPath string, typeNames []string, existingStructs map[string]bool) (map[string][]FieldDef, map[string][]MethodDef, map[string]string) {
	result := make(map[string][]FieldDef)
	resultMethods := make(map[string][]MethodDef)
	extImports := make(map[string]string)

	// Use `go list -json` to find the package directory
	cmd := exec.Command("go", "list", "-json", importPath)
	cmd.Dir = projectDir
	output, err := cmd.Output()
	if err != nil {
		return result, resultMethods, extImports
	}

	// Extract "Dir" from the JSON output
	var pkgInfo struct {
		Dir string `json:"Dir"`
	}
	if err := json.Unmarshal(output, &pkgInfo); err != nil || pkgInfo.Dir == "" {
		return result, resultMethods, extImports
	}

	// Parse the external package directory
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, pkgInfo.Dir, nil, 0)
	if err != nil {
		return result, resultMethods, extImports
	}

	// Discover all struct types and collect imports from this package
	extKnownStructs := make(map[string]bool)
	for k, v := range existingStructs {
		extKnownStructs[k] = v
	}

	// allStructFields stores every struct's fields in this package for dependency walking
	allStructFields := make(map[string][]FieldDef)
	allStructMethods := make(map[string][]MethodDef)

	for _, pkg := range pkgs {
		for _, file := range pkg.Files {
			collectImports(file, extImports)
			ast.Inspect(file, func(n ast.Node) bool {
				// Collect struct type definitions
				if typeSpec, ok := n.(*ast.TypeSpec); ok {
					if structType, ok := typeSpec.Type.(*ast.StructType); ok {
						structName := typeSpec.Name.Name
						extKnownStructs[structName] = true

						var fields []FieldDef
						for _, field := range structType.Fields.List {
							if len(field.Names) > 0 {
								fieldName := field.Names[0].Name
								if isExported(fieldName) {
									goType := exprToString(field.Type)
									fields = append(fields, FieldDef{
										Name:   fieldName,
										GoType: goType,
										TSType: goTypeToTS(goType, extKnownStructs),
									})
								}
							}
						}
						allStructFields[structName] = fields
					} else {
						// Track non-struct type aliases in external packages
						underlying := exprToString(typeSpec.Type)
						globalTypeAliases[typeSpec.Name.Name] = underlying
					}
				}

				// Collect methods on structs
				if funcDecl, ok := n.(*ast.FuncDecl); ok {
					if funcDecl.Recv != nil && len(funcDecl.Recv.List) > 0 {
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
						if recvTypeName != "" && isExported(funcDecl.Name.Name) {
							method := extractMethod(funcDecl, extKnownStructs)
							allStructMethods[recvTypeName] = append(allStructMethods[recvTypeName], method)
						}
					}
				}

				return true
			})
		}
	}

	// Transitively collect all same-package struct dependencies starting from the requested types
	needed := make(map[string]bool)
	queue := make([]string, len(typeNames))
	copy(queue, typeNames)
	for _, name := range typeNames {
		needed[name] = true
	}

	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]

		fields, ok := allStructFields[current]
		if !ok {
			continue
		}

		for _, f := range fields {
			// Check for same-package unqualified struct references
			baseType := stripTypeWrappers(f.GoType)
			if extKnownStructs[baseType] && !needed[baseType] {
				needed[baseType] = true
				queue = append(queue, baseType)
			}
		}
	}

	// Collect all needed structs into the result
	for name := range needed {
		if fields, ok := allStructFields[name]; ok {
			result[name] = fields
		}
		if methods, ok := allStructMethods[name]; ok {
			resultMethods[name] = methods
		}
	}

	return result, resultMethods, extImports
}

// goTypeToTSWithQualified converts Go types to TypeScript, handling qualified names
// like "security.TorStatus" by mapping them to their unqualified TS interface name
func goTypeToTSWithQualified(goType string, knownStructs map[string]bool, qualifiedToTS map[string]string) string {
	// Check for direct qualified match
	if tsName, ok := qualifiedToTS[goType]; ok {
		return tsName
	}

	// Handle wrappers
	if strings.HasPrefix(goType, "[]") {
		elemType := goTypeToTSWithQualified(goType[2:], knownStructs, qualifiedToTS)
		return elemType + "[]"
	}
	if strings.HasPrefix(goType, "*") {
		return goTypeToTSWithQualified(goType[1:], knownStructs, qualifiedToTS)
	}
	if strings.HasPrefix(goType, "...") {
		elemType := goTypeToTSWithQualified(goType[3:], knownStructs, qualifiedToTS)
		return elemType + "[]"
	}
	if strings.HasPrefix(goType, "map[") {
		keyType, valueType := parseMapType(goType)
		tsKey := goTypeToTSWithQualified(keyType, knownStructs, qualifiedToTS)
		tsValue := goTypeToTSWithQualified(valueType, knownStructs, qualifiedToTS)
		return fmt.Sprintf("Record<%s, %s>", tsKey, tsValue)
	}

	// Fall back to standard conversion
	return goTypeToTS(goType, knownStructs)
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
		// Resolve named type aliases to their underlying type (e.g., AudioOutput -> string)
		if underlying, ok := globalTypeAliases[goType]; ok {
			return goTypeToTS(underlying, knownStructs)
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
