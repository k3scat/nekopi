import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runNekocli } from "../../src/nekocli.ts";
import { declarationsOf, describeDeclarations } from "../../src/tools/read/declarations.ts";

test("a timed out declaration search reports an unknown result", async () => {
  const signal = AbortSignal.abort(new DOMException("Timed out", "TimeoutError"));
  const found = await declarationsOf(tmpdir(), "needle", signal);
  const message = describeDeclarations("needle", found);
  expect(found.failed).toBe(true);
  expect(message).toContain("Search timed out");
  expect(message).toContain("Could not determine where \"needle\" is declared");
  expect(message).toContain("nek grep -F 'needle' --files");
  expect(message).not.toContain("appears nowhere");
});

test("a search error exits nonzero instead of reporting an absent declaration", async () => {
  const missing = join(tmpdir(), `nekopi-missing-${randomUUID()}`);
  const found = await declarationsOf(missing, "needle");
  expect(found.failed).toBe(true);
  expect(describeDeclarations("needle", found)).toContain("Search failed");
  const result = await runNekocli(["read", "--symbol", "needle"], missing);
  expect(result.failed).toBe(true);
  expect(result.text).toContain("Could not determine where \"needle\" is declared");
  expect(result.text).not.toContain("appears nowhere");
});

test("a declaration search capped at 24 files reports its limited scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "nekopi-declarations-"));
  try {
    await mkdir(join(root, "src"));
    await Promise.all(Array.from({ length: 25 }, (_, index) => writeFile(
      join(root, "src", `use-${String(index).padStart(2, "0")}.ts`),
      `export const value${index} = needle;\n`,
    )));
    const found = await declarationsOf(root, "needle");
    const message = describeDeclarations("needle", found);
    expect(found.seen).toHaveLength(24);
    expect(found.capped).toBe(true);
    expect(found.failed).toBeUndefined();
    expect(message).toContain("No declaration of \"needle\" found in 24 checked file(s)");
    expect(message).toContain("more may exist");
    expect(message).toContain("--limit 100");
    expect(message).not.toContain("in the workspace");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);

test("an exact workspace declaration takes priority over a near name in the requested file", async () => {
  const root = await mkdtemp(join(tmpdir(), "nekopi-declarations-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "jv.c"),
      "int jv_getpath(void) { return 1; }\nint use(void) { return jv_get(); }\n");
    await writeFile(join(root, "src", "jv_aux.c"), "int jv_get(void) { return 2; }\n");
    const result = await runNekocli(["read", "src/jv.c", "--symbol", "jv_get"], root)
      .then(() => "resolved", (error: Error) => error.message);
    expect(result).toContain("jv_get is declared in 1 place(s):\n  src/jv_aux.c:1");
    expect(result).not.toContain("Did you mean jv_getpath?");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);

test("a near name keeps the scope limit when an exact declaration cannot be ruled out", async () => {
  const root = await mkdtemp(join(tmpdir(), "nekopi-declarations-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "jv.c"), "int jv_getpath(void) { return jv_get(); }\n");
    await Promise.all(Array.from({ length: 25 }, (_, index) => writeFile(
      join(root, "src", `use-${String(index).padStart(2, "0")}.c`),
      "int use(void) { return jv_get(); }\n",
    )));
    const result = await runNekocli(["read", "src/jv.c", "--symbol", "jv_get"], root)
      .then(() => "resolved", (error: Error) => error.message);
    expect(result).toContain("Did you mean jv_getpath?");
    expect(result).toContain("more may exist");
    expect(result).not.toContain("appears nowhere");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);

test("workspace symbol lookup ignores build output without Git metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "nekopi-declarations-"));
  try {
    await mkdir(join(root, "dist"));
    await writeFile(join(root, ".gitignore"), "dist/\n");
    await writeFile(join(root, "source.ts"), "export function needle() { return 1; }\n");
    await writeFile(join(root, "dist", "source.js"), "export function needle() { return 1; }\n");
    const result = await runNekocli(["read", "--symbol", "needle"], root);
    expect(result.failed).toBeUndefined();
    expect(result.text).toContain("export function needle()");
    expect(result.text).toContain("source.ts");
    expect(result.text).not.toContain("dist/source.js");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("matching files without a grammar keep declaration coverage incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "nekopi-declarations-"));
  try {
    await writeFile(join(root, "notes.md"), "needle\n");
    const found = await declarationsOf(root, "needle");
    const message = describeDeclarations("needle", found);
    expect(found.incomplete).toContain("could not be parsed");
    expect(message).toContain("No declaration of \"needle\" found in 1 checked file(s)");
    expect(message).not.toContain("No declaration of \"needle\" in the workspace");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);
