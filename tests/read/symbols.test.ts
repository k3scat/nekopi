import { expect, test } from "bun:test";
import { parseSource, isParsed } from "../../src/tools/syntax/parser.ts";
import { enclosing, findSymbol, occurrenceOf, outlineOf, type Symbol } from "../../src/tools/syntax/symbols.ts";
import { languageFor } from "../../src/tools/syntax/languages.ts";

/** Flatten to "kind name" pairs so a test states structure, not formatting. */
function shape(symbols: readonly Symbol[]): string[] {
  return symbols.flatMap(symbol => [`${symbol.kind} ${symbol.name}`,
    ...shape(symbol.children).map(child => `  ${child}`)]);
}

async function symbolsOf(path: string, source: string) {
  const parsed = await parseSource(path, source);
  if (!isParsed(parsed)) throw new Error(`Expected a tree for ${path}: ${parsed.detail}`);
  try {
    return outlineOf(parsed.tree.rootNode, parsed.rules, {}).symbols;
  } finally {
    parsed.tree.delete();
  }
}

test("every mapped extension resolves to a grammar that loads", async () => {
  for (const extension of ["ts", "tsx", "js", "py", "go", "rs", "java", "cs", "c", "cpp", "sh"]) {
    const language = languageFor(`a.${extension}`);
    expect(language).toBeDefined();
    const parsed = await parseSource(`a.${extension}`, "");
    expect(isParsed(parsed)).toBe(true);
    if (isParsed(parsed)) parsed.tree.delete();
  }
});

test("TypeScript declarations keep their kind, name and whole-declaration range", async () => {
  const source = [
    'import { x } from "y";',
    'export const VERSION = "1";',
    "export interface Loader { load(id: string): Promise<void>; }",
    'export type Mode = "a" | "b";',
    "export enum Kind { One, Two }",
    "export function parse(input: string): number { return 1; }",
    "export default class Store implements Loader {",
    "  private cache = new Map<string, number>();",
    "  async load(id: string) { return; }",
    "}",
    "abstract class Base { abstract run(): void; }",
  ].join("\n") + "\n";
  const symbols = await symbolsOf("a.ts", source);
  expect(shape(symbols)).toEqual([
    "const VERSION",
    "interface Loader",
    "  method load",
    "type Mode",
    "enum Kind",
    "function parse",
    "class Store",
    "  method load",
    "abstract class Base",
    "  abstract method run",
  ]);
  const store = symbols.find(symbol => symbol.name === "Store")!;
  expect([store.startLine, store.endLine]).toEqual([7, 10]);
});

test("a local inside a function is never a symbol, and a member needs includeMembers", async () => {
  const source = [
    "export const top = 1;",
    "export function outer() {",
    "  const local = 2;",
    "  function inner() { const deeper = 3; return deeper; }",
    "  return inner() + local;",
    "}",
    "export class Store { private cache = 1; run() { const scoped = 4; return scoped; } }",
  ].join("\n") + "\n";
  expect(shape(await symbolsOf("a.ts", source))).toEqual([
    "const top", "function outer", "  function inner", "class Store", "  method run",
  ]);
  const parsed = await parseSource("a.ts", source);
  if (!isParsed(parsed)) throw new Error("Expected a tree.");
  try {
    // includeMembers reveals class members; it never reveals function locals.
    expect(shape(outlineOf(parsed.tree.rootNode, parsed.rules, { includeMembers: true }).symbols)).toEqual([
      "const top", "function outer", "  function inner", "class Store", "  field cache", "  method run",
    ]);
  } finally {
    parsed.tree.delete();
  }
});

test("Python keeps decorated definitions and nested methods", async () => {
  const source = [
    "VERSION = 1",
    "def parse(value):",
    "    return value",
    "@decorator",
    "def decorated(x): pass",
    "class Store(Base):",
    "    def __init__(self): pass",
    "    @property",
    "    def size(self): return 0",
  ].join("\n") + "\n";
  expect(shape(await symbolsOf("a.py", source))).toEqual([
    "def parse", "def decorated", "class Store", "  def __init__", "  def size",
  ]);
});

test("Go separates functions from methods and unwraps declaration groups", async () => {
  const source = [
    "package main",
    'const Version = "1"',
    "type Loader interface { Load(id string) error }",
    "type Store struct { cache map[string]int }",
    "func Parse(input string) (int, error) { return 1, nil }",
    "func (s *Store) Load(id string) error { return nil }",
  ].join("\n") + "\n";
  expect(shape(await symbolsOf("a.go", source))).toEqual([
    "const Version", "type Loader", "type Store", "func Parse", "method Load",
  ]);
});

test("Rust labels an impl block from the trait and type it names", async () => {
  const source = [
    "pub struct Store { cache: u32 }",
    "pub trait Loader { fn load(&self) -> u32; }",
    "impl Loader for Store { fn load(&self) -> u32 { 0 } }",
    "impl Store { fn new() -> Self { Store { cache: 0 } } }",
    "pub fn parse(input: &str) -> u32 { 1 }",
    "mod util { pub fn help() {} }",
  ].join("\n") + "\n";
  expect(shape(await symbolsOf("a.rs", source))).toEqual([
    "struct Store",
    "trait Loader", "  fn load",
    "impl Loader for Store", "  fn load",
    "impl Store", "  fn new",
    "fn parse",
    "mod util", "  fn help",
  ]);
});

test("Java keeps constructors, records and interface members", async () => {
  const source = [
    "public interface Loader { void load(String id); }",
    "public record Point(int x, int y) {}",
    "public class Store implements Loader {",
    "  public Store() {}",
    "  public void load(String id) {}",
    "}",
  ].join("\n") + "\n";
  expect(shape(await symbolsOf("a.java", source))).toEqual([
    "interface Loader", "  method load", "record Point", "class Store", "  constructor Store", "  method load",
  ]);
});

test("C# outlines block namespaces, types and members", async () => {
  const source = [
    "namespace Demo.Core {",
    "  public interface IReader { string Read(string id); }",
    "  public enum Mode { Fast, Safe }",
    "  public delegate void Changed(object sender);",
    "  public record Point(int X, int Y);",
    "  public struct Buffer { public int Length { get; init; } }",
    "  public class Store : IReader {",
    "    private int count;",
    "    public string Name { get; set; } = \"\";",
    "    public Store() { count = 0; }",
    "    public string Read(string id) { var local = id; return local; }",
    "  }",
    "}",
  ].join("\n") + "\n";
  const parsed = await parseSource("Store.cs", source);
  if (!isParsed(parsed)) throw new Error(`Expected a C# tree: ${parsed.detail}`);
  try {
    const symbols = outlineOf(parsed.tree.rootNode, parsed.rules).symbols;
    expect(shape(symbols)).toEqual([
      "namespace Demo.Core",
      "  interface IReader", "    method Read",
      "  enum Mode", "  delegate Changed", "  record Point", "  struct Buffer",
      "  class Store", "    constructor Store", "    method Read",
    ]);
    const store = symbols[0]!.children.find(symbol => symbol.name === "Store")!;
    expect([store.startLine, store.endLine, store.nameLine, store.nameColumn]).toEqual([7, 12, 7, 16]);
    expect(findSymbol(symbols, "Store/Read").map(symbol => symbol.startLine)).toEqual([11]);
    expect(shape(outlineOf(parsed.tree.rootNode, parsed.rules, { includeMembers: true }).symbols))
      .toContain("    field count");
    expect(shape(outlineOf(parsed.tree.rootNode, parsed.rules, { includeMembers: true }).symbols))
      .toContain("    property Name");
  } finally {
    parsed.tree.delete();
  }
});

test("C# file scoped namespaces keep following declarations at file scope", async () => {
  const source = [
    "namespace Serilog;",
    "public static class Log {",
    "#if FEATURE_ASYNCDISPOSABLE",
    "    public static ValueTask CloseAndFlushAsync() { return default; }",
    "#endif",
    "}",
  ].join("\n") + "\n";
  const symbols = await symbolsOf("Log.cs", source);
  expect(shape(symbols)).toEqual(["class Log", "  method CloseAndFlushAsync"]);
  expect(findSymbol(symbols, "Log/CloseAndFlushAsync")[0]?.startLine).toBe(4);
  expect(enclosing(symbols, 4).map(symbol => symbol.name)).toEqual(["Log", "CloseAndFlushAsync"]);
});

test("C and C++ tell a function apart from data by its declarator", async () => {
  const c = [
    "typedef struct { int x; } Point;",
    "struct Node { int v; };",
    "static int helper(int a);",
    "int parse(const char *input) { return 1; }",
  ].join("\n") + "\n";
  // A declarator with a parameter list is a function; anything else is data, and
  // a nested data member stays hidden until includeMembers asks for it.
  expect(shape(await symbolsOf("a.c", c))).toEqual([
    "typedef Point", "struct Node", "function helper", "function parse",
  ]);
  const parsed = await parseSource("a.c", c);
  if (!isParsed(parsed)) throw new Error("Expected a tree.");
  try {
    expect(shape(outlineOf(parsed.tree.rootNode, parsed.rules, { includeMembers: true }).symbols)).toEqual([
      "typedef Point", "struct Node", "  field v", "function helper", "function parse",
    ]);
  } finally {
    parsed.tree.delete();
  }
  const cpp = [
    "namespace app {",
    "class Store { public: int load(const char *id); private: int size_; };",
    "template <typename T> T identity(T v) { return v; }",
    "}",
  ].join("\n") + "\n";
  expect(shape(await symbolsOf("a.cpp", cpp))).toEqual([
    "namespace app", "  class Store", "    method load", "  function identity",
  ]);
});

test("enclosing returns the innermost containing symbol with its owners", async () => {
  const source = [
    "export class Store {",
    "  run() {",
    "    return 1;",
    "  }",
    "}",
    "export function free() { return 2; }",
  ].join("\n") + "\n";
  const symbols = await symbolsOf("a.ts", source);
  expect(enclosing(symbols, 3).map(symbol => symbol.name)).toEqual(["Store", "run"]);
  expect(enclosing(symbols, 6).map(symbol => symbol.name)).toEqual(["free"]);
  expect(enclosing(symbols, 1).map(symbol => symbol.name)).toEqual(["Store"]);
});

test("findSymbol matches a bare name or an owner path and reports every candidate", async () => {
  const source = [
    "export class A { load() { return 1; } }",
    "export class B { load() { return 2; } }",
    "export function load() { return 3; }",
  ].join("\n") + "\n";
  const symbols = await symbolsOf("a.ts", source);
  expect(findSymbol(symbols, "load")).toHaveLength(3);
  expect(findSymbol(symbols, "A/load").map(symbol => symbol.startLine)).toEqual([1]);
  expect(findSymbol(symbols, "B.load").map(symbol => symbol.startLine)).toEqual([2]);
  expect(findSymbol(symbols, "missing")).toEqual([]);
});

test("an owner path falls back to an unambiguous member, as Go methods need", async () => {
  // A Go method is declared at file scope with a receiver, so Store/Load is not
  // a real path, but it is the obvious way to ask for it.
  const go = ["package main", "type Store struct{ cache int }",
    "func (s *Store) Load(id string) int { return s.cache }"].join("\n") + "\n";
  const symbols = await symbolsOf("a.go", go);
  expect(shape(symbols)).toEqual(["type Store", "method Load"]);
  expect(findSymbol(symbols, "Store/Load").map(symbol => symbol.startLine)).toEqual([3]);
  expect(findSymbol(symbols, "Missing/Load").map(symbol => symbol.startLine)).toEqual([3]);
});

test("the fallback refuses to guess between several same-named members", async () => {
  const source = [
    "export class A { load() { return 1; } }",
    "export class B { load() { return 2; } }",
  ].join("\n") + "\n";
  const symbols = await symbolsOf("a.ts", source);
  // A/load is an exact path, so it resolves.
  expect(findSymbol(symbols, "A/load").map(symbol => symbol.startLine)).toEqual([1]);
  // C/load matches no path, and `load` alone is ambiguous, so report nothing.
  expect(findSymbol(symbols, "C/load")).toEqual([]);
});

test("a name the file only uses resolves to its first occurrence", async () => {
  // lsp definition tells the model which declaration a use binds to, which is
  // the point of having it. Before this the resolver only knew declarations,
  // so asking about an imported name was refused and the model was sent to
  // outline instead: the tool rejected the one gesture its guideline promised.
  const source = [
    "import { type Money } from \"./money.ts\";",
    "// Money in a comment is not a use.",
    "const note = \"Money in a string is not a use.\";",
    "export interface Entry { amount: Money }",
  ].join("\n");
  const parsed = await parseSource("ledger.ts", source);
  if (!isParsed(parsed)) throw new Error("expected a parse");
  try {
    const at = occurrenceOf(parsed.tree.rootNode, "Money");
    expect(at).toEqual({ line: 1, column: 15 });
    // A path argument resolves on its last segment, as findSymbol does.
    expect(occurrenceOf(parsed.tree.rootNode, "Entry")).toEqual({ line: 4, column: 18 });
    expect(occurrenceOf(parsed.tree.rootNode, "absent")).toBeUndefined();
    expect(occurrenceOf(parsed.tree.rootNode, "")).toBeUndefined();
  } finally {
    parsed.tree.delete();
  }
});
