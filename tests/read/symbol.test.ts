import { afterEach, expect, test } from "bun:test";
import { createReadBufferTool, readSelection } from "../../src/tools/read.ts";
import { createSearchTool } from "../../src/tools/search.ts";
import { indexSymbols, labelFor } from "../../src/tools/syntax/labels.ts";
import { workspaces } from "../helpers/workspace.ts";

const workspace = workspaces("symbol");
afterEach(workspace.cleanup);
const fixture = workspace.make;

async function read(root: string, input: Record<string, unknown>) {
  const result = await readSelection(root)(input as never, undefined, { cwd: root });
  return result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
}

async function search(root: string, input: Record<string, unknown>) {
  const result = await createSearchTool(root).execute("search", input, undefined, undefined, { cwd: root });
  return result.content.map(block => block.text).join("\n");
}

const SOURCE = [
  "export const VERSION = 1;",            // 1
  "",                                      // 2
  "export class Store {",                  // 3
  "  private cache = new Map();",          // 4
  "  load(id: string) {",                  // 5
  "    return this.cache.get(id);",        // 6
  "  }",                                   // 7
  "}",                                      // 8
  "",                                      // 9
  "export function load(id: string) {",    // 10
  "  return id;",                          // 11
  "}",                                      // 12
].join("\n") + "\n";

test("symbol reads exactly the lines that declare it", async () => {
  const root = await fixture({ "src/a.ts": SOURCE });
  const text = await read(root, { path: "src/a.ts", symbol: "Store/load" });
  expect(text).toContain("[Requested source lines 5-7]");
  expect(text).toContain("5:   load(id: string) {");
  expect(text).toContain("7:   }");
  expect(text).not.toContain("export function load");
});

test("an ambiguous symbol returns every declaration instead of choosing one", async () => {
  const root = await fixture({ "src/a.ts": SOURCE });
  const text = await read(root, { path: "src/a.ts", symbol: "load" });
  // Both the method and the free function are named load.
  expect(text).toContain("5:   load(id: string) {");
  expect(text).toContain("10: export function load(id: string) {");
});

test("C++ symbol reads resolve out-of-class methods by leaf or owner", async () => {
  const root = await fixture({ "src/a.cpp": [
    "namespace Catch {",
    "void RunContext::populateReaction(int& reaction) {",
    "  reaction = 1;",
    "}",
    "void OtherContext::populateReaction(int& reaction) {",
    "  reaction = 2;",
    "}",
    "}",
  ].join("\n") + "\n" });
  const bare = await read(root, { path: "src/a.cpp", symbol: "populateReaction" });
  expect(bare).toContain("2: void RunContext::populateReaction");
  expect(bare).toContain("5: void OtherContext::populateReaction");
  for (const query of ["RunContext::populateReaction", "RunContext/populateReaction"]) {
    const selected = await read(root, { path: "src/a.cpp", symbol: query });
    expect(selected).toContain("2: void RunContext::populateReaction");
    expect(selected).not.toContain("5: void OtherContext::populateReaction");
  }
});

test("declaration labels select TypeScript symbols when the match is unique", async () => {
  const source = [
    "export type Mode = 'fast' | 'safe';",
    "export class Store { load() { return 1; } }",
    "export function load() { return 2; }",
  ].join("\n") + "\n";
  const root = await fixture({ "src/a.ts": source });
  expect(await read(root, { path: "src/a.ts", symbol: "type Mode" })).toContain("1: export type Mode");
  const method = await read(root, { path: "src/a.ts", symbol: "method load" });
  expect(method).toContain("2: export class Store");
  expect(method).not.toContain("3: export function load");
  expect(await read(root, { path: "src/a.ts", symbol: "Store > method load" }))
    .toContain("2: export class Store");
});

test("read accepts the actual declaration kinds shown by grep", async () => {
  const root = await fixture({ "src/a.ts": [
    "export const PureDateInput = () => 1;",
    "export class Store { load() { return 2; } }",
    "export function parse() { return 3; }",
  ].join("\n") + "\n" });
  for (const [line, label] of [[1, "const PureDateInput"], [2, "class Store"],
    [3, "function parse"]] as const) {
    const text = await read(root, { path: "src/a.ts", symbol: label });
    expect(text).toContain(`${line}: export`);
  }
  expect(await read(root, { path: "src/a.ts", symbol: "Store > method load" }))
    .toContain("2: export class Store");
});

test("C++ grep labels select a unique out-of-class definition", async () => {
  const root = await fixture({ "src/a.cpp": [
    "namespace Catch {",
    "class StringRef {};",
    "class Capturer { public: Capturer(); };",
    "Capturer::Capturer() {}",
    "}",
  ].join("\n") + "\n" });
  const index = await indexSymbols(root, ["src/a.cpp"]);
  expect(labelFor(index, "src/a.cpp", 4)).toBe("Catch > function Capturer::Capturer");
  expect(await read(root, { path: "src/a.cpp", symbol: "Catch > class StringRef" }))
    .toContain("2: class StringRef");
  expect(await read(root, { path: "src/a.cpp", symbol: "Catch > function Capturer::Capturer" }))
    .toContain("4: Capturer::Capturer()");
});

test("kind labels refuse a wrong kind, wrong owner, or ambiguous declaration", async () => {
  const root = await fixture({ "src/a.ts": [
    "export class A { load() { return 1; } }",
    "export class B {}",
    "export function parse() { return 2; }",
    "export const theme = 1;",
    "export const theme = 2;",
  ].join("\n") + "\n" });
  for (const label of ["B > method load", "class parse", "function A", "const theme", "class"]) {
    await expect(read(root, { path: "src/a.ts", symbol: label }))
      .rejects.toThrow(`No symbol "${label}" in src/a.ts`);
  }
  // Literal names keep their existing lookup, including the owner fallback.
  expect(await read(root, { path: "src/a.ts", symbol: "B/load" }))
    .toContain("1: export class A");
});

test("Go method labels resolve flat receiver declarations", async () => {
  const root = await fixture({ "src/a.go": [
    "package main",
    "type Store struct { value int }",
    "func (s *Store) Load() int { return s.value }",
  ].join("\n") + "\n" });
  expect(await read(root, { path: "src/a.go", symbol: "type Store" }))
    .toContain("2: type Store struct");
  expect(await read(root, { path: "src/a.go", symbol: "Store > method Load" }))
    .toContain("3: func (s *Store) Load");
});

test("C# symbol reads and search labels include methods inside preprocessor branches", async () => {
  const root = await fixture({ "src/Log.cs": [
    "namespace Serilog;",
    "public static class Log {",
    "#if FEATURE_ASYNCDISPOSABLE",
    "  public static ValueTask CloseAndFlushAsync() {",
    "    return default;",
    "  }",
    "#endif",
    "}",
  ].join("\n") + "\n" });
  const selected = await read(root, { path: "src/Log.cs", symbol: "Log/CloseAndFlushAsync" });
  expect(selected).toContain("[Requested source lines 4-6]");
  expect(selected).toContain("4:   public static ValueTask CloseAndFlushAsync()");
  expect(selected).not.toContain("1: namespace Serilog;");
  const hits = await search(root, { pattern: "return default", path: "src/Log.cs" });
  expect(hits).toContain("[Log > method CloseAndFlushAsync]");
  expect(hits).toContain("  5:     return default;");
});

test("Rust fn labels and method aliases resolve within an impl", async () => {
  const root = await fixture({ "src/a.rs": [
    "pub struct Store { value: u32 }",
    "impl Store {",
    "    pub fn new() -> Self { Store { value: 1 } }",
    "}",
    "pub fn parse() -> u32 { 1 }",
  ].join("\n") + "\n" });
  for (const query of ["Store > fn new", "Store > method new"]) {
    const text = await read(root, { path: "src/a.rs", symbol: query });
    expect(text).toContain("3:     pub fn new()");
    expect(text).not.toContain("5: pub fn parse()");
  }
  expect(await read(root, { path: "src/a.rs", symbol: "fn parse" }))
    .toContain("5: pub fn parse()");
});

test("ambiguous declaration labels keep the original miss and suggestions", async () => {
  const root = await fixture({ "src/a.ts": [
    "export class A { load() { return 1; } }",
    "export class B { load() { return 2; } }",
  ].join("\n") + "\n" });
  await expect(read(root, { path: "src/a.ts", symbol: "method load" }))
    .rejects.toThrow('No symbol "method load" in src/a.ts. Did you mean');
  expect(await read(root, { path: "src/a.ts", symbol: "A > method load" }))
    .toContain("1: export class A");
});

test("a class symbol covers its whole declaration", async () => {
  const root = await fixture({ "src/a.ts": SOURCE });
  expect(await read(root, { path: "src/a.ts", symbol: "Store" })).toContain("[Requested source lines 3-8]");
});

test("a missing symbol lists the names the file declares, shallowest first", async () => {
  const root = await fixture({ "src/a.ts": SOURCE });
  const failure = read(root, { path: "src/a.ts", symbol: "laod" });
  await expect(failure).rejects.toThrow('No symbol "laod" in src/a.ts');
  await expect(failure).rejects.toThrow("Declared: VERSION, Store, load, Store/cache");
});

test("symbol rejects a file with no grammar and a path outside the workspace", async () => {
  const root = await fixture({ "notes.md": "# title\n", "src/a.ts": SOURCE });
  await expect(read(root, { path: "notes.md", symbol: "title" })).rejects.toThrow("No grammar for .md");
  await expect(read(root, { path: "../outside.ts", symbol: "x" })).rejects.toThrow("inside the workspace");
});

test("symbol does not combine with ranges", async () => {
  const root = await fixture({ "src/a.ts": SOURCE });
  await expect(read(root, { path: "src/a.ts", symbol: "Store", ranges: [{ start: 1, end: 2 }] }))
    .rejects.toThrow("use one of them");
  // The offset, limit and lineNumbers conflicts went with the tool parameters:
  // a selection takes a path and a region, and nothing else.
});

test("ordinary reads keep native output, and the tool offers no symbol option", async () => {
  const root = await fixture({ "src/a.ts": SOURCE });
  const tool = createReadBufferTool(root);
  const result = await tool.execute("read", { path: "src/a.ts" } as never, undefined, undefined,
    { cwd: root } as never);
  const plain = result.content.flatMap(b => b.type === "text" ? [b.text] : []).join("\n");
  expect(plain).toContain("export const VERSION = 1;");
  expect(plain).not.toContain("1: export const VERSION");
  const schema = tool.parameters as { properties?: object };
  expect(schema.properties).not.toHaveProperty("symbol");
});

test("search heads a run of hits with its file and symbol instead of repeating them", async () => {
  const root = await fixture({ "src/a.ts": SOURCE });
  const text = await search(root, { pattern: "cache", path: "src/a.ts" });
  // The path leads the group, not every line. Across 53 measured results that
  // repetition was 47 percent of grep's whole output.
  expect(text.split("\n").filter(line => line === "src/a.ts")).toHaveLength(1);
  expect(text).toContain("[class Store]");
  expect(text).toContain("  4:   private cache = new Map();");
  expect(text).toContain("[Store > method load]");
  expect(text).toContain("  6:     return this.cache.get(id);");
  // A module scope hit has no enclosing symbol to name.
  const imports = await search(root, { pattern: "VERSION", path: "src/a.ts" });
  expect(imports).toContain("[const VERSION]");
  expect(imports).toContain("  1: export const VERSION = 1;");
  expect(await search(root, { pattern: "^\\s*$", path: "src/a.ts" })).not.toContain("[");
});

test("context lines carry no label and an unparsable file still returns its matches", async () => {
  const root = await fixture({ "src/a.ts": SOURCE, "notes.md": "alpha\nbeta\n" });
  const text = await search(root, { pattern: "return this.cache", path: "src/a.ts", context: 1 });
  expect(text).toContain("  5-   load(id: string) {");
  // A file with no grammar keeps its hits and simply has no labels.
  const markdown = await search(root, { pattern: "beta", path: "notes.md" });
  expect(markdown).toContain("notes.md");
  expect(markdown).toContain("  2: beta");
  expect(markdown).not.toContain("[");
});

test("labelFor reports the innermost symbol and nothing outside a declaration", async () => {
  const root = await fixture({ "src/a.ts": SOURCE });
  const index = await indexSymbols(root, ["src/a.ts", "src/a.ts"]);
  expect(index.size).toBe(1);
  expect(labelFor(index, "src/a.ts", 6)).toBe("Store > method load");
  expect(labelFor(index, "src/a.ts", 3)).toBe("class Store");
  expect(labelFor(index, "src/a.ts", 9)).toBeUndefined();
  expect(labelFor(index, "missing.ts", 1)).toBeUndefined();
});
