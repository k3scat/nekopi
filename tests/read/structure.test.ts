import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadBufferTool } from "../../src/tools/read.ts";
import { MAX_PARSE_BYTES } from "../../src/tools/syntax/parser.ts";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "nekopi-read-structure-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

const padding = `  // ${"padding ".repeat(12)}`;
const big = `export class Rollup {\n  run(): void {}\n}\n\n${Array.from({ length: 400 },
  (_, index) => `export function step${index}(value: number): number {\n${padding}\n  return value + ${index};\n}`).join("\n\n")}\n`;

async function read(input: Record<string, unknown>) {
  const result = await createReadBufferTool(cwd)
    .execute("1", input as never, new AbortController().signal, () => {}, { cwd } as never);
  return { truncated: result.details?.truncation?.truncated === true,
    text: result.content.flatMap(block => block.type === "text" ? [block.text!] : []).join("\n") };
}

test("a read with no range gives a long file a window and a map", async () => {
  await writeFile(join(cwd, "big.ts"), big);
  const { text } = await read({ path: "big.ts" });
  // One call answers both intentions: content to start from, and where to
  // look for the rest. Outlining first was a second call for the same file.
  expect(text).toContain("Shape of big.ts");
  expect(text).toContain("1-3  class Rollup");
  expect(text).toContain("function step0");
  // The map is bounded, so a file of 400 declarations cannot flood the result.
  expect(text).toMatch(/\(\+\d+ more; read a range for the rest\)/u);
  // The native notice already names the next line, so the window is navigable.
  expect(text).toMatch(/more lines in file/u);
  // The whole file unbounded was 51,227 characters of one tool result, which
  // then rides in context for every later request.
  expect(text.length).toBeLessThan(big.length / 2);
});

test("a file inside the window is returned whole and unchanged", async () => {
  const short = `${Array.from({ length: 40 },
    (_, index) => `export function step${index}(value: number): number {\n  return value + ${index};\n}`).join("\n")}\n`;
  await writeFile(join(cwd, "short.ts"), short);
  const { text } = await read({ path: "short.ts" });
  expect(text).toContain("step39");
  // Content that fits already shows the structure a map would describe.
  expect(text).not.toContain("Shape of");
});

test("a read that fits, or names its own range, gets no map", async () => {
  await writeFile(join(cwd, "big.ts"), big);
  await writeFile(join(cwd, "small.ts"), "export function tiny(): number {\n  return 1;\n}\n");
  // A range was a deliberate choice; the agent already knows where it is.
  expect((await read({ path: "big.ts", offset: 1, limit: 5 })).text).not.toContain("Shape of");
  // Content that fits already shows the structure a map would describe.
  expect((await read({ path: "small.ts" })).text).not.toContain("Shape of");
});

test("a long file with no grammar is left exactly as Pi returns it", async () => {
  // The window is a trade: less content for a map of what is missing. With no
  // grammar there is no map to give, so there is nothing to trade and the
  // file is returned as the native tool returns it.
  const prose = `${Array.from({ length: 900 }, (_, index) => `line ${index}`).join("\n")}\n`;
  await writeFile(join(cwd, "long.md"), prose);
  const { text } = await read({ path: "long.md" });
  expect(text).toContain("line 899");
  expect(text).not.toContain("Shape of");
});

test("a truncated file with no grammar is not charged for a map", async () => {
  // Config and prose are the common case outside code, and they have no
  // symbols to map. They must add nothing rather than an explanation.
  await writeFile(join(cwd, "doc.md"), Array.from({ length: 4_000 }, (_, index) => `## Section ${index}\n\nProse.`).join("\n\n"));
  await writeFile(join(cwd, "conf.yaml"), Array.from({ length: 4_000 }, (_, index) => `key${index}: value${index}`).join("\n"));
  for (const path of ["doc.md", "conf.yaml"]) {
    const { truncated, text } = await read({ path });
    expect(truncated).toBe(true);
    expect(text).not.toContain("Shape of");
  }
});

test("a file that declares nothing adds nothing", async () => {
  await writeFile(join(cwd, "data.ts"), `${Array.from({ length: 4_000 }, (_, index) => `// comment ${index}`).join("\n")}\n`);
  const { truncated, text } = await read({ path: "data.ts" });
  expect(truncated).toBe(true);
  expect(text).not.toContain("Shape of");
});

// The retired outline tool used to guard these; the shape on a read is the
// only thing that parses a file on the agent's behalf now, so they guard it.
test("a symlink out of the workspace contributes no shape", async () => {
  const outside = await mkdtemp(join(tmpdir(), "nekopi-read-outside-"));
  try {
    await writeFile(join(outside, "secret.ts"), `export const secret = 1;\n${big}`);
    await symlink(join(outside, "secret.ts"), join(cwd, "link.ts"));
    const { text } = await read({ path: "link.ts" });
    // Following the link is Pi's native read behaviour and is unchanged here.
    // What this layer decides is whether to parse the target and map it, and
    // a path that resolves outside the workspace is not mapped.
    expect(text).not.toContain("Shape of");
  } finally { await rm(outside, { recursive: true, force: true }); }
});

test("a source past the parse limit is not parsed for a shape", async () => {
  await writeFile(join(cwd, "huge.ts"), `const big = "${"x".repeat(MAX_PARSE_BYTES)}";\n`);
  const { text } = await read({ path: "huge.ts" });
  expect(text).not.toContain("Shape of");
});
