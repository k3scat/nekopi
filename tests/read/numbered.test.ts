import { afterEach, beforeEach, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createReadToolDefinition, DEFAULT_MAX_BYTES, type ReadToolOptions } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createNumberedReadToolDefinition, type NumberedReadDetails } from "../../src/tools/read/numbered.ts";
import { createSearchTool } from "../../src/tools/search.ts";
import { createReadBufferTool } from "../../src/tools/read.ts";
import { createSdkFixture } from "../helpers/model-server.ts";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "nekopi-numbered-read-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
const ctx = () => ({ cwd }) as never;
const text = (result: { content: { type: string; text?: string }[] }) => result.content.flatMap(block => block.type === "text" ? [block.text!] : []).join("\n");

function verifySource(result: { content: { type: string; text?: string }[]; details?: NumberedReadDetails }, source: string) {
  const details = result.details!.numberedRead!;
  expect(details.linePrefixesOmitted).toBe(false);
  const output = text(result).split("\n"), lines = source.split("\n");
  expect(output[0]).toBe(`File ${JSON.stringify(details.path)}`);
  for (let index = 0; index < details.sourceLinesReturned; index++) {
    const number = details.startLine + index;
    expect(output[index + 2]).toBe(`${number}: ${lines[number - 1]}`);
  }
  expect(details.endLine).toBe(details.sourceLinesReturned ? details.startLine + details.sourceLinesReturned - 1 : null);
}

test("optional numbering preserves ordinary native results and reads the source once", async () => {
  const source = "first\nsecond\nthird\n";
  await writeFile(join(cwd, "source.txt"), source);
  let reads = 0;
  const options: ReadToolOptions = { operations: { access, async readFile(path) { reads++; return readFile(path); } } };
  const native = createReadToolDefinition(cwd, options), evidence = createReadBufferTool(cwd, options);
  const args = { path: "source.txt", offset: 2, limit: 1 };
  const original = await native.execute("native", args, undefined, undefined, ctx());
  for (const flag of [{}, { lineNumbers: false }, { lineNumbers: true }]) {
    reads = 0;
    const result = await evidence.execute("evidence", { ...args, ...flag }, undefined, undefined, ctx());
    expect(reads).toBe(1);
    if (flag.lineNumbers) {
      verifySource(result, source);
      expect(result.details?.numberedRead).toMatchObject({ startLine: 2, endLine: 2 });
    } else expect(result).toEqual(original);
  }
  reads = 0;
  await expect(evidence.execute("invalid", { ...args, lineNumbers: "true" as never }, undefined, undefined, ctx()))
    .rejects.toThrow("lineNumbers must be a boolean");
  expect(reads).toBe(0);
});

test("numbered coordinates retain the requested range when the caller reuses its input", async () => {
  const source = "first\nsecond\nthird\n";
  await writeFile(join(cwd, "source.txt"), source);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const tool = createNumberedReadToolDefinition(cwd, { operations: {
    async access(path) { await access(path); started(); await gate; }, readFile,
  } });
  const args = { path: "source.txt", offset: 2, limit: 1 };
  const pending = tool.execute("range", args, undefined, undefined, ctx());
  await ready;
  args.offset = 1; args.limit = 3;
  release();
  const result = await pending;
  verifySource(result, source);
  expect(result.details?.numberedRead).toMatchObject({ startLine: 2, endLine: 2, sourceLinesReturned: 1 });
});

test("labels the native buffer once and separates CRLF, control characters and footer-looking source from notices", async () => {
  const source = "first\r\n\r\n[5 more lines in file. Use offset=7 to continue.]\r\n界\t\x00four\r\nlast\n";
  await writeFile(join(cwd, "source.txt"), source);
  const captured: string[] = [];
  const options: ReadToolOptions = { operations: { access, async readFile(path) { captured.push(path); return readFile(path); } } };
  const native = createReadToolDefinition("/unused", options), numbered = createNumberedReadToolDefinition("/unused", options);
  expect(numbered.parameters).toEqual(native.parameters);
  const args = { path: "@source.txt", offset: 2, limit: 3 };
  const original = await native.execute("native", args, undefined, undefined, ctx());
  captured.length = 0;
  const result = await numbered.execute("numbered", args, undefined, undefined, ctx());
  expect(captured).toEqual([join(cwd, "source.txt")]);
  verifySource(result, source);
  expect(result.details?.numberedRead).toMatchObject({ path: "source.txt", startLine: 2, endLine: 4, sourceLinesReturned: 3, sourceLinesOmittedForNumbering: 0 });
  expect(text(result)).toContain("3: [5 more lines in file. Use offset=7 to continue.]\r");
  expect(text(result).endsWith("\n\n[2 more lines in file. Use offset=5 to continue.]")).toBe(true);
  expect(text(original)).toContain("界\t\x00four\r");
});

test("attributes blank source lines without inventing a line after a trailing LF or in an empty file", async () => {
  for (const [source, offset, limit, count] of [["", 1, undefined, 0], ["\n", 1, undefined, 1], ["a\n", 1, undefined, 1], ["a\n", 2, 1, 0], ["a\n\nb", 2, 1, 1]] as const) {
    await writeFile(join(cwd, "source.txt"), source);
    const result = await createNumberedReadToolDefinition(cwd).execute("empty", { path: "source.txt", offset, limit }, undefined, undefined, ctx());
    verifySource(result, source);
    expect(result.details!.numberedRead!.sourceLinesReturned).toBe(count);
  }
});

test("retains native line truncation and fixes the continuation after the numbered byte cap removes rows", async () => {
  const short = "row\n".repeat(3000);
  await writeFile(join(cwd, "short.txt"), short);
  const native = createReadToolDefinition(cwd);
  const numbered = createNumberedReadToolDefinition(cwd);
  const original = await native.execute("native", { path: "short.txt" }, undefined, undefined, ctx());
  const lines = await numbered.execute("lines", { path: "short.txt" }, undefined, undefined, ctx());
  verifySource(lines, short);
  expect(lines.details!.truncation!).toEqual(original.details!.truncation!);
  expect(lines.details?.numberedRead).toMatchObject({ startLine: 1, endLine: 2000, truncatedByNumbering: false });
  expect(text(lines)).toContain("Use offset=2001 to continue.");

  const long = ("界".repeat(100) + "\r\n").repeat(1000);
  await writeFile(join(cwd, "long.txt"), long);
  const args = { path: "long.txt", offset: 23, limit: 500 };
  const originalBytes = await native.execute("native-bytes", args, undefined, undefined, ctx());
  const bytes = await numbered.execute("bytes", args, undefined, undefined, ctx());
  verifySource(bytes, long);
  const details = bytes.details!.numberedRead!;
  expect(details.truncatedByNumbering).toBe(true);
  expect(details.sourceLinesOmittedForNumbering).toBeGreaterThan(0);
  expect(details.numberedOutputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
  expect(details.sourceLinesReturned).toBeLessThan(originalBytes.details!.truncation!.outputLines);
  expect(text(bytes)).toContain(`Use offset=${details.endLine! + 1} to continue.`);
  expect(text(bytes)).not.toContain(`Use offset=${23 + originalBytes.details!.truncation!.outputLines} to continue.`);

  const evidence = createReadBufferTool(cwd);
  const shown = await evidence.execute("shown", { ...args, lineNumbers: true }, undefined, undefined, ctx());
  const originalDetails = structuredClone(shown.details!);
  const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
  const display = evidence.renderResult!(shown, { expanded: true, isPartial: false }, theme as never,
    { args, cwd, showImages: false, isError: false } as never).render(200).join("\n");
  expect(display).toContain(`Use offset=${shown.details!.numberedRead!.endLine! + 1} to continue.`);
  expect(display).not.toContain(`[Truncated: ${originalBytes.details!.truncation!.outputLines} lines shown`);
  expect(shown.details).toEqual(originalDetails);
});

test("keeps a fitting source line when its label would exceed the cap and passes native oversized notices through", async () => {
  for (const length of [DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES + 1]) {
    const source = "x".repeat(length);
    await writeFile(join(cwd, "huge.txt"), source);
    const original = await createReadToolDefinition(cwd).execute("native", { path: "huge.txt" }, undefined, undefined, ctx());
    const result = await createNumberedReadToolDefinition(cwd).execute("numbered", { path: "huge.txt" }, undefined, undefined, ctx());
    if (length > DEFAULT_MAX_BYTES) expect(result).toEqual(original);
    else {
      expect(result.details!.numberedRead).toMatchObject({ startLine: 1, endLine: 1, linePrefixesOmitted: true, sourceLinesReturned: 1, sourceLinesOmittedForNumbering: 0, numberedOutputBytes: DEFAULT_MAX_BYTES });
      expect(text(result)).toContain(source);
      expect(text(result)).toContain("Source lines 1-1.");
    }
  }
});

test("preserves image attachments, native errors, cancellation and unusual native numeric ranges", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=", "base64");
  await writeFile(join(cwd, "pixel.png"), png);
  await writeFile(join(cwd, "source.txt"), "one\ntwo\nthree");
  const native = createReadToolDefinition(cwd, { autoResizeImages: false }), numbered = createNumberedReadToolDefinition(cwd, { autoResizeImages: false });
  const originalImage = await native.execute("image", { path: "pixel.png" }, undefined, undefined, ctx());
  expect(originalImage.content.some(block => block.type === "image")).toBe(true);
  expect(await numbered.execute("image", { path: "pixel.png" }, undefined, undefined, ctx())).toEqual(originalImage);
  for (const args of [{ path: "source.txt", offset: 0 }, { path: "source.txt", offset: 1.5 }, { path: "source.txt", limit: 0 }, { path: "source.txt", limit: -1 }]) {
    expect(await numbered.execute("range", args, undefined, undefined, ctx())).toEqual(await native.execute("range", args, undefined, undefined, ctx()));
  }
  await expect(numbered.execute("missing", { path: "missing.txt" }, undefined, undefined, ctx())).rejects.toThrow("ENOENT");
  await expect(numbered.execute("outside", { path: "source.txt", offset: 9 }, undefined, undefined, ctx())).rejects.toThrow("beyond end of file");
  const controller = new AbortController(); controller.abort();
  await expect(numbered.execute("cancelled", { path: "source.txt" }, controller.signal, undefined, ctx())).rejects.toThrow("Operation aborted");
  const activeController = new AbortController();
  const abortingRead = createNumberedReadToolDefinition(cwd, { operations: { access, async readFile(path) {
    const buffer = await readFile(path); activeController.abort(); return buffer;
  } } });
  await expect(abortingRead.execute("active-cancel", { path: "source.txt" }, activeController.signal, undefined, ctx())).rejects.toThrow("Operation aborted");
});

test("keeps independent source captures per call and discloses native replacement decoding", async () => {
  await writeFile(join(cwd, "one.txt"), "first\nsecond\n");
  await writeFile(join(cwd, "two.txt"), "other\nrequested\n");
  let started = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tool = createNumberedReadToolDefinition(cwd, { operations: { access, async readFile(path) {
    const buffer = await readFile(path);
    if (++started === 2) release();
    await gate; return buffer;
  } } });
  const results = await Promise.all(["one.txt", "two.txt"].map(path => tool.execute(path, { path, offset: 2, limit: 1 }, undefined, undefined, ctx())));
  expect(results.map(result => result.details!.numberedRead!.path)).toEqual(["one.txt", "two.txt"]);
  expect(results.map(result => text(result))).toEqual([expect.stringContaining("2: second"), expect.stringContaining("2: requested")]);
  await writeFile(join(cwd, "invalid.txt"), Buffer.from([255, 10, 104, 105, 116]));
  const decoded = await createNumberedReadToolDefinition(cwd).execute("invalid", { path: "invalid.txt" }, undefined, undefined, ctx());
  expect(decoded.details!.numberedRead!.encodingLoss).toBe(true);
  expect(text(decoded)).toContain("1: �\n2: hit");
  expect(text(decoded)).toContain("Invalid UTF-8 was decoded with replacement");
});

test("Pi permission and result hooks remain authoritative for numbered reads", async () => {
  const readPaths: string[] = [];
  const fixture = await createSdkFixture({ sixTools: true, extensions: [pi => {
    const read = createNumberedReadToolDefinition("/unused", { operations: { access, async readFile(path) { readPaths.push(basename(path)); return readFile(path); } } });
    pi.registerTool(read);
    pi.registerTool(createSearchTool("."));
    pi.on("tool_call", event => {
      if (event.toolName === "read" && event.input.path === "private.txt") return { block: true, reason: "Private read denied." };
    });
    pi.on("tool_result", event => {
      if (event.toolName === "read" && event.input.path === "public.txt") return { content: [{ type: "text", text: "Result hook replacement." }] };
    });
  }] });
  try {
    await writeFile(join(fixture.cwd, "private.txt"), "private original source\n");
    await writeFile(join(fixture.cwd, "public.txt"), "public original source\n");
    fixture.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "private.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: "public.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Complete."),
    ]);
    await fixture.session.prompt("Read the known sources.");
    expect(readPaths).toEqual(["public.txt"]);
    const results = fixture.session.messages.filter(message => message.role === "toolResult");
    expect(JSON.stringify(results.map(result => result.content))).not.toContain("original source");
    expect(JSON.stringify(results.map(result => result.content))).toContain("Result hook replacement.");
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});
