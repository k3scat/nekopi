import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import evidenceSearchExtension, { createSearchTool, resolveRipgrep, type SearchRow, type SearchOptions } from "../../src/tools/search.ts";
import { createSdkFixture } from "../helpers/model-server.ts";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "nekopi-evidence-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
const search = async (args: unknown, options?: SearchOptions) => {
  const result = await createSearchTool(cwd, options).execute("test", args);
  if (!("rows" in result.details)) throw new Error("Expected content search result.");
  return { ...result, details: result.details };
};
const text = (result: Awaited<ReturnType<typeof search>>) => result.content[0]!.text;

const UNSAFE_PATH = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/u;

/** Mirror the tool's rendering so format changes stay explicit in one place. */
// The path heads its group of hits instead of leading every line, so a
// rendered line carries only what differs between lines of one file.
function rendered(row: SearchRow, excerpt: { start: number; end: number; text: string }, sampled = false): string {
  const separator = row.kind === "match" ? ":" : "-";
  const lead = excerpt.start > 0 ? "\u2026" : "", trail = excerpt.end < row.sourceBytes ? "\u2026" : "";
  const body = row.encodingLoss || CONTROL.test(excerpt.text) ? JSON.stringify(excerpt.text) : `${lead}${excerpt.text}${trail}`;
  return `  ${row.line}${separator}${sampled ? " [sample]" : ""} ${body}`;
}

/** The heading a group of hits in one file now carries once. */
function fileHeading(row: SearchRow): string {
  return UNSAFE_PATH.test(row.path) ? JSON.stringify(row.path) : row.path;
}

function checkEvidence(row: SearchRow, source: Buffer, visible: string, sampled = false) {
  expect(row.sourceBytes).toBe(source.length);
  expect(visible).toContain(fileHeading(row));
  for (const excerpt of row.excerpts) {
    expect(excerpt.text).toBe(source.subarray(excerpt.start, excerpt.end).toString("utf8"));
    expect(visible).toContain(rendered(row, excerpt, sampled));
  }
}

async function executable(body: string) {
  const file = join(cwd, "fake-rg");
  await writeFile(file, `#!${process.execPath}\n${body}\n`);
  await chmod(file, 0o700);
  return file;
}

function matchEvent(source = "hit\n") {
  return { type: "match", data: { path: { text: join(cwd, "sample.txt") }, lines: { text: source }, line_number: 1,
    submatches: [{ start: 0, end: 3, match: { text: "hit" } }] } };
}

describe("search", () => {
  test("renders complete source verbatim with inline identities and retains quoted control rows", async () => {
    const filename = 'quoted"\nname.txt';
    const lines = [
      'before("quoted", "path\\name");  ',
      '\tNEEDLE("界🙂", "path\\name");',
      'after("quoted");',
      "NEEDLE\r", "NEEDLE\u001b[2J", "NEEDLE\u0085", "NEEDLE\u2028", "NEEDLE\u2029",
    ];
    await writeFile(join(cwd, filename), lines.join("\n") + "\n");
    const result = await search({ pattern: "NEEDLE", path: filename, context: 1 });
    const visible = text(result), path = JSON.stringify(filename);
    expect(visible).toContain(`${path}\n  1- ${lines[0]}`);
    expect(visible).toContain(`  2: ${lines[1]}`);
    expect(visible).toContain(`  3- ${lines[2]}`);
    for (const row of result.details.rows) checkEvidence(row, Buffer.from(lines[row.line - 1]!), visible);
    for (let index = 3; index < lines.length; index++) {
      expect(visible).toContain(`  ${index + 1}: ${JSON.stringify(lines[index])}`);
    }
    expect(result.details).toMatchObject({ scanComplete: true, clippedText: false, omittedSpans: 0, outputTruncated: false });
    expect(result.details.rows.map(row => row.excerpts[0]!.text)).toEqual(lines);
  });

  test("resolves managed ripgrep before PATH and reports unavailable binaries without downloads", async () => {
    const agentDir = join(cwd, "agent"), pathDir = join(cwd, "pathbin");
    await mkdir(join(agentDir, "bin"), { recursive: true });
    await mkdir(pathDir);
    const binary = process.platform === "win32" ? "rg.exe" : "rg";
    const managed = join(agentDir, "bin", binary), fallback = join(pathDir, binary);
    const file = await executable(`process.stdout.write(${JSON.stringify(JSON.stringify(matchEvent()) + "\n")});`);
    await copyFile(file, managed); await chmod(managed, 0o700);
    await copyFile(file, fallback); await chmod(fallback, 0o700);
    expect(await resolveRipgrep(agentDir, "", cwd)).toBe(managed);
    expect(await resolveRipgrep(agentDir, pathDir, cwd)).toBe(managed);
    if (process.platform !== "win32") {
      await chmod(managed, 0o600);
      expect(await resolveRipgrep(agentDir, "pathbin", cwd)).toBe(fallback);
    }
    await rm(managed);
    expect(await resolveRipgrep(agentDir, pathDir, cwd)).toBe(fallback);
    await rm(fallback);
    await expect(resolveRipgrep(agentDir, pathDir, cwd)).rejects.toThrow("ripgrep is unavailable");
  });

  test("uses literal relative and absolute paths without expanding @ or ~", async () => {
    for (const filename of ["@literal.txt", "~literal.txt"]) {
      await writeFile(join(cwd, filename), "requested evidence\n");
      for (const path of [filename, join(cwd, filename)]) {
        const result = await search({ pattern: "requested", path });
        expect(result.isError).not.toBe(true);
        expect(result.details.rows.map(row => row.path)).toEqual([filename.startsWith("@") ? `./${filename}` : filename]);
        expect(text(result)).toContain("requested evidence");
      }
    }
  });

  test("returned search paths can be handed to native read without mention or home expansion", async () => {
    await mkdir(join(cwd, "@scope"));
    await mkdir(join(cwd, "~"));
    await writeFile(join(cwd, "literal.txt"), "different file\n");
    const native = createReadToolDefinition(cwd);
    for (const filename of ["@literal.txt", "@scope/member.txt", "~/literal.txt"]) {
      const source = `requested evidence in ${filename}\n`;
      await writeFile(join(cwd, filename), source);
      for (const outputMode of ["content", "files"] as const) {
        const result = await createSearchTool(cwd).execute("search", { pattern: "requested evidence", path: filename, outputMode });
        const paths = "rows" in result.details ? result.details.rows.map(row => row.path) : result.details.files;
        expect(paths).toHaveLength(1);
        const read = await native.execute("read", { path: paths[0]! }, undefined, undefined, { cwd } as never);
        expect(read.content).toEqual([{ type: "text", text: source }]);
        expect(result.content[0]!.text).toContain(paths[0]);
      }
    }
  });

  test("keeps late Unicode matches with exact original byte locations and merged windows", async () => {
    const source = Buffer.from("前🙂".repeat(400) + "NEEDLE" + "界".repeat(30) + "NEEDLE" + "界".repeat(400) + "NEEDLE" + "終".repeat(200));
    await writeFile(join(cwd, "unicode.txt"), Buffer.concat([source, Buffer.from("\n")]));
    const result = await search({ pattern: "NEEDLE", literal: true });
    const row = result.details.rows[0]!;
    expect(row.excerpts).toHaveLength(2);
    expect(row.matches).toHaveLength(3);
    expect(row.matches[0]!.start).toBe(Buffer.byteLength("前🙂".repeat(400)));
    for (const match of row.matches) expect(row.excerpts.some((span) => span.start <= match.start && span.end >= match.end)).toBe(true);
    expect([...row.excerpts[0]!.text.split("NEEDLE")[0]!]).toHaveLength(80);
    expect(row.encodingLoss).toBe(false);
    expect(result.details).toMatchObject({ scanComplete: true, resultOverflow: false, clippedText: true, omittedSpans: 0 });
    checkEvidence(row, source, text(result));
  });

  test("preserves short lines, zero-width offsets and CR while retaining regex and literal semantics", async () => {
    const source = Buffer.from("é a.b axb\r");
    await writeFile(join(cwd, "short.txt"), Buffer.concat([source, Buffer.from("\n")]));
    const zero = await search({ pattern: "^|$" });
    const row = zero.details.rows[0]!;
    expect(row.matches).toEqual([{ start: 0, end: 0 }, { start: source.length, end: source.length }]);
    expect(row.excerpts).toEqual([{ start: 0, end: source.length, text: source.toString("utf8") }]);
    checkEvidence(row, source, text(zero));
    expect((await search({ pattern: "a.b", literal: true })).details.rows[0]!.matches).toHaveLength(1);
    expect((await search({ pattern: "a.b" })).details.rows[0]!.matches).toHaveLength(2);
  });

  test("retains BOM-decoded evidence and identifies its byte coordinate space", async () => {
    const prefix = "前🙂".repeat(200), needle = "NEEDLE界", line = prefix + needle + "終".repeat(200);
    const decoded = Buffer.from(line), utf16 = Buffer.from(line + "\nnext line\n", "utf16le");
    const encodings = [
      ["utf8.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(line + "\nnext line\n")])],
      ["utf16le.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), utf16])],
      ["utf16be.txt", Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(utf16).swap16()])],
    ] as const;
    for (const [path, source] of encodings) {
      await writeFile(join(cwd, path), source);
      const result = await search({ pattern: needle, path, literal: true, context: 1 });
      expect(result.isError).not.toBe(true);
      expect(result.details).toMatchObject({ scanComplete: true, omittedSpans: 0 });
      expect(result.details.rows.map(row => [row.line, row.kind])).toEqual([[1, "match"], [2, "context"]]);
      const row = result.details.rows[0]!;
      expect(row.matches).toEqual([{ start: Buffer.byteLength(prefix), end: Buffer.byteLength(prefix + needle) }]);
      checkEvidence(row, decoded, text(result));
      checkEvidence(result.details.rows[1]!, Buffer.from("next line"), text(result));
      expect(text(result)).toContain(needle);
      expect(text(result)).not.toContain("within the original source line");
    }
  });

  test("merges surrounding context without duplicates and prioritizes matches under a byte budget", async () => {
    await writeFile(join(cwd, "context.txt"), "before\nhit one\nmiddle\nhit two\nafter\n");
    const result = await search({ pattern: "hit", context: 1 });
    expect(result.details.rows.map((row) => row.line)).toEqual([1, 2, 3, 4, 5]);
    expect(result.details.rows.filter((row) => row.kind === "match").map((row) => row.line)).toEqual([2, 4]);
    expect(result.details.rows.filter((row) => row.kind === "context").map((row) => row.line)).toEqual([1, 3, 5]);
    await writeFile(join(cwd, "crowded.txt"), ("x".repeat(167) + "\n").repeat(20) + "TARGET\n");
    // Tighter than it used to need to be: grouping the path into a heading
    // left room for every context line inside the old 4096-byte budget, so
    // the budget has to bite harder to still exercise the omission path.
    const bounded = await search({ pattern: "TARGET", path: "crowded.txt", context: 20 }, { maxOutputBytes: 2048 });
    expect(bounded.details.rows.filter((row) => row.kind === "match")).toHaveLength(1);
    expect(bounded.details.omittedSpans).toBe(0);
    expect(bounded.details.omittedContextLines).toBeGreaterThan(0);
    expect(bounded.details.outputTruncated).toBe(true);
    expect(Buffer.byteLength(text(bounded))).toBeLessThanOrEqual(2048);
    expect(text(bounded)).toContain("reduce context");
    expect(text(bounded)).not.toContain("raise limit");
  });

  test("retains complete requested long context when space permits", async () => {
    const options = `  const options = { labels: [${Array.from({ length: 60 }, (_, i) => JSON.stringify(`metric_${i}`)).join(", ")}], rejectUnknown: true };`;
    const lines = ["export function decode(raw: Uint8Array) {", options, "  return decodePayload(raw, options);", "}"];
    await writeFile(join(cwd, "codec.ts"), lines.join("\n") + "\n");
    const result = await search({ pattern: "decodePayload", path: "codec.ts", literal: true, context: 1 });
    expect(result.details.rows.map(row => [row.line, row.kind])).toEqual([[2, "context"], [3, "match"], [4, "context"]]);
    expect(result.details.rows[0]!.excerpts).toEqual([{ start: 0, end: Buffer.byteLength(options), text: options }]);
    expect(text(result)).toContain(`codec.ts\n  2- ${options}`);
    expect(result.details).toMatchObject({ scanComplete: true, clippedText: false, outputTruncated: false, omittedSpans: 0, omittedContextLines: 0 });
    for (const row of result.details.rows) checkEvidence(row, Buffer.from(lines[row.line - 1]!), text(result));

    const bounded = await search({ pattern: "decodePayload", path: "codec.ts", literal: true, context: 1 }, { maxOutputBytes: 1024 });
    expect(bounded.details.rows.find(row => row.kind === "match")?.excerpts[0]!.text).toBe(lines[2]!);
    const context = bounded.details.rows.find(row => row.line === 2)!;
    expect(context.excerpts[0]!.text).toBe(options.slice(0, 160));
    expect(bounded.details).toMatchObject({ scanComplete: true, clippedText: true, omittedSpans: 0 });
    expect(text(bounded)).toContain(`  2- ${options.slice(0, 160)}\u2026`);
    expect(Buffer.byteLength(text(bounded))).toBeLessThanOrEqual(1536);
    for (const row of bounded.details.rows) checkEvidence(row, Buffer.from(lines[row.line - 1]!), text(bounded));
  });

  test("a capped result names the files the other matches are in", async () => {
    // 27 of 140 recorded debrief answers, and six of fourteen audits before
    // them, said a broad search returned mostly irrelevant hits at its cap.
    // Narrowing was the right answer and the result could not say where to.
    await writeFile(join(cwd, "big.txt"), "hit\n".repeat(40));
    await writeFile(join(cwd, "small.txt"), "hit\n".repeat(5));
    const capped = await search({ pattern: "hit", limit: 3 });
    expect(capped.details.matchesByFile).toEqual([["big.txt", 40], ["small.txt", 5]]);
    expect(text(capped)).toContain("Matches by file: big.txt 40, small.txt 5.");
    // A result that shows everything says nothing extra.
    const whole = await search({ pattern: "hit", limit: 100 });
    expect(text(whole)).not.toContain("Matches by file");
  });

  test("long file notices stay inside the output cap", async () => {
    const folder = `dir-${"d".repeat(100)}`;
    await mkdir(join(cwd, folder));
    const files = Array.from({ length: 5 }, (_, index) => `${folder}/file-${index}-${"x".repeat(100)}.txt`);
    for (const path of files) await writeFile(join(cwd, path), "hit\n");
    const result = await search({ pattern: "hit", limit: 1 }, { maxOutputBytes: 1024 });
    expect(result.details).toMatchObject({ resultOverflow: true, outputTruncated: true });
    expect(text(result)).toContain("Incomplete:");
    expect(text(result)).toContain("Matches by file: list omitted by output limit");
    expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(1024);
  });

  test("distinguishes an exactly full result from observed overflow", async () => {
    const file = join(cwd, "many.txt");
    await writeFile(file, "hit\n".repeat(100));
    const exact = await search({ pattern: "hit" });
    expect(exact.details).toMatchObject({ observedMatchingLines: 100, scanComplete: true, resultOverflow: false, omittedMatchingLines: 0, omittedSpans: 0 });
    await writeFile(file, "hit\n".repeat(101));
    const overflow = await search({ pattern: "hit" });
    // The scan now runs past the row limit so a capped result can say where
    // the rest of the matches are, so it completes; `resultOverflow` is what
    // says more matched than was shown. The observed count is the real total
    // rather than one past the limit, which is why it can be reported.
    expect(overflow.details).toMatchObject({ observedMatchingLines: 101, scanComplete: true, resultOverflow: true, omittedMatchingLines: 1, omittedSpans: 1 });
    expect(overflow.details.rows).toHaveLength(100);
    expect(text(overflow)).toContain("Incomplete: 101 matching lines found, 100 shown.");
  });

  test("per-file sampling preserves source evidence across dense and sparse files", async () => {
    await writeFile(join(cwd, "translations.txt"), "decodePayload label\n".repeat(200));
    await writeFile(join(cwd, "codec.ts"), "export function decodePayload(raw: string) {}\n");
    const result = await search({ pattern: "decodePayload", maxMatchesPerFile: 1, limit: 2 });
    expect(result.isError).not.toBe(true);
    expect(result.details.rows.map(row => row.path).sort()).toEqual(["codec.ts", "translations.txt"]);
    expect(result.details).toMatchObject({ observedMatchingLines: 2, scanComplete: false, resultOverflow: false,
      maxMatchesPerFile: 1, omittedMatchingLines: 0, omittedSpans: 0 });
    expect(result.details.filesAtMatchLimit?.sort()).toEqual(["codec.ts", "translations.txt"]);
    for (const row of result.details.rows) {
      const source = row.path === "codec.ts" ? "export function decodePayload(raw: string) {}" : "decodePayload label";
      checkEvidence(row, Buffer.from(source), text(result), true);
      expect(text(result)).toContain(`${row.path}\n`);
      expect(text(result)).toContain(`  1: [sample] ${source}`);
    }
    expect(text(result)).toContain("Per-file cap 1 reached in 2 file(s) marked [sample]");
    // Removing the cap recovers every match, without changing the pattern or scope.
    const full = await search({ pattern: "decodePayload", path: "translations.txt", limit: 250 });
    expect(full.details).toMatchObject({ observedMatchingLines: 200, scanComplete: true, resultOverflow: false });
    expect(full.details.rows).toHaveLength(200);
    expect(full.details.filesAtMatchLimit).toBeUndefined();
    expect(text(full)).not.toContain("[sample]");
  });

  test("per-file cap distinguishes below-cap completion from possible unseen matches", async () => {
    await writeFile(join(cwd, "two.txt"), "hit one\nhit two\n");
    const below = await search({ pattern: "hit", maxMatchesPerFile: 3 });
    expect(below.details).toMatchObject({ scanComplete: true, filesAtMatchLimit: [], observedMatchingLines: 2 });
    expect(text(below)).not.toContain("two.txt:1: [sample]");
    const exact = await search({ pattern: "hit", maxMatchesPerFile: 2 });
    expect(exact.details).toMatchObject({ scanComplete: false, resultOverflow: false, filesAtMatchLimit: ["two.txt"] });
    // A capped scan cannot establish whether another match exists after the cap.
    expect(text(exact)).toContain("Incomplete: the scan stopped early");
    const empty = await search({ pattern: "absent", maxMatchesPerFile: 1 });
    expect(empty.details).toMatchObject({ scanComplete: true, filesAtMatchLimit: [], observedMatchingLines: 0 });
    expect(text(empty)).toContain("No matches found.");
  });

  test("per-file cap retains context, literal Unicode spans and output bounds", async () => {
    await writeFile(join(cwd, "codec.ts"), "before\n界🙂 hit.*\nafter\nhit.* again\n");
    const result = await search({ pattern: "hit.*", literal: true, path: "codec.ts", maxMatchesPerFile: 1, context: 1 });
    expect(result.details.rows.map(row => [row.line, row.kind])).toEqual([[1, "context"], [2, "match"], [3, "context"]]);
    const row = result.details.rows[1]!;
    expect(row.matches).toEqual([{ start: Buffer.byteLength("界🙂 "), end: Buffer.byteLength("界🙂 hit.*") }]);
    checkEvidence(row, Buffer.from("界🙂 hit.*"), text(result), true);
    expect(text(result)).not.toContain("again");
    const bounded = await search({ pattern: "hit.*", literal: true, maxMatchesPerFile: 1 }, { maxOutputBytes: 1024 });
    expect(Buffer.byteLength(text(bounded))).toBeLessThanOrEqual(1024);
    expect(text(bounded)).toContain("Per-file cap 1 reached in");
  });

  test("per-file limits retain global overflow and partial-root failure semantics", async () => {
    for (const file of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(cwd, file), "hit\nhit\n");
    const overflow = await search({ pattern: "hit", maxMatchesPerFile: 1, limit: 2 });
    expect(overflow.details).toMatchObject({ observedMatchingLines: 3, resultOverflow: true, scanComplete: false });
    expect(overflow.details.rows).toHaveLength(2);
    const partial = await search({ pattern: "hit", path: ["a.txt", "missing"], maxMatchesPerFile: 1 });
    expect(partial.isError).toBe(true);
    expect(partial.details.rows.map(row => row.path)).toEqual(["a.txt"]);
    expect(partial.details.scanComplete).toBe(false);
    expect(text(partial)).toContain("missing");
  });

  test("per-file limits reject invalid values and meaningless files-mode combinations", async () => {
    for (const maxMatchesPerFile of [0, -1, 1.5, 1001, "1", null]) {
      await expect(search({ pattern: "hit", maxMatchesPerFile })).rejects.toThrow("Invalid search parameters");
    }
    await expect(createSearchTool(cwd).execute("invalid", { pattern: "hit", outputMode: "files", maxMatchesPerFile: 1 }))
      .rejects.toThrow("content mode only");
  });

  test("per-file sampling marks retained evidence even when its end event is cut off", async () => {
    const prefix = JSON.stringify(matchEvent()) + "\n";
    const file = await executable(`process.stdout.write(${JSON.stringify(prefix + "x".repeat(1000))});`);
    const result = await search({ pattern: "hit", maxMatchesPerFile: 1 }, { executable: file, maxStreamBytes: Buffer.byteLength(prefix) });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ scanComplete: false, filesAtMatchLimit: ["sample.txt"] });
    expect(text(result)).toContain("sample.txt\n  1: [sample] hit");
    expect(text(result)).toContain("stream byte limit");
  });

  test("overlapping roots do not combine separate file visits into a false per-file cap", async () => {
    await writeFile(join(cwd, "two.txt"), "hit one\nhit two\n");
    const result = await search({ pattern: "hit", path: ["two.txt", cwd], maxMatchesPerFile: 3 });
    expect(result.details).toMatchObject({ scanComplete: true, observedMatchingLines: 4, filesAtMatchLimit: [] });
    expect(result.details.rows).toHaveLength(4);
    expect(text(result)).not.toContain("two.txt:1: [sample]");
  });

  test("reports oversized matching evidence and output omissions without claiming it was shown", async () => {
    await writeFile(join(cwd, "huge.txt"), "x".repeat(3000) + "\n");
    const result = await search({ pattern: "x+" }, { maxOutputBytes: 1024 });
    expect(result.details).toMatchObject({ scanComplete: true, clippedText: true, outputTruncated: true, omittedSpans: 1, omittedMatchingLines: 1, rows: [] });
    expect(text(result)).toContain("huge.txt\n  1: [omitted, 3000 bytes]");
    expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(1024);
  });

  test("reports invalid regex and guards giant event streams", async () => {
    await writeFile(join(cwd, "large.txt"), "hit" + "x".repeat(5000) + "\n");
    const invalid = await search({ pattern: "[" });
    expect(invalid.isError).toBe(true);
    expect(invalid.details.scanComplete).toBe(false);
    expect(text(invalid)).toContain("regex parse error");
    const giant = await search({ pattern: "hit" }, { maxStreamBytes: 1024 });
    expect(giant.isError).toBe(true);
    expect(giant.details.scanComplete).toBe(false);
    expect(text(giant)).toContain("stream byte limit");
    expect(text(giant)).not.toContain("No matches found");
  });

  test("stream limits retain complete evidence before the boundary regardless of chunk splitting", async () => {
    const sources = ["hit 界🙂", "adjacent context", "hit OMITTED_ONLY🙂" + "x".repeat(200)];
    await writeFile(join(cwd, "sample.txt"), sources.join("\n") + "\n");
    const first = matchEvent(sources[0] + "\n");
    const context = { type: "context", data: { ...matchEvent(sources[1] + "\n").data, line_number: 2, submatches: [] } };
    const last = { type: "match", data: { ...matchEvent(sources[2] + "\n").data, line_number: 3 } };
    const prefix = Buffer.from([first, context].map(event => JSON.stringify(event) + "\n").join(""));
    const tail = Buffer.from(JSON.stringify(last) + "\n");
    const stream = Buffer.concat([prefix, tail]);
    for (const maxStreamBytes of [prefix.length, prefix.length + tail.indexOf(Buffer.from("🙂")) + 2]) {
      for (const split of [0, prefix.indexOf(Buffer.from("🙂")) + 2, maxStreamBytes]) {
        const chunks = split ? [stream.subarray(0, split), stream.subarray(split)] : [stream];
        const body = `const chunks = ${JSON.stringify(chunks.map(chunk => [...chunk]))}; for (const chunk of chunks) { process.stdout.write(Buffer.from(chunk)); await new Promise(resolve => setTimeout(resolve, 20)); }`;
        const result = await search({ pattern: "hit", context: 1 }, { executable: await executable(body), maxStreamBytes });
        expect(result.isError).toBe(true);
        expect(result.details).toMatchObject({ scanComplete: false, resultOverflow: false, observedMatchingLines: 1,
          omittedSpans: 0, omittedMatchingLines: 0, omittedContextLines: 0 });
        expect(result.details.rows.map(row => [row.line, row.kind])).toEqual([[1, "match"], [2, "context"]]);
        for (const row of result.details.rows) checkEvidence(row, Buffer.from(sources[row.line - 1]!), text(result));
        expect(result.details.errors).toEqual(["Search stream byte limit reached; remaining matches and context are unknown."]);
        expect(text(result)).toContain("hit 界🙂");
        expect(text(result)).not.toContain("OMITTED_ONLY");
        expect(text(result)).not.toContain("No matches found.");
      }
    }
  });

  test("stream boundaries preserve prior match limits, parse failures and exact completion", async () => {
    const first = JSON.stringify(matchEvent()) + "\n";
    const second = JSON.stringify({ type: "match", data: { ...matchEvent("hit again\n").data, line_number: 2 } }) + "\n";
    for (const item of [
      { prefix: first + second, tail: "x".repeat(1000), observed: 2, overflow: true, complete: false, error: false },
      { prefix: first + "{bad-json}\n", tail: "x".repeat(1000), observed: 1, overflow: false, complete: false, error: true },
      { prefix: first, tail: "", observed: 1, overflow: false, complete: true, error: false },
    ]) {
      const file = await executable(`process.stdout.write(${JSON.stringify(item.prefix + item.tail)});`);
      const result = await search({ pattern: "hit", limit: 1 }, { executable: file, maxStreamBytes: Buffer.byteLength(item.prefix) });
      expect(result.isError ?? false).toBe(item.error);
      expect(result.details).toMatchObject({ observedMatchingLines: item.observed, resultOverflow: item.overflow, scanComplete: item.complete });
      expect(result.details.rows.map(row => row.line)).toEqual([1]);
      expect(result.details.errors).toHaveLength(item.error ? 1 : 0);
      expect(result.details.errors.join(" ")).not.toContain("stream byte limit");
    }
  });

  test("keeps partial evidence with traversal diagnostics and bounds escaped error output", async () => {
    const event = JSON.stringify(matchEvent());
    const file = await executable(`process.stdout.write(${JSON.stringify(event + "\n")}); process.stderr.write("Permission denied: private.txt\\n" + "\\x01".repeat(180)); process.exitCode = 2;`);
    const result = await search({ pattern: "hit" }, { executable: file, maxOutputBytes: 1024 });
    expect(result.isError).toBe(true);
    expect(result.details.rows).toHaveLength(1);
    expect(result.details.scanComplete).toBe(false);
    expect(text(result)).toContain("Permission denied");
    expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(1024);
  });

  test("discloses replacement decoding and binary cutoffs independently of visible matches", async () => {
    const source = Buffer.concat([Buffer.from([255]), Buffer.from(" hit")]);
    await writeFile(join(cwd, "bytes.txt"), Buffer.concat([source, Buffer.from("\n")]));
    const result = await search({ pattern: "hit" });
    expect(result.details.rows[0]!.encodingLoss).toBe(true);
    checkEvidence(result.details.rows[0]!, source, text(result));
    expect(text(result)).toContain("Invalid UTF-8 was decoded with replacement");
    const events = [matchEvent(), { type: "end", data: { binary_offset: 99 } }].map((event) => JSON.stringify(event)).join("\n") + "\n";
    const binary = await search({ pattern: "hit" }, { executable: await executable(`process.stdout.write(${JSON.stringify(events)});`) });
    expect(binary.details.scanComplete).toBe(false);
    expect(text(binary)).toContain("binary data");
  });

  test("cancels the search child and rejects already aborted calls before spawning", async () => {
    const pidFile = join(cwd, "pid");
    const file = await executable(`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const call = createSearchTool(cwd, { executable: file }).execute("cancel", { pattern: "hit" }, controller.signal);
    const handled = call.then(() => { throw new Error("Search unexpectedly completed"); }, (error: Error) => error);
    let pid: number | undefined;
    try {
      for (let count = 0; count < 100; count++) {
        try { pid = Number(await readFile(pidFile, "utf8")); break; } catch { await Bun.sleep(10); }
      }
      expect(pid).toBeDefined();
      controller.abort();
      expect((await handled).name).toBe("AbortError");
      expect(() => process.kill(pid!, 0)).toThrow();
      await rm(pidFile);
      await expect(createSearchTool(cwd, { executable: file }).execute("pre-cancel", { pattern: "hit" }, controller.signal)).rejects.toThrow();
      expect(await Bun.file(pidFile).exists()).toBe(false);
    } finally { controller.abort(); await handled; }
  });

  test("Pi SDK registers the optional grep override and searches the session cwd", async () => {
    const fixture = await createSdkFixture({ extensions: [evidenceSearchExtension] });
    try {
      const source = "前".repeat(700) + "NEEDLE";
      await mkdir(join(fixture.cwd, "first")); await mkdir(join(fixture.cwd, "second"));
      await writeFile(join(fixture.cwd, "first", "session-only.txt"), source + "\n");
      await writeFile(join(fixture.cwd, "first", "excluded.generated.txt"), "NEEDLE outside requested glob\n");
      await writeFile(join(fixture.cwd, "second", "additional.txt"), "NEEDLE second requested root\n");
      await writeFile(join(fixture.cwd, "outside.txt"), "NEEDLE outside requested roots\n");
      fixture.setResponses([
        fauxAssistantMessage(fauxToolCall("grep", { pattern: "NEEDLE", path: ["first", "second"], glob: ["*.txt", "!*.generated.txt"], maxMatchesPerFile: 2 }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Found the requested evidence."),
      ]);
      await fixture.session.prompt("Search the current directory for NEEDLE.");
      const result = fixture.session.messages.find((message) => message.role === "toolResult" && message.toolName === "grep");
      if (result?.role !== "toolResult") throw new Error("Missing registered grep result");
      expect(result.isError).toBe(false);
      expect(result.details).toMatchObject({ maxMatchesPerFile: 2, filesAtMatchLimit: [] });
      const output = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
      expect(output).toContain("NEEDLE");
      expect(output).toMatch(/first\/session-only\.txt\n {2}1: \u2026/);
      expect(output).toContain("second/additional.txt\n  1: NEEDLE second requested root");
            expect(output).not.toContain("excluded.generated.txt");
      expect(output).not.toContain("outside.txt");
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  });
});
