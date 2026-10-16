import type { Node } from "web-tree-sitter";
import type { LanguageRules } from "./languages.ts";

export interface Symbol {
  kind: string;
  name: string;
  /** One-based inclusive source lines covering the whole declaration. */
  startLine: number;
  endLine: number;
  /**
   * One-based position of the declared name itself. A language server wants the
   * cursor on the identifier, not on a leading `export` or modifier list.
   * Columns are UTF-16 code units, as the protocol requires.
   */
  nameLine: number;
  nameColumn: number;
  children: Symbol[];
}

const MAX_NAME = 80;
const MAX_SYMBOLS = 2_000;
const MAX_NODES = 200_000;

/**
 * Kinds that describe a value rather than structure. A module level value is
 * part of the module's surface. A local inside a function, or one field among
 * twenty in a record type, is detail that an outline should leave for `read`.
 * `includeMembers` asks for them anyway.
 */
const VALUE_KINDS = new Set(["const", "var", "field", "property"]);
/** Kinds whose body is a function scope. */
const CALLABLE_KINDS = new Set(["function", "method", "def", "fn", "constructor",
  "abstract method", "annotation"]);

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > MAX_NAME ? `${flat.slice(0, MAX_NAME - 1)}…` : flat;
}

/** Descend a C-style declarator chain to the declared identifier. */
function declaratorName(node: Node): Node | undefined {
  let current: Node | null = node.childForFieldName("declarator");
  for (let depth = 0; current && depth < 8; depth++) {
    if (current.type === "identifier" || current.type === "field_identifier"
      || current.type === "qualified_identifier" || current.type === "type_identifier"
      || current.type === "operator_name" || current.type === "destructor_name") return current;
    const next: Node | null = current.childForFieldName("declarator") ?? current.childForFieldName("name");
    if (!next) {
      // A typedef or variable declaration carries its name in a sibling field.
      return current.namedChildren.find(child => child?.type === "identifier" || child?.type === "type_identifier") ?? undefined;
    }
    current = next;
  }
  return undefined;
}

/** Label an impl block from the types it names, as `Trait for Type`. */
function typeLabel(node: Node): { text: string; at: Node } | undefined {
  const trait = node.childForFieldName("trait"), type = node.childForFieldName("type");
  if (trait && type) return { text: `${trait.text} for ${type.text}`, at: type };
  const only = type ?? trait;
  return only ? { text: only.text, at: only } : undefined;
}

/** True when a C-style declarator chain declares a function. */
function declaresFunction(node: Node): boolean {
  let current: Node | null = node.childForFieldName("declarator");
  for (let depth = 0; current && depth < 8; depth++) {
    if (current.type === "function_declarator") return true;
    current = current.childForFieldName("declarator");
  }
  return false;
}

function kindOf(node: Node, rules: LanguageRules): string | undefined {
  const kind = rules.declarations[node.type];
  if (kind === undefined) return undefined;
  const data = rules.dataKinds?.[node.type];
  return data !== undefined && !declaresFunction(node) ? data : kind;
}

function nameOf(node: Node, rules: LanguageRules): { text: string; at: Node } | undefined {
  if (rules.typeLabelled?.has(node.type)) return typeLabel(node);
  const field = node.childForFieldName("name");
  if (field) return { text: field.text, at: field };
  if (rules.declarator?.has(node.type)) {
    const declared = declaratorName(node);
    return declared ? { text: declared.text, at: declared } : undefined;
  }
  // Java fields hold a declarator directly; C# adds a variable declaration.
  const variables = node.namedChildren.find(child => child?.type === "variable_declaration");
  const declarator = (variables ?? node).namedChildren.find(child => child?.type === "variable_declarator");
  const named = declarator?.childForFieldName("name");
  return named ? { text: named.text, at: named } : undefined;
}

/**
 * Walk a tree into a symbol outline.
 *
 * The walk emits a symbol for a declaration type in the language table, then
 * continues into container bodies for nested members. A transparent wrapper,
 * such as a TypeScript `export` statement or a Python decorator, contributes no
 * symbol of its own but does not hide what it wraps.
 */
export function outlineOf(root: Node, rules: LanguageRules,
  options: { includeMembers?: boolean } = {}): { symbols: Symbol[]; truncated: boolean } {
  const symbols: Symbol[] = [];
  let count = 0;
  let truncated = false;

  function visit(node: Node, into: Symbol[], depth: number, inCallable: boolean, nested: boolean): void {
    if (truncated || depth > 24) return;
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (count >= MAX_SYMBOLS) { truncated = true; return; }
      const kind = kindOf(child, rules);
      // A local inside a function body is never an outline symbol. includeMembers
      // only governs members of a class, interface, struct or record.
      const hideValue = kind !== undefined && VALUE_KINDS.has(kind)
        && (inCallable || (nested && !options.includeMembers));
      if (kind && !hideValue) {
        const name = nameOf(child, rules);
        // A declaration with no recoverable name is an anonymous expression,
        // not an outline entry; its body can still hold named members.
        if (name) {
          const symbol: Symbol = { kind, name: clip(name.text), startLine: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1, nameLine: name.at.startPosition.row + 1,
            nameColumn: name.at.startPosition.column + 1, children: [] };
          into.push(symbol);
          count++;
          visit(child, symbol.children, depth + 1, inCallable || CALLABLE_KINDS.has(kind), true);
          continue;
        }
      }
      if (rules.transparent.has(child.type) || rules.containers.has(child.type)) {
        visit(child, into, depth + 1, inCallable, nested);
        continue;
      }
      // Keep scanning the children of an unlabelled node so that a declaration
      // nested in a block or an expression is still found.
      if (child.namedChildCount && !kind) visit(child, into, depth + 1, inCallable, nested);
    }
  }

  visit(root, symbols, 0, false, false);
  return { symbols, truncated };
}

/** Find the innermost symbol that contains a one-based line. */
export function enclosing(symbols: readonly Symbol[], line: number): Symbol[] {
  for (const symbol of symbols) {
    if (line < symbol.startLine || line > symbol.endLine) continue;
    return [symbol, ...enclosing(symbol.children, line)];
  }
  return [];
}

function matchPath(symbols: readonly Symbol[], parts: readonly string[]): Symbol[] {
  const matches: Symbol[] = [];
  const walk = (list: readonly Symbol[], trail: readonly string[]): void => {
    for (const symbol of list) {
      // C++ out-of-class definitions name their owner in one tree-sitter node.
      const next = [...trail, ...symbol.name.split("::")];
      // A path matches when the requested parts are the trail's final segments.
      if (next.length >= parts.length && parts.every((part, index) => next[next.length - parts.length + index] === part)) {
        matches.push(symbol);
      }
      walk(symbol.children, next);
    }
  };
  walk(symbols, []);
  return matches;
}

/**
 * Resolve a symbol by name, or by `Owner/member`, `Owner.member`, or
 * `Owner::member` path.
 *
 * Languages disagree about whether a method nests under its type. A Go method
 * is declared at file scope with a receiver, so `Store/Load` has no path even
 * though it is the obvious way to ask. When a path finds nothing, the final
 * segment is tried alone, but only when it is unambiguous: guessing between
 * several same-named members would be worse than reporting the miss.
 */
export function findSymbol(symbols: readonly Symbol[], query: string): Symbol[] {
  const parts = query.split(/::|[/.]/u).filter(part => part.length > 0);
  if (!parts.length) return [];
  const matches = matchPath(symbols, parts);
  if (matches.length || parts.length === 1) return matches;
  const leaf = matchPath(symbols, parts.slice(-1));
  return leaf.length === 1 ? leaf : [];
}

/**
 * The first place a name is written as an identifier in this file.
 *
 * A language server resolves whatever the cursor sits on, so a use serves as
 * well as a declaration. Asking for a definition of a name the file only
 * imports is the ordinary editor gesture, and the declaration outline cannot
 * answer it. Walking the tree rather than matching text keeps the hit off
 * comments and string literals, where no server would resolve anything.
 */
export function occurrenceOf(root: Node, name: string): { line: number; column: number } | undefined {
  if (!name) return undefined;
  const stack: Node[] = [root];
  let best: { line: number; column: number } | undefined;
  let visited = 0;
  while (stack.length) {
    const node = stack.pop()!;
    if (++visited > MAX_NODES) break;
    if (node.childCount === 0) {
      if (node.type.endsWith("identifier") && node.text === name) {
        const at = { line: node.startPosition.row + 1, column: node.startPosition.column + 1 };
        if (!best || at.line < best.line || (at.line === best.line && at.column < best.column)) best = at;
      }
      continue;
    }
    for (let index = node.childCount - 1; index >= 0; index -= 1) {
      const child = node.child(index);
      if (child) stack.push(child);
    }
  }
  return best;
}
