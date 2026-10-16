import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTsserverTool as createProjectTsserverTool, type TsserverOptions } from "../../src/tools/typescript.ts";

/** Tests exercise the protocol client with the pinned development compiler available. */
const createTsserverTool = (cwd: string, options: TsserverOptions = {}) =>
  createProjectTsserverTool(cwd, { allowHarnessFallback: true, ...options });
import { source } from "../../src/tools/typescript/source.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "nekopi-tsserver-")); roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), text);
  }
  return root;
}
const config = JSON.stringify({ compilerOptions: { strict: true, target: "ES2023", module: "Preserve", moduleResolution: "Bundler" }, include: ["src"] });
async function query(root: string, input: Parameters<ReturnType<typeof createTsserverTool>["execute"]>[1], options: TsserverOptions = {}, signal?: AbortSignal) {
  const tool = createTsserverTool(root, options);
  const result = await tool.execute("query", input, signal, undefined, {} as never);
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse((result.content[0] as { type: "text"; text: string }).text);
}
function gone(pid: number) { expect(() => process.kill(pid, 0)).toThrow(); }

function at(text: string, needle: string) {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`Missing fixture location: ${needle}`);
  const before = text.slice(0, index).split("\n");
  return { line: before.length, column: before.at(-1)!.length + 1 };
}

describe("fresh tsserver code intelligence", () => {
  test("source decoding agrees with the compiler and preserves the original byte identity", async () => {
    const text = "\uFEFF\uFEFFexport const value = '\uFEFF';\r\n";
    const root = await project({ "src/main.ts": text });
    const decoded = await source(join(root, "src/main.ts"));
    const compiler = createRequire(import.meta.url)("typescript") as typeof import("typescript");
    expect(decoded.text).toBe(compiler.sys.readFile(join(root, "src/main.ts"))!);
    expect(decoded.lines).toEqual(["\uFEFFexport const value = '\uFEFF';", ""]);
    expect(decoded.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(decoded.sha256).not.toBe(createHash("sha256").update(decoded.text).digest("hex"));
  });

  test("BOM-only target changes are rejected even without persistent project bookkeeping", async () => {
    const script = `import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync} from 'node:fs';
createInterface({input:process.stdin}).on('line',line=>{
  const q=JSON.parse(line),root=process.cwd(); if(['open','close'].includes(q.command))return;
  const body=q.command==='projectInfo'?{configFileName:root+'/tsconfig.json'}:
    ['compilerOptionsDiagnostics-full','syntacticDiagnosticsSync','semanticDiagnosticsSync'].includes(q.command)?[]:{};
  if(q.command==='syntacticDiagnosticsSync'){
    const path=q.arguments.file,before=readFileSync(path,'utf8');
    writeFileSync(path,before.startsWith('\\uFEFF')?before.slice(1):'\\uFEFF'+before);
  }
  const text=JSON.stringify({type:'response',request_seq:q.seq,success:true,body});
  process.stdout.write('Content-Length: '+Buffer.byteLength(text)+'\\r\\n\\r\\n'+text);
});`;
    const root = await project({ "package.json": JSON.stringify({ name: "typescript", version: "5.9.3", type: "module" }),
      "tsconfig.json": config, "lib/tsserver.js": script, "src/main.ts": "export const value = 1;\n" });
    await symlink(createRequire(import.meta.url).resolve("typescript"), join(root, "lib/typescript.js"));
    for (const bom of ["", "\uFEFF"]) {
      await writeFile(join(root, "src/main.ts"), bom + "export const value = 1;\n");
      let pid = 0;
      await expect(query(root, { action: "diagnostics", file: "src/main.ts" }, {
        serverPath: join(root, "lib/tsserver.js"), onSpawn: value => pid = value,
      })).rejects.toThrow("Target source changed during the query");
      gone(pid);
    }
  }, 10_000);

  test("implementation finds the implementing member and reports an empty result plainly", async () => {
    const text = 'export abstract class Base { abstract load(): number; }\nexport class Concrete extends Base { load() { return 7; } }\nexport interface Absent { missing(): void }\n';
    const root = await project({ "tsconfig.json": config, "src/main.ts": text });
    const method = await query(root, { action: "implementation", file: "src/main.ts", ...at(text, "load(): number") });
    expect(method.results).toHaveLength(1);
    expect(method.results[0]).toMatchObject({ spanText: "load", start: at(text, "load() { return") });
    expect(method.incomplete).toBeUndefined();
    // An interface member with no implementation is an empty result, not an error.
    const empty = await query(root, { action: "implementation", file: "src/main.ts", ...at(text, "missing(): void") });
    expect(empty.results).toEqual([]);
    expect(empty.uninspectedResults).toBeUndefined();
  }, 15_000);
  test("resolves nested config extends and aliases without unrelated same-name matches", async () => {
    const root = await project({
      "base.json": JSON.stringify({ compilerOptions: { strict: true, module: "Preserve", moduleResolution: "Bundler", baseUrl: ".", paths: { "@/*": ["package/src/*"] } } }),
      "package/tsconfig.json": JSON.stringify({ extends: "../base.json", include: ["src"] }),
      "package/src/numbers.ts": "export function format(value: number) { return value.toFixed(2); }\n",
      "package/src/strings.ts": "export function format(value: string) { return value.toUpperCase(); }\n",
      "package/src/use.ts": "import { format as render } from '@/numbers';\nimport { format } from './strings';\nexport const result = render(2) + format('hi');\n",
    });
    let pid = 0;
    const def = await query(root, { action: "definition", file: "package/src/use.ts", line: 3, column: 23 }, { onSpawn: value => pid = value });
    gone(pid);
    expect(def.project).toMatchObject({ config: "package/tsconfig.json" });
    expect(def.results).toMatchObject([{ file: "package/src/numbers.ts", start: { line: 1, column: 17 }, spanText: "format", excerpts: [{ line: 1, text: "export function format(value: number) { return value.toFixed(2); }" }] }]);
    const refs = await query(root, { action: "references", file: "package/src/numbers.ts", line: 1, column: 17 });
    expect(refs.results.some((item: { file: string }) => item.file.endsWith("use.ts"))).toBe(true);
    expect(refs.results.some((item: { file: string }) => item.file.endsWith("strings.ts"))).toBe(false);
    expect(refs.results.some((item: { spanText: string }) => item.spanText === "render")).toBe(true);
  }, 30_000);

  test("loads actual project references and refreshes disk/config edits", async () => {
    const root = await project({
      "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./package" }] }),
      "package/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, composite: true }, include: ["src"] }),
      "package/src/source.ts": "export const value = 'text';\n",
      "package/src/use.ts": "import { value } from './source';\nexport const count: number = value;\n",
    });
    const before = await query(root, { action: "diagnostics", file: "package/src/use.ts" });
    expect(before.project.config).toBe("package/tsconfig.json");
    expect(before.results.some((item: { code: number }) => item.code === 2322)).toBe(true);
    expect(before.results.find((item: { code: number }) => item.code === 2322)).toMatchObject({ kind: "semantic", severity: "error", start: { line: 2, column: 14 }, spanText: "count" });
    await writeFile(join(root, "package/src/source.ts"), "export const value = 42;\n");
    expect((await query(root, { action: "diagnostics", file: "package/src/use.ts" })).results).toEqual([]);
    await writeFile(join(root, "package/tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noUnusedLocals: true }, include: ["src"] }));
    await writeFile(join(root, "package/src/use.ts"), "import { value } from './source';\nexport const count = 1;\n");
    expect((await query(root, { action: "diagnostics", file: "package/src/use.ts" })).results.some((item: { code: number }) => item.code === 6133)).toBe(true);
  }, 45_000);

  test("stops source verification at the result limit and discloses uninspected entries", async () => {
    const fakeServer = `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line); if(q.command==='open')return;
 const entry=file=>({file:process.cwd()+file,start:{line:1,offset:14},end:{line:1,offset:19}});
 const body=q.command==='projectInfo'?{configFileName:process.cwd()+'/tsconfig.json'}:
 q.command==='compilerOptionsDiagnostics-full'?[]:
 q.command==='references'?{refs:[entry('/node_modules/library.ts'),entry('/src/main.ts'),entry('/src/missing.ts')]}:{};
 const text=JSON.stringify({type:'response',request_seq:q.seq,success:true,body});
 process.stdout.write('Content-Length: '+Buffer.byteLength(text)+'\\r\\n\\r\\n'+text);
});`;
    const root = await project({ "package.json": JSON.stringify({ name: "typescript", version: "5.9.3", type: "module" }),
      "tsconfig.json": config, "lib/tsserver.js": fakeServer, "src/main.ts": "export const value = 1;\n",
      "node_modules/library.ts": "export const value = 2;\n" });
    await symlink(createRequire(import.meta.url).resolve("typescript"), join(root, "lib/typescript.js"));
    let pid = 0;
    const options = { serverPath: join(root, "lib/tsserver.js"), maxResults: 1, onSpawn: (value: number) => pid = value };
    const result = await query(root, { action: "references", file: "src/main.ts", line: 1, column: 14 }, options);
    gone(pid);
    expect(result.results).toMatchObject([{ file: "src/main.ts", spanText: "value" }]);
    expect(result).toMatchObject({ excludedLibraries: 1, uninspectedResults: 1, incomplete: true });
    // Entries inside the requested verification window still fail if their source is missing.
    await expect(query(root, { action: "references", file: "src/main.ts", line: 1, column: 14 }, { ...options, maxResults: 2 })).rejects.toThrow();
    gone(pid);
  }, 10_000);

  test("verifies UTF-16 positions and bounds output without replacing source text", async () => {
    const text = 'export const value = 1;\nconst emoji = "😀"; export const use = value;\n' + Array.from({ length: 100 }, (_, i) => `export const item${i} = value;`).join("\n");
    const root = await project({ "tsconfig.json": config, "src/main.ts": text });
    const result = await query(root, { action: "references", file: "src/main.ts", line: 1, column: 14 }, { maxOutputBytes: 2_048 });
    expect(result.results.some((item: { start: { line: number }; spanText: string; excerpts: Array<{ text: string }> }) => item.start.line === 2 && item.spanText === "value" && item.excerpts[0]?.text.includes("😀"))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2_048);
    expect(result.omitted).toBeGreaterThan(0);
    expect(result.results.length + result.omitted + result.uninspectedResults).toBe(102);
    expect(result.uninspectedResults).toBe(2);
    expect(result.incomplete).toBe(true);
    await expect(query(root, { action: "definition", file: "src/main.ts", line: 2, column: 17 })).rejects.toThrow("surrogate");
  }, 20_000);

  test("warns about invalid config while rejecting unresolved diagnostics and workspace escapes", async () => {
    const root = await project({ "src/main.ts": "export const value = 1;\n" });
    const outside = await project({ "outside.ts": "export const secret = 1;\n" });
    await symlink(join(outside, "outside.ts"), join(root, "src/escape.ts"));
    for (const file of ["../outside.ts", join(outside, "outside.ts"), "src/escape.ts"]) await expect(query(root, { action: "diagnostics", file })).rejects.toThrow("workspace");
    await expect(query(root, { action: "diagnostics", file: "src/main.ts" })).rejects.toThrow("inferred");
    const inferred = await query(root, { action: "definition", file: "src/main.ts", line: 1, column: 14 });
    expect(inferred.project.inferred).toBe(true);
    await writeFile(join(root, "tsconfig.json"), "{ bad config");
    const warned = await query(root, { action: "diagnostics", file: "src/main.ts" });
    expect(warned.project.warningCount).toBeGreaterThan(0);
    expect(warned.project.warnings[0].message.length).toBeGreaterThan(0);
  }, 30_000);

  test("counts library exclusions and returns syntax diagnostics with exact target spans", async () => {
    const root = await project({ "tsconfig.json": config, "src/main.ts": "export const value = Math.max(1, 2);\n" });
    const definition = await query(root, { action: "definition", file: "src/main.ts", line: 1, column: 27 });
    expect(definition.results).toEqual([]);
    expect(definition.excludedLibraries).toBeGreaterThan(0);
    expect(definition.incomplete).toBe(true);
    await writeFile(join(root, "src/main.ts"), "export const value = ;\n");
    const diagnostics = await query(root, { action: "diagnostics", file: "src/main.ts" });
    expect(diagnostics.results.some((item: { kind: string; code: number }) => item.kind === "syntax" && item.code === 1109)).toBe(true);
  }, 20_000);

  test("handles open without acknowledgement, drains private stderr, rejects invalid spans and awaits exit", async () => {
    const fakeServer = `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);
 if(q.command==='open')return; // TS 5.0 official handler does not acknowledge open.
 const body=q.command==='projectInfo'?{configFileName:process.cwd()+'/tsconfig.json'}:
 q.command==='compilerOptionsDiagnostics-full'?[]:
 q.command==='definition'?[{file:process.cwd()+'/src/main.ts',start:{line:1,offset:14},end:{line:999,offset:1}}]:{};
 const text=JSON.stringify({type:'response',request_seq:q.seq,success:true,body});
 process.stderr.write('stderr-private-source\\n'.repeat(16384),()=>{
   process.stdout.write('Content-Length: '+Buffer.byteLength(text)+'\\r\\n\\r\\n'+text);
 });
});`;
    const root = await project({ "package.json": JSON.stringify({ name: "typescript", version: "5.9.3", type: "module" }), "tsconfig.json": config, "lib/tsserver.js": fakeServer, "src/main.ts": "export const value = 1;\n" });
    await symlink(createRequire(import.meta.url).resolve("typescript"), join(root, "lib/typescript.js"));
    let pid = 0;
    await expect(query(root, { action: "definition", file: "src/main.ts", line: 1, column: 14 }, { serverPath: join(root, "lib/tsserver.js"), onSpawn: value => pid = value })).rejects.toThrow("outside current source");
    gone(pid);
    const validServer = fakeServer.replace("end:{line:999,offset:1}", "end:{line:1,offset:19},unverified:true");
    await writeFile(join(root, "lib/tsserver.js"), validServer);
    const uncertain = await query(root, { action: "definition", file: "src/main.ts", line: 1, column: 14 }, { serverPath: join(root, "lib/tsserver.js"), onSpawn: value => pid = value });
    gone(pid);
    expect(uncertain.results).toMatchObject([{ spanText: "value", unverified: true }]);
    expect(uncertain.unverifiedResults).toBe(1);
    expect(uncertain.incomplete).toBe(true);
    expect(JSON.stringify(uncertain)).not.toContain("stderr-private-source");
    const malformedServer = validServer.replace("+text);", "+text+(q.command==='definition'?'bad-header\\r\\n\\r\\n':''));");
    await writeFile(join(root, "lib/tsserver.js"), malformedServer);
    await expect(query(root, { action: "definition", file: "src/main.ts", line: 1, column: 14 }, { serverPath: join(root, "lib/tsserver.js"), onSpawn: value => pid = value })).rejects.toThrow("Invalid tsserver protocol");
    gone(pid);
    for (const version of ["4.8.4", "7.0.0", "5.9.3-dev.1"]) {
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "typescript", version, type: "module" }));
      pid = 0;
      await expect(query(root, { action: "definition", file: "src/main.ts", line: 1, column: 14 }, { serverPath: join(root, "lib/tsserver.js"), onSpawn: value => pid = value })).rejects.toThrow("Unsupported TypeScript");
      expect(pid).toBe(0);
    }
  }, 10_000);

  test("rejects effective inherited plugins before process spawn", async () => {
    const root = await project({ "base.json": JSON.stringify({ compilerOptions: { plugins: [{ name: "some-plugin" }] } }), "tsconfig.json": JSON.stringify({ extends: "./base.json", include: ["src"] }), "src/main.ts": "export const value = 1;\n" });
    let pid = 0;
    await expect(query(root, { action: "diagnostics", file: "src/main.ts" }, { onSpawn: value => pid = value })).rejects.toThrow("plugins are unsupported");
    expect(pid).toBe(0);
  });

  test("honors pre-abort, cancellation and initialization deadline and awaits process exit", async () => {
    const root = await project({ "tsconfig.json": config, "src/main.ts": "export const value = 1;\n" });
    let pid = 0;
    await expect(query(root, { action: "diagnostics", file: "src/main.ts" }, { onSpawn: value => pid = value }, AbortSignal.abort())).rejects.toThrow();
    expect(pid).toBe(0);
    const controller = new AbortController();
    await expect(query(root, { action: "diagnostics", file: "src/main.ts" }, { onSpawn: value => { pid = value; controller.abort(); } }, controller.signal)).rejects.toThrow();
    gone(pid);
    pid = 0;
    await expect(query(root, { action: "diagnostics", file: "src/main.ts" }, { timeoutMs: 50, onSpawn: value => pid = value })).rejects.toThrow("timed out");
    if (pid) gone(pid);
  }, 10_000);
});

describe("session-owned tsserver", () => {
  async function persistentProject(files: Record<string, string>, options: TsserverOptions = {}) {
    const root = await project({ "tsconfig.json": config, ...files });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), join(root, "node_modules/typescript"));
    return { root, tool: createProjectTsserverTool(root, { allowHarnessFallback: false, persistent: true, ...options }) };
  }
  async function execute(tool: ReturnType<typeof createTsserverTool>, input: Parameters<typeof tool.execute>[1], signal?: AbortSignal) {
    const result = await tool.execute("query", input, signal, undefined, {} as never);
    return JSON.parse((result.content[0] as { text: string }).text);
  }

  test("BOM files keep exact compiler positions across closed imports, open queries and reuse", async () => {
    const dependency = "\uFEFFexport function value() { return 1; }\r\n";
    const main = '\uFEFFimport { value } from "./dependency";\r\nexport const answer: number = value();\r\n';
    const broken = '\uFEFFexport const invalid: number = "wrong"; // 😀\r\nexport const another: boolean = 1;\r\n';
    const pids: number[] = [];
    const { root, tool } = await persistentProject({ "src/main.ts": main, "src/dependency.ts": dependency, "src/broken.ts": broken }, { onSpawn: pid => pids.push(pid) });
    try {
      const fromImport = await execute(tool, { action: "definition", file: "src/main.ts", ...at(main, "value();") });
      expect(fromImport.results).toMatchObject([{ file: "src/dependency.ts", start: { line: 1, column: 17 }, spanText: "value" }]);
      const opened = await execute(tool, { action: "definition", file: "src/dependency.ts", ...at(dependency.slice(1), "value()") });
      expect(opened.results).toEqual(fromImport.results);
      const references = await execute(tool, { action: "references", file: "src/dependency.ts", ...at(dependency.slice(1), "value()") });
      expect(references.results.every((item: { spanText: string }) => item.spanText === "value")).toBe(true);
      expect(references.results).toContainEqual(expect.objectContaining({ file: "src/main.ts", start: { line: 1, column: 10 } }));
      const implementations = await execute(tool, { action: "implementation", file: "src/dependency.ts", ...at(dependency.slice(1), "value()") });
      expect(implementations.results).toMatchObject([{ spanText: "value", start: { line: 1, column: 17 } }]);
      const diagnostics = await execute(tool, { action: "diagnostics", file: "src/broken.ts" });
      expect(diagnostics.results).toMatchObject([
        { code: 2322, spanText: "invalid", start: { line: 1, column: 14 } },
        { code: 2322, spanText: "another", start: { line: 2, column: 14 } },
      ]);
      expect(diagnostics.target.sha256).toBe(createHash("sha256").update(broken).digest("hex"));
      expect(pids).toHaveLength(1);
      await writeFile(join(root, "src/dependency.ts"), dependency.slice(1));
      const withoutBom = await execute(tool, { action: "definition", file: "src/main.ts", ...at(main, "value();") });
      expect(withoutBom.results).toEqual(fromImport.results);
      expect(pids).toHaveLength(1);
    } finally { await tool.dispose(); }
    for (const pid of pids) gone(pid);
  }, 20_000);

  test("reuses the server across serialized callers and refreshes open files, closed imports, new files and config", async () => {
    const pids: number[] = [];
    const { root, tool } = await persistentProject({
      "src/main.ts": 'import { value } from "./dependency";\nexport const answer: number = value;\n',
      "src/dependency.ts": "export const value = 10;\n",
    }, { onSpawn: pid => pids.push(pid) });
    const diagnostic = { action: "diagnostics", file: "src/main.ts" } as const;
    try {
      expect((await execute(tool, diagnostic)).results).toEqual([]);
      const unchanged = await Promise.all([execute(tool, diagnostic), execute(tool, diagnostic)]);
      expect(unchanged.every(result => result.results.length === 0)).toBe(true);
      expect(pids).toHaveLength(1);
      await writeFile(join(root, "src/dependency.ts"), 'export const value = "x";\n');
      expect((await execute(tool, diagnostic)).results.some((item: { code: number }) => item.code === 2322)).toBe(true);
      await writeFile(join(root, "src/main.ts"), 'import { value } from "./dependency";\nexport const answer: string = value;\n');
      expect((await execute(tool, diagnostic)).results).toEqual([]);
      // A new file reaches the reused server, and excluding it takes it away.
      await writeFile(join(root, "src/added.ts"), 'import { value } from "./dependency";\nexport const added: number = value;\n');
      const addedDiagnostic = { action: "diagnostics", file: "src/added.ts" } as const;
      expect((await execute(tool, addedDiagnostic)).results.some((item: { code: number }) => item.code === 2322)).toBe(true);
      expect(pids).toHaveLength(1);
      await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { plugins: [{ name: "forbidden-plugin" }] }, include: ["src"] }));
      await expect(execute(tool, diagnostic)).rejects.toThrow("plugins are unsupported");
      gone(pids[0]!);
    } finally { await tool.dispose(); }
  }, 30_000);

  test("keeps separate configured project owners when moving between packages", async () => {
    const pids: number[] = [];
    const { root, tool } = await persistentProject({
      "first/tsconfig.json": JSON.stringify({ files: ["main.ts"] }), "first/main.ts": "export const first = 1;\n",
      "second/tsconfig.json": JSON.stringify({ files: ["main.ts"] }), "second/main.ts": "export const second = 2;\n",
      "node_modules/marker-plugin/package.json": JSON.stringify({ name: "marker-plugin", main: "index.js" }),
      "node_modules/marker-plugin/index.js": `require("node:fs").writeFileSync(require("node:path").join(process.cwd(), "plugin-executed"), "unexpected"); module.exports = () => ({create: info => info.languageService});`,
    }, { onSpawn: pid => pids.push(pid) });
    try {
      for (const file of ["first/main.ts", "second/main.ts", "first/main.ts", "second/main.ts"]) {
        const result = await execute(tool, { action: "diagnostics", file });
        expect(result.results).toEqual([]);
        expect(result.project.config).toBe(file.replace("main.ts", "tsconfig.json"));
      }
      expect(pids).toHaveLength(2);
      await writeFile(join(root, "first/tsconfig.json"), JSON.stringify({ files: ["main.ts"], compilerOptions: { plugins: [{ name: "marker-plugin" }] } }));
      await writeFile(join(root, "second/main.ts"), "export const second = 3;\n");
      expect((await execute(tool, { action: "diagnostics", file: "second/main.ts" })).results).toEqual([]);
      await expect(access(join(root, "plugin-executed"))).rejects.toThrow();
      await expect(execute(tool, { action: "diagnostics", file: "first/main.ts" })).rejects.toThrow("plugins are unsupported");
      await expect(access(join(root, "plugin-executed"))).rejects.toThrow();
    } finally { await tool.dispose(); }
    for (const pid of pids) gone(pid);
  }, 15_000);

  test("refreshes package type entry points when source files and tsconfig are unchanged", async () => {
    const { root, tool } = await persistentProject({
      "src/main.ts": 'import { value } from "library";\nexport const answer: number = value;\n',
      "node_modules/library/package.json": JSON.stringify({ name: "library", version: "1.0.0", types: "number.d.ts" }),
      "node_modules/library/number.d.ts": "export declare const value: number;\n",
      "node_modules/library/string.d.ts": "export declare const value: string;\n",
    });
    const input = { action: "diagnostics", file: "src/main.ts" } as const;
    try {
      expect((await execute(tool, input)).results).toEqual([]);
      expect((await execute(tool, input)).results).toEqual([]);
      await writeFile(join(root, "node_modules/library/package.json"), JSON.stringify({ name: "library", version: "1.0.0", types: "string.d.ts" }));
      expect((await execute(tool, input)).results.some((item: { code: number }) => item.code === 2322)).toBe(true);
    } finally { await tool.dispose(); }
  }, 15_000);

  test("discovers a previously missing dependency added below an existing watched directory", async () => {
    const { root, tool } = await persistentProject({
      "src/main.ts": 'import { value } from "library/lib/entry";\nexport const answer: number = value;\n',
      "node_modules/library/package.json": JSON.stringify({ name: "library", version: "1.0.0" }),
    });
    await mkdir(join(root, "node_modules/library/lib"));
    const input = { action: "diagnostics", file: "src/main.ts" } as const;
    try {
      for (let i = 0; i < 3; i++) expect((await execute(tool, input)).results.some((item: { code: number }) => item.code === 2307)).toBe(true);
      await writeFile(join(root, "node_modules/library/lib/entry.d.ts"), "export declare const value: number;\n");
      expect((await execute(tool, input)).results).toEqual([]);
    } finally { await tool.dispose(); }
  }, 15_000);

  test("a throwing spawn observer cannot orphan its server", async () => {
    let pid = 0;
    const { tool } = await persistentProject({ "src/main.ts": "export const value = 1;\n" }, {
      onSpawn: value => { pid = value; throw new Error("observer failed"); },
    });
    try { await expect(execute(tool, { action: "diagnostics", file: "src/main.ts" })).rejects.toThrow("observer failed"); }
    finally { await tool.dispose(); }
    gone(pid);
  });

  test("configuration warnings stay actionable across reuse and missing references do not block navigation", async () => {
    const { root, tool } = await persistentProject({ "src/main.ts": "export const value = 1;\n" });
    try {
      await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { unknownOption: true },
        references: [{ path: "./missing-project" }], include: ["src"] }));
      for (let i = 0; i < 3; i++) {
        const result = await execute(tool, { action: "definition", file: "src/main.ts", line: 1, column: 14 });
        expect(result.results[0].spanText).toBe("value");
        expect(result.project.warnings.some((warning: { code: number }) => warning.code === 5023)).toBe(true);
        expect(result.project.warnings.length).toBeLessThanOrEqual(3);
      }
    } finally { await tool.dispose(); }
  }, 15_000);

  test("an oversized persistent source inventory falls back to one ephemeral query", async () => {
    const script = `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
  const q=JSON.parse(line),root=process.cwd(); if(['open','close','reloadProjects'].includes(q.command))return;
  let body=q.command==='projectInfo'?{configFileName:root+'/tsconfig.json',...(q.arguments.needFileNameList?{fileNames:Array(50001).fill(root+'/src/main.ts')}:{})}:
    ['compilerOptionsDiagnostics-full','syntacticDiagnosticsSync','semanticDiagnosticsSync'].includes(q.command)?[]:{};
  const text=JSON.stringify({type:'response',request_seq:q.seq,success:true,body});
  process.stdout.write('Content-Length: '+Buffer.byteLength(text)+'\\r\\n\\r\\n'+text);
});`;
    const root = await project({ "package.json": JSON.stringify({ name: "typescript", version: "5.9.3", type: "module" }),
      "tsconfig.json": config, "lib/tsserver.js": script, "src/main.ts": "export const value = 1;\n" });
    await symlink(createRequire(import.meta.url).resolve("typescript"), join(root, "lib/typescript.js"));
    const pids: number[] = [], tool = createTsserverTool(root, { persistent: true, serverPath: join(root, "lib/tsserver.js"), onSpawn: pid => pids.push(pid) });
    try {
      expect((await execute(tool, { action: "diagnostics", file: "src/main.ts" })).results).toEqual([]);
      expect(pids).toHaveLength(2);
      for (const pid of pids) gone(pid);
    } finally { await tool.dispose(); }
  }, 10_000);

  test("a closed source changed during a query invalidates the cached project instead of accepting a new disk signature", async () => {
    const script = `import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync} from 'node:fs';
createInterface({input:process.stdin}).on('line',line=>{
  const q=JSON.parse(line),root=process.cwd(); if(['open','close','reloadProjects'].includes(q.command))return;
  let body=q.command==='projectInfo'?{configFileName:root+'/tsconfig.json',fileNames:[root+'/src/main.ts',root+'/src/dependency.ts']}:
    ['compilerOptionsDiagnostics-full','syntacticDiagnosticsSync','semanticDiagnosticsSync'].includes(q.command)?[]:{};
  if(q.command==='syntacticDiagnosticsSync'){
    const path=root+'/src/dependency.ts',before=readFileSync(path,'utf8');
    if(!before.includes('changed'))writeFileSync(path,before+'// changed\\n');
  }
  const text=JSON.stringify({type:'response',request_seq:q.seq,success:true,body});
  process.stdout.write('Content-Length: '+Buffer.byteLength(text)+'\\r\\n\\r\\n'+text);
});`;
    const root = await project({ "package.json": JSON.stringify({ name: "typescript", version: "5.9.3", type: "module" }),
      "tsconfig.json": config, "lib/tsserver.js": script, "src/main.ts": "export const value = 1;\n", "src/dependency.ts": "export const other = 1;\n" });
    await symlink(createRequire(import.meta.url).resolve("typescript"), join(root, "lib/typescript.js"));
    const pids: number[] = [], tool = createTsserverTool(root, { persistent: true, serverPath: join(root, "lib/tsserver.js"), onSpawn: pid => pids.push(pid) });
    try {
      await expect(execute(tool, { action: "diagnostics", file: "src/main.ts" })).rejects.toThrow("Project source changed during the query");
      gone(pids[0]!);
      expect((await execute(tool, { action: "diagnostics", file: "src/main.ts" })).results).toEqual([]);
      expect(pids).toHaveLength(2);
    } finally { await tool.dispose(); }
    for (const pid of pids) gone(pid);
  }, 10_000);

  test("cancellation invalidates the server, the next call recovers, and disposal rejects queued and future work", async () => {
    const canceled = new AbortController(), pids: number[] = [];
    const { tool } = await persistentProject({ "src/main.ts": "export const value = 1;\n" }, {
      onSpawn: pid => { pids.push(pid); if (pids.length === 1) canceled.abort(); },
    });
    const input = { action: "diagnostics", file: "src/main.ts" } as const;
    try {
      await expect(execute(tool, input, canceled.signal)).rejects.toThrow();
      gone(pids[0]!);
      expect((await execute(tool, input)).results).toEqual([]);
      expect(pids).toHaveLength(2);
      const first = execute(tool, input), queued = execute(tool, input);
      const rejected = Promise.allSettled([first, queued]);
      await tool.dispose();
      expect((await rejected).every(result => result.status === "rejected")).toBe(true);
      for (const pid of pids) gone(pid);
      await expect(execute(tool, input)).rejects.toThrow("disposed");
      expect(pids).toHaveLength(2);
      await tool.dispose();
    } finally { await tool.dispose(); }
  }, 15_000);
});
