import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import { createFindTool } from "../../src/tools/find.ts";
import { createSearchTool, type SearchOptions } from "../../src/tools/search.ts";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "nekopi-file-search-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
const search = async (args: Record<string, unknown>, options?: SearchOptions) => {
  const result = await createSearchTool(cwd, options).execute("files", { ...args, outputMode: "files" });
  if (!("files" in result.details)) throw new Error("Expected file search result.");
  return { ...result, details: result.details };
};
const text = (result: Awaited<ReturnType<typeof search>>) => result.content[0]!.text;

async function executable(body: string) {
  const file = join(cwd, "fake-rg");
  await writeFile(file, `#!${process.execPath}\n${body}\n`);
  await chmod(file, 0o700);
  return file;
}

test("explicit content mode returns the same evidence as the default", async () => {
  await writeFile(join(cwd, "source.txt"), "before\n" + "前🙂".repeat(400) + "NEEDLE\nafter\n");
  const tool = createSearchTool(cwd), args = { pattern: "NEEDLE", context: 1 };
  const normal = await tool.execute("default", args);
  const explicit = await tool.execute("content", { ...args, outputMode: "content" });
  expect(explicit).toEqual(normal);
  expect(explicit.details).toHaveProperty("rows");
  expect(explicit.details).not.toHaveProperty("files");
});

test("files mode finds every matching file without counting matching lines or returning source text", async () => {
  await writeFile(join(cwd, "many.txt"), "secret body with NEEDLE\n".repeat(500));
  await writeFile(join(cwd, "other.txt"), "NEEDLE\n");
  await writeFile(join(cwd, "long.txt"), "x".repeat(9 * 1024 * 1024) + "NEEDLE\n");
  const result = await search({ pattern: "NEEDLE", limit: 3 }, { maxStreamBytes: 256 });
  expect(result.isError).not.toBe(true);
  expect([...result.details.files].sort()).toEqual(["long.txt", "many.txt", "other.txt"]);
  expect(result.details).toMatchObject({ observedMatchingFiles: 3, omittedMatchingFiles: 0, scanComplete: true, resultOverflow: false });
  expect(text(result)).not.toContain("secret body");
  for (const field of ["rows", "observedMatchingLines", "omittedMatchingLines", "omittedSpans"]) expect(result.details).not.toHaveProperty(field);
});

test("unique file limits distinguish exact completion from the first extra file", async () => {
  for (const [records, expected] of [
    ["a.txt\0a.txt\0b.txt\0", { observedMatchingFiles: 2, omittedMatchingFiles: 0, scanComplete: true, resultOverflow: false }],
    ["a.txt\0a.txt\0b.txt\0c.txt\0", { observedMatchingFiles: 3, omittedMatchingFiles: 1, scanComplete: false, resultOverflow: true }],
  ] as const) {
    const file = await executable(`process.stdout.write(${JSON.stringify(records)});`);
    const result = await search({ pattern: "hit", limit: 2 }, { executable: file });
    expect(result.details.files).toEqual(["a.txt", "b.txt"]);
    expect(result.details).toMatchObject(expected);
    expect(result.isError).not.toBe(true);
  }
});

test("NUL framing preserves Unicode and control characters across stream chunks", async () => {
  const name = '前🙂\n"\\\t.txt';
  await writeFile(join(cwd, name), "hit\n");
  const actual = await search({ pattern: "hit" });
  expect(actual.details.files).toEqual([name]);
  expect(text(actual)).toContain(JSON.stringify(name));
  const bytes = Buffer.from(join(cwd, name) + "\0second.txt\0");
  const split = bytes.indexOf(Buffer.from("🙂")) + 2;
  const file = await executable(`process.stdout.write(Buffer.from(${JSON.stringify([...bytes.subarray(0, split)])})); setTimeout(() => process.stdout.write(Buffer.from(${JSON.stringify([...bytes.subarray(split)])})), 20);`);
  const streamed = await search({ pattern: "hit" }, { executable: file });
  expect(streamed.details.files).toEqual([name, "second.txt"]);
  expect(streamed.details.scanComplete).toBe(true);
});

test("files mode shares content scope, glob, case, literal and ignore semantics", async () => {
  await mkdir(join(cwd, ".git"));
  await writeFile(join(cwd, ".git", "private.txt"), "TARGET.x\n");
  await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
  await writeFile(join(cwd, "ignored.txt"), "TARGET.x\n");
  await writeFile(join(cwd, ".hidden.txt"), "TARGET.x\n");
  await writeFile(join(cwd, "literal.txt"), "target.x\n");
  await writeFile(join(cwd, "regex.txt"), "targetax\n");
  await writeFile(join(cwd, "exclude.ts"), "TARGET.x\n");
  const args = { pattern: "target.x", literal: true, ignoreCase: true };
  expect([...(await search(args)).details.files].sort()).toEqual([".hidden.txt", "exclude.ts", "literal.txt"]);
  const scoped = { ...args, glob: "*.txt" };
  const files = await search(scoped);
  const content = await createSearchTool(cwd).execute("content", scoped);
  if (!("rows" in content.details)) throw new Error("Expected content mode.");
  // Explicit positive globs override gitignore in ripgrep, for both modes.
  expect([...files.details.files].sort()).toEqual([".hidden.txt", "ignored.txt", "literal.txt"]);
  expect([...files.details.files].sort()).toEqual(content.details.rows.map(row => row.path).sort());
  expect([...(await search({ ...args, literal: false })).details.files].sort()).toEqual([".hidden.txt", "exclude.ts", "literal.txt", "regex.txt"]);
  for (const name of ["@literal.txt", "~literal.txt"]) {
    await writeFile(join(cwd, name), "target.x\n");
    for (const path of [name, join(cwd, name)]) expect((await search({ ...args, path })).details.files).toEqual([name.startsWith("@") ? `./${name}` : name]);
  }
  const session = join(cwd, "session");
  await mkdir(session); await writeFile(join(session, "only.txt"), "session\n");
  const result = await createSearchTool(cwd).execute("session", { pattern: "session", path: "only.txt", outputMode: "files" }, undefined, undefined, { cwd: session });
  expect(result.details).toMatchObject({ files: ["only.txt"], scanComplete: true });
});

test("content and files searches honor gitignore without Git metadata", async () => {
  await mkdir(join(cwd, "src"));
  await mkdir(join(cwd, "dist"));
  await writeFile(join(cwd, ".gitignore"), "dist/\n");
  await writeFile(join(cwd, "src", "app.ts"), "export const needle = 1;\n");
  await writeFile(join(cwd, "dist", "app.js"), "export const needle = 1;\n");
  const tool = createSearchTool(cwd);
  for (const outputMode of ["content", "files"] as const) {
    const result = await tool.execute("search", { pattern: "needle", outputMode });
    expect(result.isError).not.toBe(true);
    const output = result.content[0]!.text;
    expect(output).toContain("src/app.ts");
    expect(output).not.toContain("dist/app.js");
    const explicit = await tool.execute("explicit", { pattern: "needle", outputMode, path: "dist/app.js" });
    expect(explicit.content[0]!.text).toContain("dist/app.js");
  }
});

test("ordered glob rules share precise inclusion and exclusion across content and files", async () => {
  const sources = ["src/app.ts", "src/view.tsx", "tests/app.test.ts", "src/api.generated.ts", "vendor/shared.ts", "src/notes.md", ".git/private.ts"];
  for (const path of sources) {
    await mkdir(join(cwd, path, ".."), { recursive: true });
    await writeFile(join(cwd, path), `TARGET ${path}\n`);
  }
  const tool = createSearchTool(cwd);
  const args = { pattern: "TARGET", glob: ["*.{ts,tsx}", "!**/*.generated.ts", "!**/vendor/**"] };
  expect(validateToolArguments(tool, { type: "toolCall", id: "ordered-globs", name: "grep", arguments: args })).toEqual(args);
  const content = await tool.execute("content", args);
  if (!("rows" in content.details)) throw new Error("Expected content mode.");
  const wanted = ["src/app.ts", "src/view.tsx", "tests/app.test.ts"];
  expect(content.details.rows.map(row => row.path).sort()).toEqual(wanted);
  expect(content.details).toMatchObject({ scanComplete: true, observedMatchingLines: 3, omittedSpans: 0 });
  for (const row of content.details.rows) expect(row.excerpts[0]!.text).toBe(`TARGET ${row.path}`);
  const files = await search(args);
  expect([...files.details.files].sort()).toEqual(wanted);
  expect(files.details).toMatchObject({ scanComplete: true, observedMatchingFiles: 3, omittedMatchingFiles: 0 });

  // This later inclusion restores generated TypeScript, while vendor stays excluded.
  const restored = await search({ ...args, glob: [...args.glob, "**/*.generated.ts"] });
  expect([...restored.details.files].sort()).toEqual(["src/api.generated.ts", ...wanted].sort());
  const scalar = await search({ pattern: "TARGET", glob: "*.{ts,tsx}" });
  const singleton = await search({ pattern: "TARGET", glob: ["*.{ts,tsx}"] });
  expect({ ...singleton.details, files: [...singleton.details.files].sort() })
    .toEqual({ ...scalar.details, files: [...scalar.details.files].sort() });
});

test("multiple literal roots retain exact scope, ignores, context and shared bounds", async () => {
  const sources = ["src/app.txt", "src/ignored.txt", "tests/app.txt", "outside.txt", "@literal.txt", "~literal.txt", "-literal.txt"];
  await mkdir(join(cwd, "src")); await mkdir(join(cwd, "tests"));
  await writeFile(join(cwd, "src", ".ignore"), "ignored.txt\n");
  for (const name of sources) await writeFile(join(cwd, name), `before ${name}\nTARGET ${name}\nafter ${name}\n`);
  const tool = createSearchTool(cwd);
  const args = { pattern: "TARGET", path: ["src", join(cwd, "tests")], context: 1 };
  const content = await tool.execute("roots", args);
  if (!("rows" in content.details)) throw new Error("Expected content mode.");
  expect(content.details).toMatchObject({ scanComplete: true, observedMatchingLines: 2, omittedSpans: 0 });
  expect(content.details.rows.map(row => `${row.path}:${row.line}`).sort())
    .toEqual(["src/app.txt:1", "src/app.txt:2", "src/app.txt:3", "tests/app.txt:1", "tests/app.txt:2", "tests/app.txt:3"]);
  for (const row of content.details.rows) {
    const source = (await readFile(join(cwd, row.path), "utf8")).split("\n")[row.line - 1]!;
    expect(row.excerpts).toEqual([{ start: 0, end: Buffer.byteLength(source), text: source }]);
  }
  expect([...(await search(args)).details.files].sort()).toEqual(["src/app.txt", "tests/app.txt"]);
  for (const mode of ["content", "files"] as const) {
    const limited = await tool.execute("limit", { ...args, outputMode: mode, limit: 1 });
    // Content mode now counts past the row limit, so its scan completes;
    // files mode still stops at the first matching paths it needs.
    expect(limited.details).toMatchObject({ scanComplete: mode === "content", resultOverflow: true });
    if ("rows" in limited.details) expect(limited.details.rows.filter(row => row.kind === "match")).toHaveLength(1);
    else expect(limited.details.files).toHaveLength(1);
  }
  expect([...(await search({ pattern: "TARGET", path: ["src/ignored.txt", "@literal.txt", "~literal.txt", "-literal.txt"], glob: ["!*.txt"] })).details.files].sort())
    .toEqual(["-literal.txt", "./@literal.txt", "src/ignored.txt", "~literal.txt"]);
  for (const mode of ["content", "files"] as const) {
    expect(await tool.execute("list", { pattern: "TARGET", path: ["src/app.txt"], outputMode: mode }))
      .toEqual(await tool.execute("scalar", { pattern: "TARGET", path: "src/app.txt", outputMode: mode }));
  }
});

test("multiple roots disclose overlap and retain valid evidence when one root fails", async () => {
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src", "app.txt"), "TARGET\n");
  const tool = createSearchTool(cwd);
  for (const outputMode of ["content", "files"] as const) {
    const overlap = await tool.execute("overlap", { pattern: "TARGET", path: ["src", "src/app.txt"], outputMode });
    expect(overlap.details.scanComplete).toBe(true);
    if ("rows" in overlap.details) expect(overlap.details.rows.map(row => [row.path, row.line])).toEqual([["src/app.txt", 1], ["src/app.txt", 1]]);
    else expect(overlap.details.files).toEqual(["src/app.txt"]);
    const failed = await tool.execute("partial", { pattern: "TARGET", path: ["src", "absent"], outputMode });
    expect(failed.isError).toBe(true);
    expect(failed.details.scanComplete).toBe(false);
    expect(failed.details.errors.length).toBeGreaterThan(0);
    if ("rows" in failed.details) expect(failed.details.rows.map(row => row.path)).toEqual(["src/app.txt"]);
    else expect(failed.details.files).toEqual(["src/app.txt"]);
    expect(failed.content[0]!.text).toContain("Search error: ");
  }
});

test("malformed path lists fail before starting ripgrep", async () => {
  const marker = join(cwd, "spawned-paths");
  const file = await executable(`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "spawned");`);
  const tool = createSearchTool(cwd, { executable: file });
  for (const path of [[], [""], ["src", 1], Array(65).fill("src"), Array(1), 1, null, {}]) {
    await expect(tool.execute("invalid-paths", { pattern: "TARGET", path })).rejects.toThrow("Invalid search parameters");
  }
  for (const path of [[], [""], Array(65).fill("src"), {}]) {
    expect(() => validateToolArguments(tool, { type: "toolCall", id: "invalid-paths", name: "grep", arguments: { pattern: "TARGET", path } })).toThrow();
  }
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("malformed glob lists fail before starting ripgrep", async () => {
  const marker = join(cwd, "spawned-globs");
  const file = await executable(`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "spawned");`);
  const tool = createSearchTool(cwd, { executable: file });
  for (const glob of [[], [""], ["*.ts", 1], Array(17).fill("*.ts"), Array(1), 1, null, {}]) {
    const args = { pattern: "TARGET", glob };
    await expect(tool.execute("invalid-globs", args)).rejects.toThrow("Invalid search parameters");
  }
  // Pi can coerce numbers to strings. Check structural schema errors separately from raw calls.
  for (const glob of [[], [""], Array(17).fill("*.ts"), {}]) {
    expect(() => validateToolArguments(tool, { type: "toolCall", id: "invalid-globs", name: "grep", arguments: { pattern: "TARGET", glob } })).toThrow();
  }
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("binary resolution preserves the requested scope when the caller reuses its path and glob lists", async () => {
  await mkdir(join(cwd, "scope")); await mkdir(join(cwd, "outside"));
  await writeFile(join(cwd, "scope", "app.ts"), "TARGET application\n");
  await writeFile(join(cwd, "scope", "api.generated.ts"), "TARGET generated\n");
  await writeFile(join(cwd, "outside", "app.ts"), "TARGET outside requested roots\n");
  const glob = ["*.ts", "!*.generated.ts"];
  const path = ["scope"];
  const pending = search({ pattern: "TARGET", path, glob });
  glob.push("*.generated.ts");
  path.push("outside");
  const result = await pending;
  expect(result.details.files).toEqual(["scope/app.ts"]);
  expect(result.details.scanComplete).toBe(true);
});

test("files context is explicitly inapplicable and unknown modes or invalid ranges are rejected before spawning", async () => {
  const marker = join(cwd, "spawned");
  const file = await executable(`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2))); process.stdout.write("found.txt\\0");`);
  const tool = createSearchTool(cwd, { executable: file });
  const invalidParameters: JsonObject[] = [{ outputMode: "unknown" }, { outputMode: 1 }, { outputMode: "files", limit: 0 }, { outputMode: "files", context: 21 }];
  for (const params of invalidParameters) {
    const arguments_ = { pattern: "hit", ...params };
    expect(() => validateToolArguments(tool, { type: "toolCall", id: "invalid", name: "grep", arguments: arguments_ })).toThrow();
    await expect(tool.execute("invalid", arguments_)).rejects.toThrow("Invalid search parameters");
  }
  expect(await Bun.file(marker).exists()).toBe(false);
  const result = await search({ pattern: "hit", context: 20 }, { executable: file });
  expect(result.details.files).toEqual(["found.txt"]);
  const argv = JSON.parse(await readFile(marker, "utf8"));
  expect(argv).toContain("--files-with-matches"); expect(argv).toContain("--null");
  expect(argv).not.toContain("--json"); expect(argv).not.toContain("--context");
});

test("display budgets omit whole path identities while retaining later paths and exact omission counts", async () => {
  const long = "界".repeat(200) + ".txt", short = "short.txt";
  const file = await executable(`process.stdout.write(${JSON.stringify(long + "\0" + short + "\0")});`);
  const result = await search({ pattern: "hit" }, { executable: file, maxOutputBytes: 1024 });
  expect(result.details).toMatchObject({ files: [short], observedMatchingFiles: 2, omittedMatchingFiles: 1, scanComplete: true, outputTruncated: true });
  expect(text(result)).toContain(short);
  expect(text(result)).not.toContain("界");
  expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(1024);
});

test("long regex errors retain the failure reason in both search modes", async () => {
  const pattern = Array.from({ length: 40 }, (_, index) => `symbol${index}`).join("|") + "(";
  const tool = createSearchTool(cwd, { maxOutputBytes: 1024 });
  for (const outputMode of ["content", "files"] as const) {
    const result = await tool.execute("invalid-regex", { pattern, outputMode });
    const visible = result.content[0]!.text;
    expect(result.isError).toBe(true);
    expect(result.details.scanComplete).toBe(false);
    const diagnostic = visible.split("\n").find(line => line.startsWith("Search error: "));
    expect(diagnostic).toBeDefined();
    const message = JSON.parse(diagnostic!.slice("Search error: ".length));
    expect(message).toContain("regex parse error");
    expect(message).toContain("error: unclosed group");
    expect(message).toContain("[... omitted ...]");
    expect(Buffer.byteLength(visible)).toBeLessThanOrEqual(1024);
    expect(result.details.errors.join("\n")).toContain(pattern);
  }
});

test("empty matches and invalid regex are distinct, and partial errors preserve complete paths", async () => {
  await writeFile(join(cwd, "source.txt"), "hit\n");
  const empty = await search({ pattern: "absent" });
  expect(empty.details).toMatchObject({ files: [], scanComplete: true, observedMatchingFiles: 0 });
  expect(text(empty)).toContain("No matching files found.");
  const invalid = await search({ pattern: "[" });
  expect(invalid.isError).toBe(true); expect(invalid.details.scanComplete).toBe(false);
  expect(text(invalid)).toContain("regex parse error"); expect(text(invalid)).not.toContain("No matching files found");
  const file = await executable('process.stdout.write("retained.txt\\0"); process.stderr.write("Permission denied\\n" + "\\x01".repeat(10000)); process.exitCode = 2;');
  const partial = await search({ pattern: "hit" }, { executable: file, maxOutputBytes: 1024 });
  expect(partial.isError).toBe(true);
  expect(partial.details).toMatchObject({ files: ["retained.txt"], scanComplete: false });
  expect(Buffer.byteLength(text(partial))).toBeLessThanOrEqual(1024);
  expect(Buffer.byteLength(partial.details.errors.join(""))).toBeLessThanOrEqual(8192);
  const missing = await search({ pattern: "hit" }, { executable: join(cwd, "missing-rg") });
  expect(missing.isError).toBe(true); expect(missing.details.scanComplete).toBe(false);
  expect(text(missing)).not.toContain("No matching files found");
});

test("truncated streams, malformed filenames and abnormal exits never claim complete discovery", async () => {
  const cases = [
    { body: 'process.stdout.write("kept.txt\\0" + "x".repeat(1000));', stream: 32, error: "stream byte limit" },
    { body: 'process.stdout.write("kept.txt\\0unterminated");', error: "unterminated filename" },
    { body: 'process.stdout.write(Buffer.from([107, 101, 112, 116, 46, 116, 120, 116, 0, 255, 0]));', error: "non-UTF-8" },
    { body: 'process.stdout.write("kept.txt\\0\\0");', error: "Invalid" },
    { body: 'process.stdout.write("kept.txt\\0"); process.exitCode = 2;', error: "exited 2" },
  ];
  for (const item of cases) {
    const file = await executable(item.body);
    const result = await search({ pattern: "hit" }, { executable: file, ...(item.stream ? { maxStreamBytes: item.stream } : {}) });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ files: ["kept.txt"], scanComplete: false });
    expect(text(result)).toContain(item.error); expect(text(result)).not.toContain("No matching files found");
  }
});

test("files cancellation waits for the child and pre-canceled requests do not spawn", async () => {
  const marker = join(cwd, "pid");
  const file = await executable(`import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => {}); writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const controller = new AbortController();
  const call = createSearchTool(cwd, { executable: file }).execute("cancel", { pattern: "hit", outputMode: "files" }, controller.signal);
  const handled = call.then(() => { throw new Error("Search unexpectedly completed"); }, (error: Error) => error);
  let pid: number | undefined;
  try {
    for (let count = 0; count < 100; count++) {
      try { pid = Number(await readFile(marker, "utf8")); break; } catch { await Bun.sleep(10); }
    }
    expect(pid).toBeDefined(); controller.abort();
    expect((await handled).name).toBe("AbortError");
    expect(() => process.kill(pid!, 0)).toThrow();
    await rm(marker);
    await expect(createSearchTool(cwd, { executable: file }).execute("pre-cancel", { pattern: "hit", outputMode: "files" }, controller.signal)).rejects.toThrow();
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally { controller.abort(); await handled; }
});

test("find excludes .git and keeps the limit for real files", async () => {
  // Pi's own find walks .git, and grep has excluded it from the start, so the
  // two search tools disagreed about what belongs to a project. This only
  // became visible when bench workspaces became repositories; a real
  // repository always has one, so every real user was seeing the noise.
  const root = await mkdtemp(join(tmpdir(), "nekopi-find-git-"));
  try {
    await mkdir(join(root, ".git/hooks"), { recursive: true });
    await writeFile(join(root, ".git/config"), "[core]\n");
    await writeFile(join(root, ".git/hooks/pre-commit.sample"), "#!/bin/sh\n");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "src/b.ts"), "export const b = 2;\n");
    await writeFile(join(root, ".gitignore"), "ignored/\n");
    await mkdir(join(root, "ignored"), { recursive: true });
    await writeFile(join(root, "ignored/c.ts"), "export const c = 3;\n");
    const find = createFindTool(root);
    const run = async (input: Record<string, unknown>) => {
      const result = await find.execute("find", input as never, undefined, undefined, { cwd: root } as never);
      return result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    };
    const all = await run({ pattern: "*" });
    expect(all).not.toContain(".git/");
    expect(all).toContain("src/a.ts");
    // .gitignore itself is a real file and stays.
    expect(all).toContain(".gitignore");
    // .gitignore is honoured even though ripgrep needs a repository to find one.
    expect(all).not.toContain("ignored/c.ts");
    // The limit is spent on real files, which is why the exclusion is in the
    // scan rather than a filter over its results.
    // Order is ripgrep's and varies with its parallelism, so what matters is
    // that the one result is a real file rather than a .git path.
    const capped = await run({ pattern: "*", limit: 1 });
    const shown = capped.split("\n").filter(line => !line.startsWith("Incomplete:") && line);
    expect(shown).toHaveLength(1);
    expect([".gitignore", "src/a.ts", "src/b.ts"]).toContain(shown[0]);
    expect(capped).toContain("Incomplete:");
    expect((await run({ pattern: "*.ts", path: "src" })).split("\n").sort())
      .toEqual(["src/a.ts", "src/b.ts"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
