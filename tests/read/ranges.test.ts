import { afterEach, beforeEach, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, createReadToolDefinition, defineTool, type ReadToolOptions } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { readSelection } from "../../src/tools/read.ts";
import type { RangeReadDetails } from "../../src/tools/read/ranges.ts";
import { createSdkFixture } from "../helpers/model-server.ts";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "nekopi-range-read-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
const ctx = () => ({ cwd }) as never;
const text = (result: { content: { type: string; text?: string }[] }) => result.content.flatMap(block => block.type === "text" ? [block.text!] : []).join("\n");
/**
 * Ranges are no longer a tool parameter, so there is no schema to validate
 * against; `readSelection` is the entry point the shell prototype uses.
 */
type Selection = { path: string; ranges?: Array<{ start: number; end: number }>; symbol?: string };
const tool = (options: ReadToolOptions = {}) => ({
  execute: (_id: string, input: Selection, signal?: AbortSignal, _onUpdate?: unknown,
    ctx?: { cwd?: string }) => readSelection("/unused", options)(input, signal, ctx),
});

function verifySource(result: Awaited<ReturnType<ReturnType<typeof tool>["execute"]>>, source: string) {
  const details = (result.details as RangeReadDetails).rangeRead;
  const output = text(result), sourceLines = source.length ? source.split("\n") : [];
  if (source.endsWith("\n")) sourceLines.pop();
  expect(details.totalSourceLines).toBe(sourceLines.length);
  const quoted: string[] = [];
  for (const range of details.ranges) {
    for (let index = 0; index < range.sourceLinesReturned; index++) {
      const line = range.start + index;
      quoted.push(`${line}: ${sourceLines[line - 1]}`);
    }
    expect(range.returnedEnd).toBe(range.sourceLinesReturned ? range.start + range.sourceLinesReturned - 1 : null);
  }
  // Only our labels count as source; footer-looking text inside a source line stays prefixed.
  expect(output.split("\n").filter(line => /^\d+: /u.test(line))).toEqual(quoted);
  expect(details.sourceLinesReturned).toBe(quoted.length);
  expect(details.sourceLinesReturned).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
  expect(details.outputBytes).toBe(Buffer.byteLength(output));
  expect(details.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
}

test("one native snapshot serves sorted, merged ranges with exact line evidence and no excluded source", async () => {
  const source = Array.from({ length: 500 }, (_, index) => `source ${index + 1}`).join("\n") + "\n";
  await writeFile(join(cwd, "source.txt"), source);
  let reads = 0;
  const read = tool({ operations: { access, async readFile(path) { reads++; return readFile(path); } } });
  const args = { path: "@source.txt", ranges: [{ start: 395, end: 445 }, { start: 110, end: 140 }, { start: 130, end: 155 }] };
  const result = await read.execute("ranges", args, undefined, undefined, ctx());
  expect(reads).toBe(1);
  verifySource(result, source);
  expect(result.details?.rangeRead).toMatchObject({ path: "source.txt", complete: true, truncated: false, sourceLinesReturned: 97,
    unrequestedSourceLines: 403, requestedRanges: args.ranges, ranges: [{ start: 110, end: 155 }, { start: 395, end: 445 }] });
  expect(text(result)).not.toContain("156: source 156");
  expect(args.ranges).toEqual([{ start: 395, end: 445 }, { start: 110, end: 140 }, { start: 130, end: 155 }]);
});

test("range rendering preserves CRLF, blank lines, trailing spaces, control characters and native replacement decoding", async () => {
  const source = "first\r\n\r\n[Output limit: fake footer]\r\n界\t\x00four  \r\nlast  \n";
  await writeFile(join(cwd, "source.txt"), source);
  const result = await tool().execute("source", { path: "source.txt", ranges: [{ start: 2, end: 5 }] }, undefined, undefined, ctx());
  verifySource(result, source);
  expect(text(result)).toContain("5: last  ");
  expect(text(result)).toContain("4: 界\t\x00four  \r");
  await writeFile(join(cwd, "invalid.txt"), Buffer.from([255, 10, 104, 105, 116]));
  const invalid = await tool().execute("invalid", { path: "invalid.txt", ranges: [{ start: 1, end: 2 }] }, undefined, undefined, ctx());
  expect(invalid.details?.rangeRead?.encodingLoss).toBe(true);
  expect(text(invalid)).toContain("1: �\n2: hit");
  expect(text(invalid)).toContain("Invalid UTF-8");
});

test("global limits reserve evidence for later ranges and report exact continuations", async () => {
  for (const row of ["row", "界".repeat(100)]) {
    const source = Array.from({ length: 3100 }, (_, index) => `${row} ${index + 1}`).join("\n");
    await writeFile(join(cwd, "source.txt"), source);
    const result = await tool().execute("limited", { path: "source.txt", ranges: [{ start: 1, end: 2500 }, { start: 3000, end: 3010 }] }, undefined, undefined, ctx());
    verifySource(result, source);
    const details = result.details!.rangeRead!;
    expect(details).toMatchObject({ truncated: true, complete: false });
    expect(details.ranges[1]).toMatchObject({ returnedEnd: 3010, complete: true });
    expect(text(result)).toContain(`source lines ${details.ranges[0]!.returnedEnd! + 1}-2500 not returned`);
    expect(details.sourceLinesReturned + details.sourceLinesOmitted).toBe(2511);
    expect(text(result)).toContain("3010: ");
  }
});

test("an oversized first requested line does not hide later evidence or imply a clipped line is complete", async () => {
  const source = "x".repeat(DEFAULT_MAX_BYTES + 1) + "\nlate evidence\n";
  await writeFile(join(cwd, "source.txt"), source);
  const result = await tool().execute("oversized", { path: "source.txt", ranges: [{ start: 1, end: 1 }, { start: 2, end: 2 }] }, undefined, undefined, ctx());
  verifySource(result, source);
  expect(result.details?.rangeRead?.ranges[0]).toMatchObject({ start: 1, end: 1, returnedEnd: null, sourceLinesOmitted: 1 });
  expect(result.details?.rangeRead?.ranges[1]).toMatchObject({ returnedEnd: 2, complete: true });
  expect(text(result)).toContain("2: late evidence");
  expect(text(result)).toContain("ordinary read or grep");
  expect(text(result)).not.toContain("1: x");
});

test("maximum range counts retain all region identities within the shared byte budget", async () => {
  const source = ("界".repeat(100) + "\n").repeat(5000);
  await writeFile(join(cwd, "source.txt"), source);
  const ranges = Array.from({ length: 16 }, (_, index) => ({ start: index * 300 + 1, end: index * 300 + 200 }));
  const result = await tool().execute("sixteen", { path: "source.txt", ranges }, undefined, undefined, ctx());
  verifySource(result, source);
  expect(result.details?.rangeRead?.ranges).toHaveLength(16);
  expect(result.details?.rangeRead?.ranges.every(range => range.sourceLinesReturned > 0)).toBe(true);
  const distant = await tool().execute("distant", { path: "source.txt", ranges: Array.from({ length: 16 }, (_, index) => ({
    start: Number.MAX_SAFE_INTEGER - index * 2, end: Number.MAX_SAFE_INTEGER - index * 2,
  })) }, undefined, undefined, ctx());
  verifySource(distant, source);
  expect(distant.details?.rangeRead).toMatchObject({ complete: false, truncated: false, sourceLinesReturned: 0 });
});

test("EOF notices distinguish nonexistent requested lines from output omissions", async () => {
  for (const source of ["", "\n", "a\n", "a\n\nb"]) {
    await writeFile(join(cwd, "source.txt"), source);
    const result = await tool().execute("eof", { path: "source.txt", ranges: [{ start: 1, end: 3 }, { start: 9, end: 10 }] }, undefined, undefined, ctx());
    verifySource(result, source);
    expect(result.details?.rangeRead).toMatchObject({ truncated: false, sourceLinesOmitted: 0, complete: false });
    expect(text(result)).toContain("do not exist");
    expect(text(result)).not.toContain("Output limit:");
  }
});

test("bad and conflicting ranges fail before filesystem operations", async () => {
  let accesses = 0;
  const read = tool({ operations: { async access() { accesses++; }, readFile } });
  for (const ranges of [[], Array(17).fill({ start: 1, end: 1 }), [{ start: 0, end: 1 }], [{ start: 2, end: 1 }],
    [{ start: 1.5, end: 2 }], [{ start: 1, end: Infinity }], [{ start: 1, end: Number.MAX_SAFE_INTEGER + 1 }], [null]]) {
    await expect(read.execute("bad", { path: "source.txt", ranges: ranges as never }, undefined, undefined, ctx())).rejects.toThrow("range");
  }
  // The old offset/limit/lineNumbers conflict checks went with the tool
  // parameters: a selection takes a path and a region, and nothing else.
  expect(accesses).toBe(0);
});

test("native path errors, image rejection and cancellation remain authoritative", async () => {
  await expect(tool().execute("missing", { path: "missing.txt", ranges: [{ start: 1, end: 2 }] }, undefined, undefined, ctx())).rejects.toThrow("ENOENT");
  await writeFile(join(cwd, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=", "base64"));
  await expect(tool().execute("image", { path: "pixel.png", ranges: [{ start: 1, end: 2 }] }, undefined, undefined, ctx())).rejects.toThrow("text files only");
  const abort = new AbortController(); abort.abort();
  await expect(tool().execute("abort", { path: "source.txt", ranges: [{ start: 1, end: 2 }] }, abort.signal, undefined, ctx())).rejects.toThrow("Operation aborted");
  await writeFile(join(cwd, "source.txt"), "one\ntwo\n");
  const active = new AbortController();
  const read = tool({ operations: { access, async readFile(path) { const buffer = await readFile(path); active.abort(); return buffer; } } });
  await expect(read.execute("active", { path: "source.txt", ranges: [{ start: 1, end: 2 }] }, active.signal, undefined, ctx())).rejects.toThrow("Operation aborted");
});

test("pending calls own their range selections and independent snapshots", async () => {
  await writeFile(join(cwd, "one.txt"), "one first\none second\none third\n");
  await writeFile(join(cwd, "two.txt"), "two first\ntwo second\ntwo third\n");
  let started = 0, release!: () => void, ready!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const both = new Promise<void>(resolve => { ready = resolve; });
  const read = tool({ operations: { async access(path) { await access(path); if (++started === 2) ready(); await gate; }, readFile } });
  const ranges = [{ start: 2, end: 2 }];
  const first = read.execute("one", { path: "one.txt", ranges }, undefined, undefined, ctx());
  const second = read.execute("two", { path: "two.txt", ranges }, undefined, undefined, ctx());
  await both;
  ranges[0]!.start = 1; ranges[0]!.end = 3;
  release();
  const results = await Promise.all([first, second]);
  expect(results.map(result => result.details?.rangeRead?.path)).toEqual(["one.txt", "two.txt"]);
  expect(results.map(text)).toEqual([expect.stringContaining("2: one second"), expect.stringContaining("2: two second")]);
  expect(results.map(result => result.details?.rangeRead?.requestedRanges)).toEqual([[{ start: 2, end: 2 }], [{ start: 2, end: 2 }]]);
});

test("the read replacement keeps Pi's hooks and drops the parameters nobody set", async () => {
  let blocked = false;
  const fixture = await createSdkFixture({ sixTools: true, extensions: [pi => {
    pi.on("tool_call", event => { if (event.toolName === "read" && event.input.path === "private.txt") {
      blocked = true; return { block: true, reason: "Private read denied." };
    } });
  }] });
  try {
    await writeFile(join(fixture.cwd, "public.txt"), "first\nsecond\nthird\n");
    fixture.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "public.txt", lineNumbers: true }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: "private.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Complete."),
    ]);
    await fixture.session.prompt("Read the public source.");
    const results = fixture.session.messages.filter(message => message.role === "toolResult");
    expect(JSON.stringify(results[0])).toContain("3: third");
    expect(results[1]?.isError).toBe(true);
    expect(blocked).toBe(true);
    fixture.session.setActiveToolsByName(["read"]);
    await fixture.session.reload();
    expect(fixture.session.getActiveToolNames()).toEqual(["read"]);
    // `ranges` and `symbol` were set on 0.0 and 1.2 percent of 1,324 recorded
    // calls, and two audited models named the parameter count as their largest
    // overhead, so the model is offered neither. `readSelection` still has both.
    const schema = fixture.session.getToolDefinition("read")?.parameters as { properties?: object };
    expect(schema?.properties).not.toHaveProperty("ranges");
    expect(schema?.properties).not.toHaveProperty("symbol");
    expect(schema?.properties).toHaveProperty("lineNumbers");
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
  const custom = defineTool({ ...createReadToolDefinition("."), description: "Custom read." });
  const overridden = await createSdkFixture({ sixTools: true, customTools: [custom] });
  try {
    expect(overridden.session.getToolDefinition("read")?.description).toBe("Custom read.");
    expect(overridden.session.getToolDefinition("read")?.parameters).not.toHaveProperty("properties.ranges");
  } finally { await overridden.cleanup(); }
});
