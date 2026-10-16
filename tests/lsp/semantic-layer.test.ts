import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createSemanticLayer } from "../../src/tools/lsp.ts";

/**
 * The layer answering for TypeScript with no language server installed.
 *
 * These were registration tests while `lsp` was a tool the model chose. The
 * tool is gone and the behaviour is not: `edit` and `write` report diagnostics
 * through this path, and `/nekopi lsp` reports what a workspace has.
 */
async function typescriptProject(files: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "nekopi-layer-"));
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, "node_modules"), { recursive: true });
  await symlink(dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
    join(cwd, "node_modules/typescript"));
  await writeFile(join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
  for (const [path, content] of Object.entries(files)) await writeFile(join(cwd, path), content);
  return cwd;
}

async function withLayer<T>(cwd: string, body: (layer: ReturnType<typeof createSemanticLayer>) => Promise<T>): Promise<T> {
  const layer = createSemanticLayer(cwd);
  try { return await body(layer); } finally {
    await layer.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.flatMap(block => block.type === "text" ? [block.text ?? ""] : []).join("\n");

test("the layer answers TypeScript through the project compiler with no server installed", async () => {
  const cwd = await typescriptProject({
    "src/contract.ts": "export interface Loader { load(): number }\n",
    "src/store.ts": 'import { Loader } from "./contract.ts";\nexport class Store implements Loader { load() { return 42; } }\n',
  });
  await withLayer(cwd, async layer => {
    // The name resolved through tree-sitter; the answer came from the compiler.
    const result = await layer.query({ action: "implementation", file: "src/contract.ts", symbol: "Loader/load" });
    expect(textOf(result)).toContain("src/store.ts");
    expect(result.details.server).toBe("project tsserver");
  });
}, 30_000);

test("the fallback finds every reference, and diagnostics report through it", async () => {
  const cwd = await typescriptProject({
    "src/a.ts": "export function target() { return 1; }\nexport const used = target();\n",
    "src/bad.ts": "export const value: number = 'wrong';\n",
  });
  await withLayer(cwd, async layer => {
    const references = await layer.query({ action: "references", file: "src/a.ts", symbol: "target" });
    expect(textOf(references)).toContain("src/a.ts:1:17");
    expect(textOf(references)).toContain("src/a.ts:2:21");
    // `edit` and `write` report the diagnostics they introduce; the model never asks.
    expect(await layer.diagnose("src/bad.ts")).toContain("src/bad.ts");
  });
}, 30_000);

test("a workspace with no TypeScript installation reports one actionable line", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nekopi-layer-"));
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "tsconfig.json"), "{}");
  await writeFile(join(cwd, "src/a.ts"), "export function target() { return 1; }\n");
  await withLayer(cwd, async layer => {
    // No server and no project compiler is a degraded state, not a failure.
    const result = await layer.query({ action: "references", file: "src/a.ts", symbol: "target" });
    expect(textOf(result)).toContain("No language server for typescript");
    expect(result.details.results).toBe(0);
  });
}, 30_000);
