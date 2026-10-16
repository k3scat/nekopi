import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFindToolDefinition, createReadOnlyTools, defineTool } from "@earendil-works/pi-coding-agent";
import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import { createSourceTools } from "../../src/source-tools.ts";
import type { SearchDetails } from "../../src/tools/search.ts";

test("the source tool set is search plus the native find definition", () => {
  const tools = createSourceTools(".");
  expect(tools.map(tool => tool.name)).toEqual(["grep", "find"]);
  const { execute: _nativeExecute, ...nativeFind } = defineTool(createFindToolDefinition("."));
  const { execute: _findExecute, ...find } = tools.find(tool => tool.name === "find")!;
  expect(find).toEqual(nativeFind);
});

test("enhanced search preserves native optional arguments", () => {
  const native = createReadOnlyTools(".").find(tool => tool.name === "grep")!;
  const tool = createSourceTools(".")[0]!;
  const required = (schema: unknown) => (schema as { required?: string[] }).required;
  expect(required(tool.parameters)).toEqual(required(native.parameters)!);
  for (const outputMode of ["content", "files"]) {
    for (const scope of [{}, { path: ["src", "tests"], glob: ["*.{ts,tsx}", "!**/*.generated.ts"] }] as JsonObject[]) {
      const args = { pattern: "needed", outputMode, ...scope, ...(outputMode === "content" ? { maxMatchesPerFile: 2 } : {}) };
      expect(validateToolArguments(tool, { type: "toolCall", id: "default-scope", name: "grep", arguments: args })).toEqual(args);
    }
  }
});

test("search preserves late Unicode matches and original byte coordinates", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nekopi-source-tools-"));
  const prefix = "前🙂".repeat(400), needle = "NEEDLE界🙂", source = prefix + needle + "終".repeat(200);
  try {
    await writeFile(join(cwd, "unicode.txt"), source + "\n");
    const tool = createSourceTools(cwd).find(tool => tool.name === "grep")!;
    const result = await tool.execute("late-match", { pattern: needle, path: "unicode.txt", literal: true }, undefined, undefined, { cwd } as never);
    expect(result.isError).not.toBe(true);
    const details = result.details as SearchDetails;
    expect(details).toMatchObject({ scanComplete: true, omittedSpans: 0, omittedMatchingLines: 0 });
    expect(details.rows).toHaveLength(1);
    const row = details.rows[0]!;
    expect(row).toMatchObject({ path: "unicode.txt", line: 1, sourceBytes: Buffer.byteLength(source), encodingLoss: false,
      matches: [{ start: Buffer.byteLength(prefix), end: Buffer.byteLength(prefix + needle) }] });
    const visible = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    expect(visible).toContain(needle);
    // A clipped window keeps the exact source bytes and marks both omitted sides.
    for (const span of row.excerpts) {
      expect(span.text).toBe(Buffer.from(source).subarray(span.start, span.end).toString("utf8"));
      expect(visible).toContain(row.path);
      expect(visible).toContain(`  ${row.line}: …${span.text}…`);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
