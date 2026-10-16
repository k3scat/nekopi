import { afterEach, beforeEach, expect, test } from "bun:test";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditToolDefinition, type EditOperations, type EditToolInput } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createEditRecoveryTool } from "../../src/tools/edit.ts";
import { createSdkFixture } from "../helpers/model-server.ts";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "nekopi-edit-recovery-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
const ctx = () => ({ cwd } as never);
const call = (tool: ReturnType<typeof createEditRecoveryTool>, input: EditToolInput) => tool.execute("edit", input, undefined, undefined, ctx());
async function failure(action: Promise<unknown>): Promise<Error> {
  try { await action; } catch (error) { if (error instanceof Error) return error; throw error; }
  throw new Error("Expected a native edit failure.");
}
function observedOperations() {
  const reads: string[] = [], writes: string[] = [];
  const operations: EditOperations = {
    access: path => access(path, constants.R_OK | constants.W_OK),
    readFile(path) { reads.push(path); return readFile(path); },
    writeFile(path, text) { writes.push(path); return writeFile(path, text, "utf8"); },
  };
  return { operations, reads, writes };
}

test("native indexed ambiguity retains exact source context from its single read and never writes", async () => {
  const original = "unique\nfirst branch\nshared\nfirst end\nsecond branch\nshared\nsecond end\n";
  const path = join(cwd, "source.txt");
  await writeFile(path, original);
  const observed = observedOperations();
  const input = { path: "source.txt", edits: [{ oldText: "unique", newText: "changed" }, { oldText: "shared", newText: "replacement" }] };
  const error = await failure(call(createEditRecoveryTool(cwd, observed.operations), input));
  const native = "Found 2 occurrences of edits[1] in source.txt. Each oldText must be unique. Please provide more context to make it unique.";
  expect(error.message.startsWith(native + "\n\nedits[")).toBe(true);
  expect((error.cause as Error).message).toBe(native);
  expect(error.message).toContain("source.txt:3");
  expect(error.message).toContain('2: "first branch"\n3: "shared"\n4: "first end"');
  expect(error.message).toContain("source.txt:6");
  expect(error.message).toContain('5: "second branch"\n6: "shared"\n7: "second end"');
  expect(error.message).toContain("edits[1].oldText (exact; native fuzzy matching may find more)");
  expect(error.message).toContain("from the pre-attempt snapshot");
  expect(error.message).not.toContain("locations shown");
  expect(error.message).toContain("Make edits[1].oldText unique with more context, or use Bash to replace every occurrence after asserting the count.");
  expect(observed.reads).toEqual([path]); expect(observed.writes).toEqual([]);
  expect(await readFile(path, "utf8")).toBe(original);
});

test("repeating an ambiguous edit leaves both sites unchanged until distinctive context selects one", async () => {
  const original = "unique\n\tfirst branch\n\tshared();\n\tsecond branch\n\tshared();\n";
  const path = join(cwd, "source.txt"); await writeFile(path, original);
  const observed = observedOperations(), tool = createEditRecoveryTool(cwd, observed.operations);
  for (const replacement of ["changed", "changed again"]) {
    const error = await failure(call(tool, { path: "source.txt", edits: [
      { oldText: "unique", newText: replacement },
      { oldText: "shared();", newText: "updated();" },
    ] }));
    expect(error.message).toContain("Make edits[1].oldText unique");
    expect(error.message).toContain("source.txt:3");
    expect(error.message).toContain("source.txt:5");
    expect(observed.writes).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(original);
  }
  const selected = "\tsecond branch\n\tshared();", changed = "\tsecond branch\n\tupdated();";
  await call(tool, { path: "source.txt", edits: [{ oldText: selected, newText: changed }] });
  expect(await readFile(path, "utf8")).toBe(original.replace(selected, changed));
  expect(observed.reads).toEqual([path, path, path]); expect(observed.writes).toEqual([path]);
});

test("CRLF and BOM normalization retains original file line identity without rereading", async () => {
  const original = "\uFEFFheader\r\nTARGET\r\nnext\r\nmiddle\r\nTARGET\r\nnext\r\nfooter\r\n";
  const path = join(cwd, "bom.txt"); await writeFile(path, original);
  const observed = observedOperations();
  const error = await failure(call(createEditRecoveryTool(cwd, observed.operations), { path: "bom.txt", edits: [{ oldText: "TARGET\nnext", newText: "changed" }] }));
  expect(error.message).toContain("bom.txt:2-3");
  expect(error.message).toContain('1: "header"\n2: "TARGET"\n3: "next"\n4: "middle"');
  expect(error.message).toContain("bom.txt:5-6");
  expect(error.message).toContain("pre-attempt snapshot");
  expect(observed.reads).toEqual([path]); expect(observed.writes).toEqual([]);
  expect(await readFile(path, "utf8")).toBe(original);
});

test("native not-found feedback exposes whitespace differences without partially applying a multi-edit", async () => {
  const path = join(cwd, "source.ts");
  const original = 'import { Client } from "sdk";\nconst showExisting = () => {};\nexport const check = async (\n    client: Client,\n): Promise<boolean> => {\n    if (store.getCurrent()) {\n        return false;\n    }\n};\n';
  await writeFile(path, original);
  const observed = observedOperations();
  const edits = [
    { oldText: 'import { Client } from "sdk";', newText: 'import { Client, State } from "sdk";' },
    { oldText: "const showExisting = () => {};", newText: "const showExisting = () => { return; };" },
    { oldText: " ): Promise<boolean> => {\n    if (store.getCurrent()) {", newText: "): Promise<boolean> => {\n    if (client.state === State.Error) return false;\n    if (store.getCurrent()) {" },
  ];
  const tool = createEditRecoveryTool(cwd, observed.operations);
  const error = await failure(call(tool, { path: "source.ts", edits }));
  const native = "Could not find edits[2] in source.ts. The oldText must match exactly including all whitespace and newlines.";
  expect(error.message.startsWith(native + "\n\nedits[")).toBe(true);
  expect((error.cause as Error).message).toBe(native);
  expect(error.message).toContain("edits[2].oldText (equal after trimming each line's edge whitespace)");
  expect(error.message).toContain("equal after trimming each line's edge whitespace");
  expect(error.message).not.toContain("Next:");
  expect(error.message).toContain("source.ts:5-6");
  expect(error.message).toContain('5: "): Promise<boolean> => {"\n6: "    if (store.getCurrent()) {"');
  expect(error.message).not.toContain("locations shown");
  expect(observed.reads).toEqual([path]); expect(observed.writes).toEqual([]);
  expect(await readFile(path, "utf8")).toBe(original);
  const result = await call(tool, { path: "source.ts", edits: edits.map((edit, index) => index === 2 ? { ...edit, oldText: edit.oldText.slice(1) } : edit) });
  expect(result.isError).not.toBe(true);
  expect(observed.writes).toEqual([path]);
  expect(await readFile(path, "utf8")).toBe(edits.reduce((text, edit, index) => text.replace(index === 2 ? edit.oldText.slice(1) : edit.oldText, edit.newText), original));
});

test("missing single-line edits return a unique literal prefix source hint without changing matching", async () => {
  const oldText = "client.fetchResource(ResourceType, requireValue(request.resourceId))";
  const actual = 'client.fetchResource(ResourceType, requireValue(request.resourceId, "missing id"))';
  const original = `header\nconst resource = await ${actual};\nfooter\n`;
  const path = join(cwd, "source.ts"); await writeFile(path, original);
  const observed = observedOperations(), tool = createEditRecoveryTool(cwd, observed.operations);
  const input = { path: "source.ts", edits: [{ oldText: "header", newText: "changed" }, { oldText, newText: "replacement" }] };
  const error = await failure(call(tool, input));
  expect(error.message).toContain("unique prefix");
  expect(error.message).toContain('"client.fetchResource(ResourceTyp"');
  expect(error.message).toContain("not a replacement target");
  expect(error.message).toContain("source.ts:2");
  expect(error.message).toContain(`2: ${JSON.stringify(`const resource = await ${actual};`)}`);
  expect(error.message).toContain("from the pre-attempt snapshot");
  expect((error.cause as Error).message).toContain("Could not find edits[1]");
  expect(observed.reads).toEqual([path]); expect(observed.writes).toEqual([]);
  expect(await readFile(path, "utf8")).toBe(original);
  await call(tool, { ...input, edits: [{ ...input.edits[1]!, oldText: actual }] });
  expect(observed.writes).toEqual([path]);
  expect(await readFile(path, "utf8")).toBe(original.replace(actual, "replacement"));
});

test("literal prefix hints reject repeated, short, multiline and oversized source evidence", async () => {
  const prefix = "client.fetchResource(ResourceType";
  for (const [source, oldText] of [
    [`${prefix}, first); ${prefix}, second);\n`, `${prefix}, absent);`],
    ["x".repeat(80) + "\n", "x".repeat(40) + "missing"], // Overlapping prefix occurrences.
    [`${prefix}, actual);\n`, "client.fetchResourcX"],
    [`${prefix}, actual);\n`, `${prefix}, absent);\n`],
    [`${prefix}, actual);\nnext\n`, `${prefix}, absent);\nnext`],
    [`${prefix}, ${"界🙂".repeat(900)});\n`, `${prefix}, absent);`],
  ] as const) {
    const path = join(cwd, "source.txt"); await writeFile(path, source);
    const input = { path: "source.txt", edits: [{ oldText, newText: "changed" }] };
    const native = await failure(createEditToolDefinition(cwd).execute("native", input, undefined, undefined, ctx()));
    const observed = observedOperations();
    const error = await failure(call(createEditRecoveryTool(cwd, observed.operations), input));
    expect(error.message).toBe(native.message);
    expect(observed.reads).toEqual([path]); expect(observed.writes).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(source);
  }
});

test("literal prefix hints use complete Unicode code points and disclose edge trimming", async () => {
  const prefix = "call" + "🙂".repeat(28), actual = `${prefix}(present)`;
  const original = `\uFEFFheader\r\n${actual}\r\n`;
  const path = join(cwd, "unicode.txt"); await writeFile(path, original);
  const observed = observedOperations();
  const error = await failure(call(createEditRecoveryTool(cwd, observed.operations), {
    path: "unicode.txt", edits: [{ oldText: `\t${prefix}(missing) `, newText: "changed" }],
  }));
  expect(error.message).toContain(`unique prefix ${JSON.stringify(prefix)}`);
  expect(error.message).toContain("not a replacement target");
  expect(error.message).toContain(`2: ${JSON.stringify(actual)}`);
  expect(error.message).not.toContain("�");
  expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(4096);
  expect(observed.reads).toEqual([path]); expect(observed.writes).toEqual([]);
  expect(await readFile(path, "utf8")).toBe(original);
});

test("whitespace locations remain bounded and preserve actual indentation, tabs and Unicode", async () => {
  const source = Array.from({ length: 7 }, (_, index) => `section ${index + 1}\nblock\n\treturn "界🙂";\nend ${index + 1}\n`).join("");
  await writeFile(join(cwd, "many.txt"), source);
  const error = await failure(call(createEditRecoveryTool(cwd), { path: "many.txt", edits: [{ oldText: ' block\n    return "界🙂";\n', newText: "changed" }] }));
  expect(error.message).toContain("4/7 locations shown");
  expect(error.message).toContain("many.txt:14-15");
  expect(error.message).toContain('3: "\\treturn \\"界🙂\\";"');
  expect(error.message).not.toContain("Location 5:");
  expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(4096);
  expect(await readFile(join(cwd, "many.txt"), "utf8")).toBe(source);
  const block = Array.from({ length: 20 }, (_, index) => `line ${index}: ${"界🙂".repeat(60)}`).join("\n");
  const large = `first\n${block}\nsecond\n${block}\nend\n`;
  await writeFile(join(cwd, "large.txt"), large);
  const bounded = await failure(call(createEditRecoveryTool(cwd), { path: "large.txt", edits: [{ oldText: " " + block, newText: "changed" }] }));
  expect(Buffer.byteLength(bounded.message)).toBeLessThanOrEqual(4096);
  expect(bounded.message).toMatch(/, [1-9]\d* source lines omitted\./);
  expect(bounded.message).toContain("界🙂");
  expect(await readFile(join(cwd, "large.txt"), "utf8")).toBe(large);
});

test("whitespace feedback preserves terminal newlines and does not invent blank lines at EOF", async () => {
  for (const [source, oldText, expected] of [
    ["\uFEFFheader\r\na\r\nb\r\n", " a\nb\n", true],
    ["header\na\nb", " a\nb\n", false],
    ["header\na\nb\n", " a\nb\n\n", false],
    ["header\na\nb\n\n", " a\nb\n\n", true],
    ["header\na\nb", " a\nb", true],
  ] as const) {
    await writeFile(join(cwd, "ending.txt"), source);
    const observed = observedOperations();
    const input = { path: "ending.txt", edits: [{ oldText, newText: "changed" }] };
    const error = await failure(call(createEditRecoveryTool(cwd, observed.operations), input));
    expect(error.message.includes("oldText (")).toBe(expected);
    if (expected) expect(error.message).toContain("ending.txt:2");
    expect(observed.reads).toHaveLength(1); expect(observed.writes).toEqual([]);
    expect(await readFile(join(cwd, "ending.txt"), "utf8")).toBe(source);
  }
});

test("not-found feedback requires complete line equality after edge whitespace removal", async () => {
  for (const [source, oldText] of [
    ["const value = 1;\n", " const value=1;"], // Internal whitespace is significant.
    ["prefix target suffix\n", "   target"], // Do not suggest a partial line.
    ["VALUE\n", " value"],
    ["call();\n", " call()"],
    ["x\n\t\nx\n", " \t "], // Empty normalized queries provide no location evidence.
  ] as const) {
    await writeFile(join(cwd, "source.txt"), source);
    const input = { path: "source.txt", edits: [{ oldText, newText: "changed" }] };
    const native = await failure(createEditToolDefinition(cwd).execute("native", input, undefined, undefined, ctx()));
    const error = await failure(call(createEditRecoveryTool(cwd), input));
    expect(error.message).toBe(native.message); expect(error.cause).toBeUndefined();
    expect(await readFile(join(cwd, "source.txt"), "utf8")).toBe(source);
  }
});

test("unknown native errors and fuzzy-only ambiguities are unchanged", async () => {
  for (const [source, oldText] of [["one\n", "absent"], ["“value”\n“value”\n", '"value"']] as const) {
    await writeFile(join(cwd, "source.txt"), source);
    const input = { path: "source.txt", edits: [{ oldText, newText: "changed" }] };
    const expected = await failure(createEditToolDefinition(cwd).execute("native", input, undefined, undefined, ctx()));
    const observed = observedOperations();
    const error = await failure(call(createEditRecoveryTool(cwd, observed.operations), input));
    expect(error.message).toBe(expected.message); expect(error.cause).toBeUndefined();
    expect(observed.reads).toHaveLength(1); expect(observed.writes).toEqual([]);
    expect(await readFile(join(cwd, "source.txt"), "utf8")).toBe(source);
  }
});

test("exact recovery evidence does not imply uniqueness under native fuzzy normalization", async () => {
  const original = 'same "target"\nsame “target”\n', path = join(cwd, "quotes.txt");
  await writeFile(path, original);
  const observed = observedOperations();
  const error = await failure(call(createEditRecoveryTool(cwd, observed.operations), {
    path: "quotes.txt", edits: [{ oldText: 'same "target"', newText: "changed" }],
  }));
  expect((error.cause as Error).message).toContain("Found 2 occurrences");
  expect(error.message).not.toContain("locations shown");
  expect(error.message).toContain('1: "same \\"target\\""');
  expect(error.message).toContain('2: "same “target”"');
  expect(error.message).toContain("native fuzzy matching may find more");
  expect(observed.reads).toEqual([path]); expect(observed.writes).toEqual([]);
  expect(await readFile(path, "utf8")).toBe(original);
});

test("successful native edit results, preparation, metadata and CRLF bytes are preserved", async () => {
  const original = "\uFEFFfirst\r\nsecond\r\n";
  const path = join(cwd, "success.txt"), input = { path: "success.txt", edits: [{ oldText: "second", newText: "changed" }] };
  await writeFile(path, original);
  const observed = observedOperations(), tool = createEditRecoveryTool(cwd, observed.operations), native = createEditToolDefinition(cwd);
  const { execute: _wrappedExecute, ...wrappedMetadata } = tool;
  const { execute: _nativeExecute, ...nativeMetadata } = native;
  expect<unknown>(wrappedMetadata).toEqual(nativeMetadata);
  const result = await call(tool, input), changed = await readFile(path);
  expect(changed.toString("utf8")).toBe("\uFEFFfirst\r\nchanged\r\n");
  expect(observed.reads).toEqual([path]); expect(observed.writes).toEqual([path]);
  await writeFile(path, original);
  const expected = await native.execute("native", input, undefined, undefined, ctx());
  expect(result).toEqual(expected); expect(await readFile(path)).toEqual(changed);
});

test("unavailable, invalid and oversized snapshots do not replace the native error", async () => {
  const input = { path: "source.txt", edits: [{ oldText: "x", newText: "changed" }] };
  const originalError = new Error("Read unavailable");
  const unavailable: EditOperations = { access: async () => {}, readFile: async () => { throw originalError; }, writeFile: async () => { throw new Error("Unexpected write"); } };
  expect(await failure(call(createEditRecoveryTool(cwd, unavailable), input))).toBe(originalError);
  for (const buffer of [Buffer.from([255, 10, 120, 10, 120]), Buffer.from("a".repeat(1024 * 1024) + "\nx\nx")]) {
    const operations: EditOperations = { ...unavailable, readFile: async () => buffer };
    const native = createEditToolDefinition(cwd, { operations });
    const expected = await failure(native.execute("native", input, undefined, undefined, ctx()));
    const error = await failure(call(createEditRecoveryTool(cwd, operations), input));
    expect(error.message).toBe(expected.message); expect(error.cause).toBeUndefined();
  }
});

test("bounded recovery reports candidate and context omissions without truncating source lines", async () => {
  const source = Array.from({ length: 7 }, (_, index) => `section ${index + 1}\nshared\nend ${index + 1}\n`).join("");
  await writeFile(join(cwd, "many.txt"), source);
  const error = await failure(call(createEditRecoveryTool(cwd), { path: "many.txt", edits: [{ oldText: "shared", newText: "changed" }] }));
  expect(error.message).toContain("4/7 locations shown");
  expect(error.message).toContain("many.txt:11");
  expect(error.message).not.toContain("many.txt:14");
  expect(error.message).toContain("Make edits[0].oldText unique");
  expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(4096);
  const long = "界🙂".repeat(1000);
  await writeFile(join(cwd, "long.txt"), long + "\nshared\n" + long + "\nshared\n");
  const oversized = await failure(call(createEditRecoveryTool(cwd), { path: "long.txt", edits: [{ oldText: "shared", newText: "changed" }] }));
  expect(oversized.message).toContain('2: "shared"');
  expect(oversized.message).toContain('4: "shared"');
  expect(oversized.message).toContain(", 2 source lines omitted.");
  expect(oversized.message).not.toContain("界");
  expect(Buffer.byteLength(oversized.message)).toBeLessThanOrEqual(4096);
});

test("ambiguity guidance uses only space left after source evidence and omission metadata", async () => {
  const source = `header\n${"a".repeat(3400)}\nshared\nother branch\nshared\nend\n`;
  const path = join(cwd, "budget.txt"); await writeFile(path, source);
  const observed = observedOperations();
  const error = await failure(call(createEditRecoveryTool(cwd, observed.operations), {
    path: "budget.txt", edits: [{ oldText: "shared", newText: "changed" }],
  }));
  expect(error.message).toContain(`2: ${JSON.stringify("a".repeat(3400))}`);
  expect(error.message).toContain("budget.txt:5");
  expect(error.message).not.toContain("locations shown");
  expect(error.message).not.toContain("Next:");
  expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(4096);
  expect(observed.reads).toEqual([path]); expect(observed.writes).toEqual([]);
  expect(await readFile(path, "utf8")).toBe(source);
});

test("overlapping candidate windows retain each source line once and preserve later branch evidence", async () => {
  const lines = ["first branch " + "a".repeat(800), `shared(); shared(); // ${"b".repeat(900)}`,
    "first end " + "c".repeat(500), "second branch " + "d".repeat(300), "shared();", "second end"];
  const path = join(cwd, "overlap.txt"), original = lines.join("\n") + "\n";
  await writeFile(path, original);
  const observed = observedOperations();
  const error = await failure(call(createEditRecoveryTool(cwd, observed.operations), {
    path: "overlap.txt", edits: [{ oldText: "shared();", newText: "changed();" }],
  }));
  expect(error.message).toContain("Found 3 occurrences");
  // Two separate candidates share line 2; each keeps its own location line.
  expect(error.message.split("overlap.txt:2\n").length - 1).toBe(2);
  expect(error.message).toContain("overlap.txt:5");
  for (const [index, line] of lines.entries()) {
    expect(error.message.split(`${index + 1}: ${JSON.stringify(line)}`).length - 1).toBe(1);
  }
  expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(4096);
  expect(observed.reads).toEqual([path]); expect(observed.writes).toEqual([]);
  expect(await readFile(path, "utf8")).toBe(original);
  const branch = lines.slice(3).join("\n"), replacement = branch.replace("shared();", "changed();");
  await call(createEditRecoveryTool(cwd, observed.operations), {
    path: "overlap.txt", edits: [{ oldText: branch, newText: replacement }],
  });
  expect(observed.writes).toEqual([path]);
  expect(await readFile(path, "utf8")).toBe(original.replace(branch, replacement));
});

test("recovery uses the path and edit list captured by the native attempt", async () => {
  const original = "first branch\nshared\nsecond branch\nshared\n";
  const path = join(cwd, "source.txt");
  await writeFile(path, original);
  const observed = observedOperations();
  let started!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tool = createEditRecoveryTool(cwd, { ...observed.operations, async readFile(file) {
    const buffer = await observed.operations.readFile(file);
    started();
    await gate;
    return buffer;
  } });
  const input = { path: "source.txt", edits: [{ oldText: "shared", newText: "changed" }] };
  const pending = failure(call(tool, input));
  await reading;
  input.path = "other.txt";
  input.edits = [{ oldText: "unrelated", newText: "other change" }];
  release();
  const error = await pending;
  expect(error.message).toContain("source.txt:2");
  expect(error.message).toContain("source.txt:4");
  expect(error.message).not.toContain("other.txt");
  expect((error.cause as Error).message).toBe("Found 2 occurrences of the text in source.txt. The text must be unique. Please provide more context to make it unique.");
  expect(observed.reads).toEqual([path]);
  expect(observed.writes).toEqual([]);
  expect(await readFile(path, "utf8")).toBe(original);
});

test("parallel failed calls keep independent native read snapshots", async () => {
  const observed = observedOperations();
  const tool = createEditRecoveryTool(cwd, { ...observed.operations, async readFile(path) {
    const buffer = await observed.operations.readFile(path);
    if (path.endsWith("alpha.txt")) await Bun.sleep(20);
    return buffer;
  } });
  await writeFile(join(cwd, "alpha.txt"), "alpha first\nshared\nalpha last\nshared\n");
  await writeFile(join(cwd, "beta.txt"), "beta first\nshared\nbeta last\nshared\n");
  const [alpha, beta] = await Promise.all(["alpha.txt", "beta.txt"].map(path => failure(call(tool, { path, edits: [{ oldText: "shared", newText: "changed" }] }))));
  expect(alpha!.message).toContain("alpha first"); expect(alpha!.message).not.toContain("beta first");
  expect(beta!.message).toContain("beta first"); expect(beta!.message).not.toContain("alpha first");
  expect(observed.reads.sort()).toEqual([join(cwd, "alpha.txt"), join(cwd, "beta.txt")]);
  expect(observed.writes).toEqual([]);
});

test("an operation failure after write begins is never treated as native ambiguity", async () => {
  const originalError = new Error("Found 2 occurrences of the text in source.txt. The text must be unique. Please provide more context to make it unique.");
  const operations: EditOperations = { access: async () => {}, readFile: async () => Buffer.from("unique\n"), writeFile: async () => { throw originalError; } };
  const error = await failure(call(createEditRecoveryTool(cwd, operations), { path: "source.txt", edits: [{ oldText: "unique", newText: "changed" }] }));
  expect(error).toBe(originalError);
});

test("Pi returns recovery evidence while denied edits never access source", async () => {
  const observed = observedOperations();
  const fixture = await createSdkFixture({ sixTools: true, extensions: [pi => {
    pi.registerTool(createEditRecoveryTool(".", observed.operations));
    pi.on("tool_call", event => {
      if (event.toolName === "edit" && event.input.path === "private.txt") return { block: true, reason: "Fixture edit denied." };
    });
  }] });
  try {
    const source = "first branch\nshared\nsecond branch\nshared\n";
    await writeFile(join(fixture.cwd, "source.txt"), source);
    await writeFile(join(fixture.cwd, "private.txt"), "private evidence\n");
    fixture.setResponses([
      fauxAssistantMessage([
        fauxToolCall("edit", { path: "source.txt", edits: [{ oldText: "shared", newText: "changed" }] }),
        fauxToolCall("edit", { path: "private.txt", edits: [{ oldText: "private", newText: "changed" }] }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("The edit requires more context."),
    ]);
    await fixture.session.prompt("Try the requested edits.");
    const results = fixture.session.messages.filter(message => message.role === "toolResult").filter(message => message.toolName === "edit");
    expect(results).toHaveLength(2);
    expect(results[0]?.isError).toBe(true);
    expect(JSON.stringify(results[0]?.content)).toContain("edits[0].oldText (");
    expect(JSON.stringify(results[0]?.content)).toContain("first branch");
    expect(results[1]?.isError).toBe(true);
    expect(JSON.stringify(results[1]?.content)).toContain("Fixture edit denied.");
    expect(JSON.stringify(results[1]?.content)).not.toContain("private evidence");
    expect(observed.reads).toEqual([join(fixture.cwd, "source.txt")]);
    expect(observed.writes).toEqual([]);
    expect(await readFile(join(fixture.cwd, "source.txt"), "utf8")).toBe(source);
    expect(await readFile(join(fixture.cwd, "private.txt"), "utf8")).toBe("private evidence\n");
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});

test("a multi-line miss names the line that differs instead of only that something did", async () => {
  // The case this exists for, from a measured run: the model copied a field
  // declaration and dropped its ` = null`, got Pi's bare "must match exactly",
  // and spent a turn rereading the file to find out why.
  const source = ["export class VueElement {",
    "  private _styles?: HTMLStyleElement[]",
    "  private _ob?: MutationObserver | null = null",
    "  private _slots?: Record<string, Node[]>",
    "}", ""].join("\n");
  await writeFile(join(cwd, "source.ts"), source);
  const error = await failure(call(createEditRecoveryTool(cwd), { path: "source.ts", edits: [{
    oldText: "  private _styles?: HTMLStyleElement[]\n  private _ob?: MutationObserver | null\n",
    newText: "changed\n" }] }));
  expect(error.message).toContain("its first 1 of 2 lines matched here");
  expect(error.message).toContain("source.ts:2-3");
  // The line it got wrong, in full, so no second read is needed.
  expect(error.message).toContain('3: "  private _ob?: MutationObserver | null = null"');
  expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(source);
});

test("a multi-line anchor must be unique, and is never claimed as a replacement target", async () => {
  // Two equally good anchors say nothing about which hunk was meant.
  await writeFile(join(cwd, "twice.ts"), "a\nb\nzzz\na\nb\nyyy\n");
  const repeated = await failure(call(createEditRecoveryTool(cwd),
    { path: "twice.ts", edits: [{ oldText: "a\nb\nxxx", newText: "changed" }] }));
  expect(repeated.message).not.toContain("oldText (");
  // A whole-file mismatch has no leading run to anchor on.
  await writeFile(join(cwd, "none.ts"), "p\nq\n");
  const unrelated = await failure(call(createEditRecoveryTool(cwd),
    { path: "none.ts", edits: [{ oldText: "r\ns", newText: "changed" }] }));
  expect(unrelated.message).not.toContain("oldText (");
  // The longest matching run wins, so the report points at the first real difference.
  await writeFile(join(cwd, "deep.ts"), "one\ntwo\nthree\nFOUR\n");
  const deep = await failure(call(createEditRecoveryTool(cwd),
    { path: "deep.ts", edits: [{ oldText: "one\ntwo\nthree\nfour", newText: "changed" }] }));
  expect(deep.message).toContain("its first 3 of 4 lines matched here");
  expect(deep.message).toContain('4: "FOUR"');
});
