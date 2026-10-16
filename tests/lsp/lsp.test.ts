import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSemanticLayer, type Query, type SemanticLayer } from "../../src/tools/lsp.ts";
import { LspBusyError, LspClient, LspUnavailableError, fileUri } from "../../src/tools/lsp/client.ts";
import { argsFor, findBinary, overrideLanguageFor, overrideRecipe, RECIPES, serverRoot } from "../../src/tools/lsp/servers.ts";
import { detectLanguages, renderDoctor, type DoctorRow } from "../../src/tools/lsp/doctor.ts";
import type { ResolvedServer } from "../../src/tools/lsp/servers.ts";
import { PROJECT_WIDE_ACTIONS, hasProjectConfig } from "../../src/tools/lsp/tsserver-fallback.ts";

const FAUX = fileURLToPath(new URL("../helpers/lsp-server.mjs", import.meta.url));
const roots: string[] = [];
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(disposers.splice(0).map(dispose => dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "nekopi-lsp-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

/** A resolver that points at the scripted server instead of an installed one. */
function fauxResolver(language = "typescript") {
  return async (requested: string): Promise<ResolvedServer | undefined> => {
    if (requested !== language) return undefined;
    return { language, command: process.execPath, args: [FAUX],
      recipe: { commands: ["faux"], args: [], rootMarkers: ["tsconfig.json"], install: "n/a" } };
  };
}

function tool(root: string, script: Record<string, unknown>, language = "typescript") {
  process.env.NEKOPI_FAUX_LSP = JSON.stringify(script);
  const created = createSemanticLayer(root, { resolve: fauxResolver(language) as never, timeoutMs: 5_000 });
  disposers.push(() => created.dispose());
  return created;
}

async function run(root: string, created: SemanticLayer, input: Query) {
  const result = await created.query(input, undefined, root);
  return { text: result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n"),
    details: result.details };
}

const SOURCE = "export function target() { return 1; }\nexport const used = target() + target();\n";

function locations(root: string) {
  const uri = fileUri(join(root, "a.ts"));
  return [
    { uri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } } },
    { uri, range: { start: { line: 1, character: 20 }, end: { line: 1, character: 26 } } },
  ];
}

test("locations render as path:line:column with the source line", async () => {
  const root = await fixture({ "a.ts": SOURCE, "tsconfig.json": "{}" });
  const created = tool(root, { responses: { "textDocument/references": [locations(root)] } });
  const { text, details } = await run(root, created, { action: "references", file: "a.ts", symbol: "target" });
  expect(text.split("\n")).toEqual([
    "a.ts:1:17  export function target() { return 1; }",
    "a.ts:2:21  export const used = target() + target();",
  ]);
  expect(details).toMatchObject({ action: "references", language: "typescript", results: 2, root: "." });
});

test("a declaration name resolves through the syntax layer, for any language", async () => {
  const root = await fixture({ "a.py": "def target():\n    return 1\n", "pyproject.toml": "" });
  const uri = fileUri(join(root, "a.py"));
  const created = tool(root, { responses: { "textDocument/definition":
    { uri, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } } } } }, "python");
  // Python has no tsserver fallback, so this proves the name came from tree-sitter.
  const { text } = await run(root, created, { action: "definition", file: "a.py", symbol: "target" });
  expect(text).toBe("a.py:1:5  def target():");
});

test("diagnostics accept the push model and report severity, code and message", async () => {
  const root = await fixture({ "a.ts": SOURCE, "tsconfig.json": "{}" });
  const created = tool(root, { diagnostics: [
    { range: { start: { line: 1, character: 13 }, end: { line: 1, character: 17 } },
      severity: 1, code: 2322, message: "Faux  type   error." },
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, severity: 2, message: "A warning." },
  ] });
  const { text, details } = await run(root, created, { action: "diagnostics", file: "a.ts" });
  expect(text.split("\n")).toEqual([
    "a.ts:2:14  error 2322: Faux type error.",
    "a.ts:1:1  warning: A warning.",
  ]);
  expect(details.results).toBe(2);
});

test("a clean file reports no diagnostics without inventing a ledger", async () => {
  const root = await fixture({ "a.ts": SOURCE, "tsconfig.json": "{}" });
  const created = tool(root, { diagnostics: [] });
  expect((await run(root, created, { action: "diagnostics", file: "a.ts" })).text).toBe("No diagnostics.");
});

test("a result outside the workspace is excluded from locations", async () => {
  const root = await fixture({ "a.ts": SOURCE, "tsconfig.json": "{}" });
  const created = tool(root, { responses: { "textDocument/references": [[
    ...locations(root),
    { uri: "file:///etc/passwd", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
  ]] } });
  const { text, details } = await run(root, created, { action: "references", file: "a.ts", symbol: "target" });
  expect(details.results).toBe(2);
  expect(text).not.toContain("passwd");
});

test("a missing server is one actionable line, not an error", async () => {
  const root = await fixture({ "a.go": "package main\nfunc target() int { return 1 }\n", "go.mod": "module x\n" });
  const created = tool(root, {}, "typescript");
  const { text, details } = await run(root, created, { action: "references", file: "a.go", symbol: "target" });
  expect(text).toBe("No language server for go, and no workspace compiler to fall back on. Use read and grep.");
  expect(details.unavailable).toBeDefined();
  expect(details.results).toBe(0);
  // The session records the language so the user can be told once.
  expect(created.session.missingLanguages).toEqual(["go"]);
});

test("a server that exits at startup fails fast and quotes its own stderr", async () => {
  const root = await fixture({ "a.ts": SOURCE, "tsconfig.json": "{}" });
  const created = tool(root, { exitOnStart: true, stderr: "error: Unknown binary 'faux' in toolchain" });
  const started = Date.now();
  const { text } = await run(root, created, { action: "definition", file: "a.ts", symbol: "target" });
  // A binary that exists but is a broken shim must not consume the start deadline.
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(text).toContain("Unknown binary 'faux' in toolchain");
});

test("a server that dies mid-session is replaced on the next query", async () => {
  const root = await fixture({ "a.ts": SOURCE, "tsconfig.json": "{}" });
  const created = tool(root, { exitOnRequest: "textDocument/definition",
    responses: { "textDocument/references": [locations(root)] } });
  const first = await run(root, created, { action: "definition", file: "a.ts", symbol: "target" });
  expect(first.details.unavailable).toBeDefined();
  // The replacement answers a different action from a fresh process.
  const second = await run(root, created, { action: "references", file: "a.ts", symbol: "target" });
  expect(second.details.results).toBe(2);
});

test("an empty result from a cold server is retried, not reported as absence", async () => {
  const root = await fixture({ "a.ts": SOURCE, "tsconfig.json": "{}" });
  // A real server answers an early query with an empty result while it indexes.
  const created = tool(root, { responses: { "textDocument/definition": [null, null, locations(root)[0]] } });
  const { text, details } = await run(root, created, { action: "definition", file: "a.ts", symbol: "target" });
  expect(details.results).toBe(1);
  expect(text).toBe("a.ts:1:17  export function target() { return 1; }");
});

test("a persistently empty result from a cold server says the project is still loading", async () => {
  const root = await fixture({ "a.ts": SOURCE, "tsconfig.json": "{}" });
  const created = tool(root, { responses: { "textDocument/definition": null } });
  const { text, details } = await run(root, created, { action: "definition", file: "a.ts", symbol: "target" });
  expect(details.results).toBe(0);
  expect(text).toContain("still loading the project");
});

test("a warm server reports a genuinely empty result as absence", async () => {
  const root = await fixture({ "a.ts": SOURCE, "tsconfig.json": "{}" });
  const created = tool(root, { responses: {
    "textDocument/references": [locations(root)], "textDocument/definition": null } });
  // The first query warms the server, so the second is trusted as empty.
  expect((await run(root, created, { action: "references", file: "a.ts", symbol: "target" })).details.results).toBe(2);
  const { text } = await run(root, created, { action: "definition", file: "a.ts", symbol: "target" });
  expect(text).toBe("No definition results in this project.");
  expect(text).not.toContain("still loading");
});

test("a server error response degrades to one line instead of failing the task", async () => {
  const root = await fixture({ "a.ts": SOURCE, "tsconfig.json": "{}" });
  // gopls answers "no views" when its workspace is not what it expects; such an
  // error is a server problem, so it must not surface as a failed tool call.
  const created = tool(root, { errorOnRequest: { "textDocument/references": { code: -32603, message: "no views" } } });
  const { text, details } = await run(root, created, { action: "references", file: "a.ts", symbol: "target" });
  expect(text).toContain("unavailable");
  expect(text).toContain("no views");
  expect(details.unavailable).toBeDefined();
  expect(details.results).toBe(0);
});

test("a server that says its state changed is asked again, not reported dead", async () => {
  const root = await fixture({ "a.ts": SOURCE, "tsconfig.json": "{}" });
  // ContentModified is the protocol's "ask again", and rust-analyzer sends it
  // throughout its first indexing pass. Reported as a dead server it made every
  // Rust query say there was no language server for the first seconds of a
  // session, which reads exactly like a language nekopi cannot navigate.
  const created = tool(root, {
    errorOnRequest: { "textDocument/references": [{ code: -32801, message: "content modified" }] },
    responses: { "textDocument/references": [locations(root)] },
  });
  const { text, details } = await run(root, created, { action: "references", file: "a.ts", symbol: "target" });
  expect(details.unavailable).toBeUndefined();
  expect(details.results).toBe(2);
  expect(text).toContain("a.ts:1:17");
});

test("an empty answer is waited out while the server reports work, and not after", async () => {
  const root = await fixture({ "a.ts": SOURCE, "tsconfig.json": "{}" });
  // A server that is still indexing answers with nothing rather than blocking,
  // so an empty result during its loading pass is not evidence of absence.
  const loading = tool(root, { workingFor: 600,
    responses: { "textDocument/references": [[], [], locations(root)] } });
  const answered = await run(root, loading, { action: "references", file: "a.ts", symbol: "target" });
  expect(answered.details.results).toBe(2);
  // A quiet server's empty answer is an answer, and waiting on it would stall
  // every query that genuinely has no result.
  const quiet = tool(root, { responses: { "textDocument/references": [] } });
  const started = Date.now();
  const none = await run(root, quiet, { action: "references", file: "a.ts", symbol: "target" });
  expect(none.details.results).toBe(0);
  expect(Date.now() - started).toBeLessThan(4_000);
});

test("a busy server is still an unavailable one when it never settles", () => {
  // The retry is bounded. Past the budget the query reports a server problem,
  // because the one answer it must never give is "there are no references".
  expect(new LspBusyError("busy")).toBeInstanceOf(LspUnavailableError);
});

test("one failing action does not take down the others", async () => {
  const root = await fixture({ "a.ts": SOURCE, "tsconfig.json": "{}" });
  const created = tool(root, {
    errorOnRequest: { "textDocument/references": { message: "internal error" } },
    responses: { "textDocument/definition": locations(root)[0] },
  });
  expect((await run(root, created, { action: "references", file: "a.ts", symbol: "target" })).details.unavailable).toBeDefined();
  // The server is still alive, so the next action answers normally.
  expect((await run(root, created, { action: "definition", file: "a.ts", symbol: "target" })).details.results).toBe(1);
});

test("a slow request is bounded by the query deadline", async () => {
  const root = await fixture({ "a.ts": SOURCE, "tsconfig.json": "{}" });
  process.env.NEKOPI_FAUX_LSP = JSON.stringify({ delayMs: { "textDocument/definition": 3_000 } });
  const created = createSemanticLayer(root, { resolve: fauxResolver() as never, timeoutMs: 300 });
  disposers.push(() => created.dispose());
  const { text } = await run(root, created, { action: "definition", file: "a.ts", symbol: "target" });
  expect(text).toContain("unavailable");
});

test("argument and action combinations are validated before a server starts", async () => {
  const root = await fixture({ "a.ts": SOURCE, "notes.md": "# title\n", "tsconfig.json": "{}" });
  const created = tool(root, {});
  for (const [input, message] of [
    [{ action: "references", file: "a.ts", symbol: "target", line: 1, column: 1 }, "not both"],
    [{ action: "references", file: "a.ts" }, "needs symbol, or line and column"],
    [{ action: "references", file: "../outside.ts", symbol: "x" }, "inside the workspace"],
  ] as const) {
    await expect(run(root, created, input as never)).rejects.toThrow(message);
  }
  // A file with no mapped language is reported, not thrown.
  expect((await run(root, created, { action: "diagnostics", file: "notes.md" })).text)
    .toContain("No language is mapped");
});

test("the project root comes from the language's marker files", async () => {
  const root = await fixture({ "packages/app/tsconfig.json": "{}", "packages/app/src/a.ts": SOURCE, "tsconfig.json": "{}" });
  expect(await serverRoot(RECIPES.typescript!, root, "packages/app/src/a.ts")).toBe(join(root, "packages/app"));
  expect(await serverRoot(RECIPES.go!, root, "packages/app/src/a.ts")).toBe(root);
});

test("binary discovery searches beyond PATH and reports a miss", async () => {
  const root = await fixture({ "node_modules/.bin/placeholder": "" });
  const binary = join(root, "node_modules/.bin/faux-server");
  await writeFile(binary, "#!/bin/sh\n");
  await chmod(binary, 0o755);
  // An installed server off PATH is still found.
  expect(await findBinary("faux-server", root, "/nonexistent")).toBe(binary);
  expect(await findBinary("absent-server", root, "/nonexistent")).toBeUndefined();
  // A non-executable file is not a server.
  await chmod(binary, 0o644);
  expect(await findBinary("faux-server", root, "/nonexistent")).toBeUndefined();
});

test("stdio flags follow the server, not the recipe", () => {
  expect(argsFor(RECIPES.typescript!, "/usr/bin/typescript-language-server")).toEqual(["--stdio"]);
  // pylsp, gopls, rust-analyzer and clangd reject or ignore --stdio.
  expect(argsFor(RECIPES.python!, "/usr/bin/pylsp")).toEqual([]);
  expect(argsFor(RECIPES.cpp!, "/usr/bin/clangd")).toEqual(["--background-index"]);
});

test("an override replaces a recipe's command, arguments and options", () => {
  const recipe = overrideRecipe("go", { go: { command: "/opt/gopls", args: ["-rpc.trace"],
    initializationOptions: { build: { directoryFilters: ["-vendor"] } } } })!;
  expect(recipe.commands).toEqual(["/opt/gopls"]);
  expect(recipe.args).toEqual(["-rpc.trace"]);
  expect(recipe.initialization).toEqual({ build: { directoryFilters: ["-vendor"] } });
  // Unstated fields keep the built-in recipe.
  expect(recipe.rootMarkers).toEqual(RECIPES.go!.rootMarkers);
});

test("an override supports a language with no built-in recipe", () => {
  const overrides = { zig: { command: "zls", extensions: ["zig"] } };
  const recipe = overrideRecipe("zig", overrides)!;
  expect(recipe.commands).toEqual(["zls"]);
  expect(recipe.rootMarkers).toEqual([".git"]);
  // The syntax layer has no zig grammar, so the override claims the extension.
  expect(overrideLanguageFor("main.zig", overrides)).toBe("zig");
  expect(overrideLanguageFor("main.ts", overrides)).toBeUndefined();
  expect(overrideRecipe("zig", {})).toBeUndefined();
});

test("an override with no command still needs a built-in recipe to name one", () => {
  expect(overrideRecipe("go", { go: { args: ["-v"] } })!.commands).toEqual(RECIPES.go!.commands.slice(0, 1));
  expect(overrideRecipe("cobol", { cobol: { args: ["-v"] } })).toBeUndefined();
});

test("an overridden language reaches the tool even without a grammar", async () => {
  const root = await fixture({ "main.zig": "pub fn main() void {}\n" });
  process.env.NEKOPI_FAUX_LSP = JSON.stringify({ responses: { "textDocument/definition":
    [{ uri: `file://${join(root, "main.zig")}`, range: { start: { line: 0, character: 7 }, end: { line: 0, character: 11 } } }] } });
  const created = createSemanticLayer(root, { timeoutMs: 5_000,
    servers: { zig: { command: process.execPath, args: [FAUX], extensions: ["zig"] } } });
  disposers.push(() => created.dispose());
  // No grammar means no declaration name, so the query uses coordinates.
  const { text, details } = await run(root, created, { action: "definition", file: "main.zig", line: 1, column: 8 });
  expect(details.language).toBe("zig");
  expect(text).toContain("main.zig:1:8");
  // A declaration name cannot be resolved without a grammar, and says so.
  await expect(run(root, created, { action: "definition", file: "main.zig", symbol: "main" }))
    .rejects.toThrow("No grammar for .zig");
});

test("the doctor detects workspace languages and never tells the model to install", async () => {
  const root = await fixture({
    "src/a.ts": SOURCE, "src/b.ts": SOURCE, "main.go": "package main\n",
    "node_modules/dep/index.ts": SOURCE, "dist/out.ts": SOURCE, "notes.md": "# x\n",
  });
  const detected = await detectLanguages(root);
  // Generated and vendored trees are not the workspace's languages.
  expect(detected).toEqual([{ language: "typescript", files: 2 }, { language: "go", files: 1 }]);
  const rows: DoctorRow[] = [
    { language: "typescript", files: 2, command: "/usr/bin/typescript-language-server", install: "npm i -g ...", fallback: true },
    { language: "go", files: 1, install: "go install golang.org/x/tools/gopls@latest", fallback: false },
  ];
  const report = renderDoctor(root, rows);
  expect(report).toContain("Found:");
  expect(report).toContain("/usr/bin/typescript-language-server");
  expect(report).toContain("install: go install golang.org/x/tools/gopls@latest");
  expect(report).toContain("never installs a server");
});

test("the diagnostics provider reuses the session and reports nothing when unavailable", async () => {
  const root = await fixture({ "a.ts": SOURCE, "tsconfig.json": "{}" });
  const created = tool(root, { diagnostics: [
    { range: { start: { line: 0, character: 7 }, end: { line: 0, character: 15 } },
      severity: 1, code: 2322, message: "Faux type error." }] });
  // The mutation tools call this provider after a successful edit.
  const report = await created.diagnose("a.ts");
  expect(report).toContain("a.ts:1:8  error 2322: Faux type error.");
  // A language with no server yields no report at all, so nothing is appended.
  await writeFile(join(root, "b.go"), "package main\nfunc main() {}\n");
  expect(await created.diagnose("b.go")).toBeUndefined();
});

test("a changed document invalidates the cached publish, so a fix is not reported stale", async () => {
  const root = await fixture({ "a.ts": SOURCE, "tsconfig.json": "{}" });
  // The scripted server publishes an error first, then nothing after the change.
  const created = tool(root, { diagnostics: [
    [{ range: { start: { line: 0, character: 7 }, end: { line: 0, character: 15 } },
      severity: 1, code: 2322, message: "Faux type error." }],
    [],
  ] });
  expect((await run(root, created, { action: "diagnostics", file: "a.ts" })).details.results).toBe(1);
  // Changing the file must not return the publish that described the old text.
  await writeFile(join(root, "a.ts"), SOURCE.replace("return 1", "return 2"));
  const { text, details } = await run(root, created, { action: "diagnostics", file: "a.ts" });
  expect(details.results).toBe(0);
  expect(text).not.toContain("Faux type error");
});

test("the client rejects an oversized source and survives dispose twice", async () => {
  const root = await fixture({ "big.ts": `const big = "${"x".repeat(2 * 1024 * 1024)}";\n`, "tsconfig.json": "{}" });
  process.env.NEKOPI_FAUX_LSP = "{}";
  const client = new LspClient({ command: process.execPath, args: [FAUX], root, language: "typescript" });
  await client.start();
  await expect(client.sync(join(root, "big.ts"), "typescript")).rejects.toThrow("MiB source limit");
  await client.dispose();
  await client.dispose();
  expect(client.alive).toBe(false);
  await expect(client.request("textDocument/hover", {})).rejects.toThrow(LspUnavailableError);
});

test("a project-wide search without a tsconfig says it saw only one file", async () => {
  const root = await mkdtemp(join(tmpdir(), "nekopi-scope-"));
  roots.push(root);
  await mkdir(join(root, "src/deep"), { recursive: true });
  await writeFile(join(root, "src/deep/a.ts"), "export const x = 1;\n", "utf8");
  // No config anywhere: tsserver infers a project of the open file alone, so
  // "every use" means "every use in this file" and must not read as the answer.
  expect(hasProjectConfig(root, "src/deep/a.ts")).toBe(false);
  // A config at the root covers a file nested under it.
  await writeFile(join(root, "tsconfig.json"), "{}\n", "utf8");
  expect(hasProjectConfig(root, "src/deep/a.ts")).toBe(true);
  // So does one beside the file, and jsconfig counts.
  const other = await mkdtemp(join(tmpdir(), "nekopi-scope-"));
  roots.push(other);
  await mkdir(join(other, "pkg"), { recursive: true });
  await writeFile(join(other, "pkg/b.ts"), "export const y = 2;\n", "utf8");
  await writeFile(join(other, "pkg/jsconfig.json"), "{}\n", "utf8");
  expect(hasProjectConfig(other, "pkg/b.ts")).toBe(true);
  // The walk stops at the workspace root rather than escaping it.
  expect(hasProjectConfig(join(other, "pkg"), "b.ts")).toBe(true);
});

test("only whole-project actions are narrowed by a missing tsconfig", () => {
  // definition follows an import the open file states, so it still resolves.
  expect(PROJECT_WIDE_ACTIONS.has("definition")).toBe(false);
  expect(PROJECT_WIDE_ACTIONS.has("implementation")).toBe(false);
  expect(PROJECT_WIDE_ACTIONS.has("references")).toBe(true);
});
