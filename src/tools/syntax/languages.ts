/**
 * Language table for the syntax layer.
 *
 * Each entry names the grammar to load and the node types that matter for an
 * outline. The walk reads a declaration's `name` field when it has one, so this
 * table stays close to the grammar instead of encoding query strings. Node type
 * names come from the shipped grammars; see tests/outline.test.ts for coverage.
 */
export interface LanguageRules {
  /** Grammar basename inside the wasm bundle, without the tree-sitter- prefix. */
  grammar: string;
  /** Node type to kind label. A type absent here is not an outline symbol. */
  declarations: Record<string, string>;
  /** Wrappers to descend through without emitting a symbol of their own. */
  transparent: ReadonlySet<string>;
  /** Types whose named children can hold further symbols. */
  containers: ReadonlySet<string>;
  /** Declaration types whose name sits under a C-style declarator chain. */
  declarator?: ReadonlySet<string>;
  /** Label to use when a C-style declarator declares data rather than a function. */
  dataKinds?: Record<string, string>;
  /** Declaration types labelled from their type children instead of a name. */
  typeLabelled?: ReadonlySet<string>;
}

const TS_DECLARATIONS: Record<string, string> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  abstract_class_declaration: "abstract class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
  internal_module: "namespace",
  module: "namespace",
  method_definition: "method",
  abstract_method_signature: "abstract method",
  method_signature: "method",
  property_signature: "property",
  public_field_definition: "field",
  variable_declarator: "const",
};

const TS_CONTAINERS = new Set(["class_body", "interface_body", "object_type", "enum_body", "statement_block"]);
const TS_TRANSPARENT = new Set(["export_statement", "lexical_declaration", "variable_declaration",
  "ambient_declaration", "expression_statement", "declaration"]);

const LANGUAGES: Record<string, LanguageRules> = {
  typescript: {
    grammar: "typescript",
    declarations: TS_DECLARATIONS,
    transparent: TS_TRANSPARENT,
    containers: TS_CONTAINERS,
  },
  tsx: {
    grammar: "tsx",
    declarations: TS_DECLARATIONS,
    transparent: TS_TRANSPARENT,
    containers: TS_CONTAINERS,
  },
  javascript: {
    grammar: "javascript",
    declarations: {
      function_declaration: "function",
      generator_function_declaration: "function",
      class_declaration: "class",
      method_definition: "method",
      field_definition: "field",
      variable_declarator: "const",
    },
    transparent: TS_TRANSPARENT,
    containers: TS_CONTAINERS,
  },
  python: {
    grammar: "python",
    declarations: { function_definition: "def", class_definition: "class" },
    transparent: new Set(["decorated_definition"]),
    containers: new Set(["block"]),
  },
  go: {
    grammar: "go",
    declarations: {
      function_declaration: "func",
      method_declaration: "method",
      type_spec: "type",
      const_spec: "const",
      var_spec: "var",
    },
    transparent: new Set(["type_declaration", "const_declaration", "var_declaration"]),
    containers: new Set([]),
  },
  rust: {
    grammar: "rust",
    declarations: {
      function_item: "fn",
      function_signature_item: "fn",
      struct_item: "struct",
      enum_item: "enum",
      union_item: "union",
      trait_item: "trait",
      impl_item: "impl",
      mod_item: "mod",
      type_item: "type",
      const_item: "const",
      static_item: "static",
      macro_definition: "macro",
    },
    transparent: new Set([]),
    containers: new Set(["declaration_list"]),
    typeLabelled: new Set(["impl_item"]),
  },
  java: {
    grammar: "java",
    declarations: {
      class_declaration: "class",
      interface_declaration: "interface",
      enum_declaration: "enum",
      record_declaration: "record",
      annotation_type_declaration: "annotation",
      method_declaration: "method",
      constructor_declaration: "constructor",
      field_declaration: "field",
    },
    transparent: new Set([]),
    containers: new Set(["class_body", "interface_body", "enum_body", "annotation_type_body"]),
  },
  csharp: {
    grammar: "c-sharp",
    declarations: {
      namespace_declaration: "namespace",
      class_declaration: "class",
      struct_declaration: "struct",
      interface_declaration: "interface",
      record_declaration: "record",
      enum_declaration: "enum",
      delegate_declaration: "delegate",
      method_declaration: "method",
      constructor_declaration: "constructor",
      property_declaration: "property",
      field_declaration: "field",
    },
    transparent: new Set([]),
    containers: new Set(["declaration_list"]),
  },
  cpp: {
    grammar: "cpp",
    declarations: {
      function_definition: "function",
      declaration: "function",
      field_declaration: "method",
      class_specifier: "class",
      struct_specifier: "struct",
      union_specifier: "union",
      enum_specifier: "enum",
      namespace_definition: "namespace",
      type_definition: "typedef",
      alias_declaration: "using",
    },
    transparent: new Set(["template_declaration", "linkage_specification"]),
    containers: new Set(["declaration_list", "field_declaration_list"]),
    declarator: new Set(["function_definition", "declaration", "field_declaration", "type_definition"]),
    // A C declaration is a function or a variable depending on its declarator.
    dataKinds: { declaration: "var", field_declaration: "field" },
  },
  bash: {
    grammar: "bash",
    declarations: { function_definition: "function" },
    transparent: new Set([]),
    containers: new Set([]),
  },
};

/**
 * Extension to language. C and C++ headers share the C++ grammar: it accepts C
 * for outline purposes, which keeps the bundle to one grammar per family.
 */
const EXTENSIONS: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx", jsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
  cs: "csharp",
  c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  sh: "bash", bash: "bash",
};

export function languageFor(path: string): { id: string; rules: LanguageRules } | undefined {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const id = EXTENSIONS[extension];
  const rules = id ? LANGUAGES[id] : undefined;
  return id && rules ? { id, rules } : undefined;
}
