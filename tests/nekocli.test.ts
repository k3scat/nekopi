import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { envelopeFiles, runNekocli } from "../src/nekocli.ts";
import { NEKOCLI_GUIDANCE } from "../src/prompt.ts";
import { createSdkFixture } from "./helpers/model-server.ts";

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nekocli-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const git = (args: string[]) => Bun.spawn(["git", "-c", "user.email=a@b", "-c", "user.name=a", ...args],
    { cwd: root, stdout: "ignore", stderr: "ignore" }).exited;
  await git(["init", "-q", "-b", "main"]);
  await git(["add", "-A"]);
  await git(["commit", "-qm", "start"]);
  return root;
}
const run = (root: string, argv: string[], stdin = "") =>
  runNekocli(argv, root, async () => stdin);

test("read rejects malformed ranges and conflicting selectors before looking up files", async () => {
  const root = await workspace({ "sample.ts": "export function parse() { return 1; }\n" });
  try {
    for (const range of ["1-2-3", "1--2", "1-", "1,", "", "1e2", "0x10", "0", "2-1"]) {
      await expect(run(root, ["read", "sample.ts", "--lines", range])).rejects.toThrow("inclusive spans");
    }
    for (const file of [[], ["sample.ts"]]) {
      await expect(run(root, ["read", ...file, "--symbol", "parse", "--lines", "1-2"]))
        .rejects.toThrow("use one of them");
    }
    expect((await run(root, ["read", "sample.ts", "--lines", "1"])).text).toContain("export function parse");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("one command reaches search, read and the semantic layer", async () => {
  const root = await workspace({
    "src/m.ts": "export function add(a: number, b: number) {\n  return a + b;\n}\n",
    "src/u.ts": 'import { add } from "./m";\nexport const x = add(1, 2);\n',
    "src/parser/table.ts": "export const rows = 1;\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
  });
  try {
    expect((await run(root, ["--help"])).text).toContain("nekocli <command>");
    // Search hits carry the symbol that contains them, which is the half of the
    // trade that pays for capping output.
    const grep = await run(root, ["grep", "add", "src", "--context", "1"]);
    expect(grep.text).toContain("src/m.ts");
    expect(grep.text).toContain("[function add]");
    const found = await run(root, ["find", "*.ts", "src"]);
    expect(found.text.split("\n").sort()).toEqual(["src/m.ts", "src/parser/table.ts", "src/u.ts"]);
    // A glob with no slash used to match basenames only. A measured run asked
    // `find '*autolink*' .` where the work sat in a directory of that name and
    // was told nothing matched, so the directory counts as well now.
    const byDirectory = await run(root, ["find", "*parser*", "."]);
    expect(byDirectory.text.split("\n").sort()).toEqual(["src/parser/table.ts"]);
    // A glob that names a path keeps its exact meaning.
    expect((await run(root, ["find", "src/*.ts"])).text.split("\n").sort())
      .toEqual(["src/m.ts", "src/u.ts"]);
    // A declaration by name, which is not a parameter on the `read` tool.
    expect((await run(root, ["read", "src/m.ts", "--symbol", "add"])).text).toContain("export function add");
    expect((await run(root, ["read", "src/m.ts", "--lines", "1-2"])).text).toContain("1: export function add");
    await expect(run(root, ["read", "src/m.ts", "--lines", "1-2", "--symbol", "add"]))
      .rejects.toThrow("use one of them");
    // A guessed path was 18 of 61 failed reads in a measured batch, and ENOENT
    // alone costs a round trip to recover from.
    await expect(run(root, ["read", "src/deep/nested/table.ts"]))
      .rejects.toThrow("Files with that name: src/parser/table.ts");
    // A name nothing matches still reports the plain failure, with nothing added.
    await expect(run(root, ["read", "src/absent.ts"])).rejects.toThrow(/ENOENT|no such file/);
    // A `--symbol` miss is scoped to one file, so on its own it cannot say
    // whether the name exists. A measured batch shows the model answering that
    // by guessing another file, so the three answers are separated here.
    await expect(run(root, ["read", "src/u.ts", "--symbol", "add"]))
      .rejects.toThrow("add is declared in 1 place(s):\n  src/m.ts:1");
    await expect(run(root, ["read", "src/m.ts", "--symbol", "rows"]))
      .rejects.toThrow("src/parser/table.ts:1");
    // A name that is only ever used is not a declaration, and saying so is
    // different from saying it is absent.
    await expect(run(root, ["read", "src/parser/table.ts", "--symbol", "number"]))
      .rejects.toThrow("used rather than declared");
    await expect(run(root, ["read", "src/m.ts", "--symbol", "subtract"]))
      .rejects.toThrow("appears nowhere in the workspace");
    // Seven debrief answers asked for the near name to be named. It was in
    // the declared list, ordered by depth and cut at 24, and the workspace
    // line then contradicted it: a word boundary does not match inside a
    // longer identifier, so "adder" was reported as absent.
    const near = await run(root, ["read", "src/m.ts", "--symbol", "ad"])
      .then(() => "resolved", (error: Error) => error.message);
    expect(near).toContain("Did you mean add?");
    expect(near).not.toContain("appears nowhere");
    // A name with no file at all, which is the shape the model actually has.
    // One declaration answers with the source; several name the places.
    const only = await run(root, ["read", "--symbol", "add"]);
    expect(only.text).toContain("src/m.ts:1");
    expect(only.text).toContain("export function add");
    await expect(run(root, ["read", "--symbol", "nowhere"]))
      .resolves.toMatchObject({ text: expect.stringContaining("appears nowhere") });
    await expect(run(root, ["read"])).rejects.toThrow("read needs a file, or --symbol with a name");
    // Two measured runs wrote several --glob rules, which the search tool has
    // always accepted and the flag reader dropped all but the first of, leaving
    // `--glob` itself to be read as a path.
    const several = await run(root, ["grep", "add|rows", "--glob", "*.ts", "--glob", "*.json"]);
    expect(several.text).toContain("src/m.ts");
    expect(several.text).toContain("src/parser/table.ts");
    // Three measured runs pointed a search at a path that was not there.
    // ripgrep reported it as an absolute IO error and still exited 0, so a
    // chained command ran on as though the search had found nothing.
    await expect(run(root, ["grep", "add", "tests"])).rejects.toThrow("no such path: tests");
    await expect(run(root, ["find", "*.ts", "tests"])).rejects.toThrow("no such path: tests");
    expect((await run(root, ["find", "[", "src"])).failed).toBe(true);
    await expect(run(root, ["find", "*.ts", "src", "--typo"])).rejects.toThrow("unexpected argument");
    await expect(run(root, ["read", "src/m.ts", "--typo"])).rejects.toThrow("unexpected argument");
    await expect(run(root, ["grep", "rows", "src/parser"]))
      .resolves.toMatchObject({ text: expect.stringContaining("table.ts") });
    // The model chains several subcommands into one call, so a failure has to
    // say which of them refused.
    await expect(run(root, ["read", "src/absent.ts"])).rejects.toThrow(/^read: ENOENT/u);
    await expect(run(root, ["grep"])).rejects.toThrow("grep needs a pattern");
    await expect(run(root, ["nonsense"])).rejects.toThrow("unknown command");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("grep can search literal punctuation through either fixed flag", async () => {
  const root = await workspace({ "src/search.txt": "a.b\naxb\n[\n" });
  try {
    expect((await run(root, ["grep", "a.b", "src/search.txt"])).text).toContain("2: axb");
    for (const flag of ["-F", "--fixed"]) {
      const result = await run(root, ["grep", "a.b", "src/search.txt", flag]);
      expect(result.failed).toBeUndefined();
      expect(result.text).toContain("1: a.b");
      expect(result.text).not.toContain("2: axb");
      expect((await run(root, ["grep", "[", "src/search.txt", flag, "--files"])).text)
        .toContain("src/search.txt");
    }
    const invalid = await run(root, ["grep", "[", "src/search.txt"]);
    expect(invalid.failed).toBe(true);
    expect(invalid.text).toContain("regex parse error");
    expect(invalid.text).toContain("Use -F or --fixed for literal text");
    expect((await run(root, ["grep", "[", "src/search.txt", "-F"])).text).toContain("3: [");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("grep names the allowed context range", async () => {
  await expect(runNekocli(["grep", "needle", "--context", "22"]))
    .rejects.toThrow("grep: --context accepts 0-20 lines");
});

test("grep accepts -g and --glob as ordered repeated rules", async () => {
  const root = await workspace({
    "src/keep.ts": "NEEDLE\n",
    "src/skip.ts": "NEEDLE\n",
    "src/skip.txt": "NEEDLE\n",
  });
  try {
    const narrow = await run(root, ["grep", "NEEDLE", "src", "--glob", "*.ts", "-g", "!skip.ts", "--files"]);
    expect(narrow.failed).toBeUndefined();
    expect(narrow.text).toContain("src/keep.ts");
    expect(narrow.text).not.toContain("src/skip.ts");
    expect(narrow.text).not.toContain("src/skip.txt");
    const restored = await run(root, ["grep", "NEEDLE", "src", "-g", "!skip.ts", "--glob", "*.ts", "--files"]);
    expect(restored.text).toContain("src/keep.ts");
    expect(restored.text).toContain("src/skip.ts");
    await expect(run(root, ["grep", "NEEDLE", "src", "-g"])).rejects.toThrow("-g needs a value");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("grep searches shell-expanded paths and reports missing paths beside partial hits", async () => {
  const files = Object.fromEntries(Array.from({ length: 20 }, (_, index) =>
    [`src/file${index}.ts`, `export const value${index} = "NEEDLE";\n`]));
  const root = await workspace(files);
  try {
    const paths = Object.keys(files);
    const many = await run(root, ["grep", "NEEDLE", ...paths]);
    expect(many.failed).toBeUndefined();
    expect(paths.every(path => many.text.includes(path))).toBe(true);
    const partial = await run(root, ["grep", "NEEDLE", "src/file0.ts", "src/absent.ts"]);
    expect(partial.failed).toBe(true);
    expect(partial.text).toContain("src/file0.ts");
    expect(partial.text).toContain("Incomplete: no such path: src/absent.ts.");
    expect(partial.text).not.toContain("src/file1.ts");
    await expect(run(root, ["grep", "NEEDLE", ...Array(65).fill("src/file0.ts")]))
      .rejects.toThrow("too many paths (65; maximum 64). Search a parent directory with --glob");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("grep bounds broad results and gives CLI recovery instructions", async () => {
  const lines = Array.from({ length: 600 }, (_, index) => `export const match${index} = "${"x".repeat(90)}";`);
  const root = await workspace({ "src/many.ts": `${lines.join("\n")}\n` });
  try {
    const result = await run(root, ["grep", "match", "src/many.ts", "--limit", "600"]);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(50 * 1024);
    expect(result.text).toContain("Incomplete:");
    expect(result.text).toContain("use --files.");
    expect(result.text).not.toContain("outputMode: files");
    expect((await run(root, ["grep", "match", "--files"])).text).toContain("src/many.ts");
    expect((await run(root, ["grep", "[", "src/many.ts"])).failed).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("read continuations use executable CLI ranges and retain the first source lines", async () => {
  const source = Array.from({ length: 400 }, (_, index) =>
    `export function step${index}() { return "${"x".repeat(300)}"; }`).join("\n") + "\n";
  const root = await workspace({ "big.ts": source, "it's.ts": source });
  try {
    const first = await run(root, ["read", "big.ts"]);
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(48 * 1024);
    expect(first.text).toStartWith('File "big.ts"\nSource lines 1-');
    expect(first.text).toContain("1: export function step0()");
    expect(first.text).toContain("Shape of big.ts");
    expect(first.text).toMatch(/nek read 'big\.ts' --lines \d+-\d+/u);
    expect(first.text).not.toContain("Use offset=");
    const last = [...first.text.matchAll(/^(\d+): export function step\d+/gmu)].at(-1);
    expect(last).toBeDefined();
    expect(first.text).toContain(`Source lines 1-${last![1]}.`);

    const limited = await run(root, ["read", "it's.ts", "--limit", "5"]);
    expect(limited.text).toContain("nek read 'it'\\''s.ts' --lines 6-205");
    expect(limited.text).not.toContain("Use offset=");

    const selected = await run(root, ["read", "big.ts", "--lines", "1-350"]);
    expect(Buffer.byteLength(selected.text)).toBeLessThanOrEqual(48 * 1024);
    expect(selected.text).toContain("1: export function step0()");
    expect(selected.text).toMatch(/Continue with nek read 'big\.ts' --lines \d+-350/u);
    expect(selected.text).not.toContain("ranges=[");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("patch applies several files at once and names the text it could not find", async () => {
  const root = await workspace({ "a.txt": "one\ntwo\nthree\n", "b.txt": "alpha\n" });
  try {
    const diff = ["--- a/a.txt", "+++ b/a.txt", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three",
      "--- a/b.txt", "+++ b/b.txt", "@@ -1 +1,2 @@", " alpha", "+beta", ""].join("\n");
    const applied = await run(root, ["patch"], diff);
    expect(applied.failed).toBeUndefined();
    expect(applied.text).toContain("a.txt");
    expect(applied.text).toContain("b.txt");
    expect(await Bun.file(join(root, "a.txt")).text()).toBe("one\nTWO\nthree\n");
    expect(await Bun.file(join(root, "b.txt")).text()).toBe("alpha\nbeta\n");
    // A stale hunk fails without applying, and prints what it searched for,
    // which is what four tooling audits asked for.
    const stale = ["--- a/a.txt", "+++ b/a.txt", "@@ -1,3 +1,3 @@", " one", "-WRONG", "+x", " three", ""].join("\n");
    const conflict = await run(root, ["patch"], stale);
    expect(conflict.failed).toBe(true);
    expect(conflict.text).toContain("while searching for");
    expect(conflict.text).toContain("WRONG");
    expect(await Bun.file(join(root, "a.txt")).text()).toBe("one\nTWO\nthree\n");
    await expect(run(root, ["patch"], "  ")).rejects.toThrow("unified diff");
    await expect(run(root, ["patch", "--dryrun"], diff)).rejects.toThrow("unexpected argument");
    expect(await Bun.file(join(root, "a.txt")).text()).toBe("one\nTWO\nthree\n");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("edit takes one shape, and write stays inside the workspace", async () => {
  const root = await workspace({ "a.ts": "export const a = 1;\n" });
  try {
    const edited = await run(root, ["edit", "a.ts"], '[{"oldText": "a = 1", "newText": "a = 42"}]');
    expect(edited.text).toContain("1 block");
    expect(await Bun.file(join(root, "a.ts")).text()).toBe("export const a = 42;\n");
    // Shell quoting cannot carry a newline, so a flag form is not offered and
    // malformed stdin points at the command that can.
    await expect(run(root, ["edit", "a.ts"], "oldText=a")).rejects.toThrow("patch for a unified diff");
    const written = await run(root, ["write", "new/b.ts"], "export const b = 2;\n");
    expect(written.text).toContain("new/b.ts");
    expect(await Bun.file(join(root, "new/b.ts")).text()).toBe("export const b = 2;\n");
    await expect(run(root, ["write", "../escape.ts"], "x")).rejects.toThrow("inside the workspace");
    await expect(run(root, ["write", "new/b.ts", "--typo"], "x")).rejects.toThrow("unexpected argument");
    expect(await Bun.file(join(root, "new/b.ts")).text()).toBe("export const b = 2;\n");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("the shell mode sends one tool and one prompt section instead of five schemas", async () => {
  const fixture = await createSdkFixture({ useDefaultSystemPrompt: true,
    globalConfig: { nekocli: { enabled: true } } });
  try {
    fixture.setResponses([context => {
      const tools = getCurrentTools(context.messages).map(tool => tool.name);
      // The five the command covers are not sent at all; registering and
      // deactivating them would still cost their schemas.
      expect(tools).toContain("bash");
      for (const covered of ["grep", "find", "read", "edit", "write"]) expect(tools).not.toContain(covered);
      const prompt = getCurrentSystemPrompt(context.messages);
      expect(prompt).toContain(NEKOCLI_GUIDANCE);
      // Pi tells the model to use bash for `ls, rg, find` when no such tool is
      // selected, so the section has to supersede it rather than sit beside it.
      expect(prompt).toContain("Prefer it to rg, cat and sed");
      return fauxAssistantMessage("Ready.");
    }]);
    await fixture.session.prompt("Report readiness.");
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});

test("the six tool shape is reached by setting nekocli.enabled to false", async () => {
  const fixture = await createSdkFixture({ useDefaultSystemPrompt: true, sixTools: true });
  try {
    fixture.setResponses([context => {
      const tools = getCurrentTools(context.messages).map(tool => tool.name);
      for (const covered of ["grep", "find", "read", "edit", "write", "bash"]) expect(tools).toContain(covered);
      expect(getCurrentSystemPrompt(context.messages)).not.toContain("nekocli");
      return fauxAssistantMessage("Ready.");
    }]);
    await fixture.session.prompt("Report readiness.");
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});

test("patch recounts a miscounted hunk without breaking a multi-file diff", async () => {
  const root = await workspace({ "a.txt": "one\ntwo\nthree\n", "b.txt": "alpha\n" });
  try {
    // A model counts lines badly, and a header disagreeing with its body is
    // otherwise "corrupt patch at line N". A measured run lost a turn to it.
    const miscounted = ["--- a/a.txt", "+++ b/a.txt", "@@ -1,9 +1,9 @@", " one", "-two", "+TWO", " three", ""].join("\n");
    const recounted = await run(root, ["patch"], miscounted);
    expect(recounted.failed).toBeUndefined();
    expect(recounted.text).toContain("recounting");
    expect(await Bun.file(join(root, "a.txt")).text()).toBe("one\nTWO\nthree\n");
    // Recounting makes the counts advisory, and the counts delimit a hunk, so
    // it must not be tried before a plain apply: on a multi-file diff it reads
    // the next file's `--- a/...` header as a removal line.
    const multi = ["--- a/a.txt", "+++ b/a.txt", "@@ -1,3 +1,3 @@", " one", "-TWO", "+two", " three",
      "--- a/b.txt", "+++ b/b.txt", "@@ -1 +1,2 @@", " alpha", "+beta", ""].join("\n");
    const both = await run(root, ["patch"], multi);
    expect(both.failed).toBeUndefined();
    expect(both.text).not.toContain("recounting");
    expect(await Bun.file(join(root, "a.txt")).text()).toBe("one\ntwo\nthree\n");
    expect(await Bun.file(join(root, "b.txt")).text()).toBe("alpha\nbeta\n");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("patch accepts the Begin Patch dialect a model reaches for unprompted", async () => {
  const root = await workspace({ "a.ts": "export function f() {\n  // apply CSS\n  return 1;\n}\n", "b.ts": "old\n" });
  try {
    // A measured run wrote this format, got "No valid patches in input" from
    // git, and lost the turn. Its hunks carry no line numbers and match on
    // context alone, which is what an exact-match edit already is.
    const envelope = ["*** Begin Patch", "*** Update File: a.ts", "@@", "   // apply CSS",
      "-  return 1;", "+  return 2;", "*** Add File: c.ts", "+export const c = 3;",
      "*** Delete File: b.ts", "*** End Patch", ""].join("\n");
    const applied = await run(root, ["patch"], envelope);
    expect(applied.failed).toBeUndefined();
    expect(applied.text).toContain("Patched 3 file(s)");
    expect(await Bun.file(join(root, "a.ts")).text()).toBe("export function f() {\n  // apply CSS\n  return 2;\n}\n");
    expect(await Bun.file(join(root, "c.ts")).text()).toBe("export const c = 3;\n");
    expect(await Bun.file(join(root, "b.ts")).exists()).toBe(false);
    // A unified diff is still a unified diff; only the envelope is converted.
    expect(envelopeFiles(["--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-x", "+y"].join("\n"))).toBeUndefined();
    // A hunk that does not match says so and applies nothing.
    const stale = ["*** Begin Patch", "*** Update File: a.ts", "@@", "-  return NOPE;",
      "+  return 3;", "*** End Patch", ""].join("\n");
    const refused = await run(root, ["patch"], stale);
    expect(refused.failed).toBe(true);
    expect(refused.text).toContain("not in the file");
    expect(refused.text).toContain("Nothing was applied");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("patch reports newly introduced syntax errors without refusing the edit", async () => {
  const root = await workspace({
    "good.rs": "fn main() {\n    println!(\"ok\");\n}\n",
    "already.rs": "fn main() {\n    let x = ;\n}\n",
  });
  try {
    const broken = ["*** Begin Patch", "*** Update File: good.rs", "@@", " }", "+}",
      "*** End Patch", ""].join("\n");
    const result = await run(root, ["patch"], broken);
    expect(result.failed).toBeUndefined();
    expect(result.text).toContain("Syntax check: good.rs:4: 1 new parser error(s)");
    expect(await Bun.file(join(root, "good.rs")).text()).toBe("fn main() {\n    println!(\"ok\");\n}\n}\n");

    const unchangedError = ["*** Begin Patch", "*** Update File: already.rs", "@@",
      "-    let x = ;", "+    let x = ; // still incomplete", "*** End Patch", ""].join("\n");
    const second = await run(root, ["patch"], unchangedError);
    expect(second.failed).toBeUndefined();
    expect(second.text).not.toContain("Syntax check:");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("patch --check says whether it would apply and changes nothing", async () => {
  const root = await workspace({ "a.txt": "one\ntwo\nthree\n", "a.ts": "export const a = 1;\n" });
  try {
    const good = ["--- a/a.txt", "+++ b/a.txt", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three", ""].join("\n");
    const would = await run(root, ["patch", "--check"], good);
    expect(would.failed).toBeUndefined();
    expect(would.text).toContain("a.txt");
    expect(await Bun.file(join(root, "a.txt")).text()).toBe("one\ntwo\nthree\n");
    const stale = ["--- a/a.txt", "+++ b/a.txt", "@@ -1,3 +1,3 @@", " one", "-NOPE", "+x", " three", ""].join("\n");
    const wouldNot = await run(root, ["patch", "--check"], stale);
    expect(wouldNot.failed).toBe(true);
    expect(wouldNot.text).toContain("NOPE");
    // The envelope's hunks carry no line numbers, so a check reports where each
    // one was placed. That line is the thing a model can act on: a hunk placed
    // somewhere it did not mean is the failure this dialect makes possible.
    const envelope = ["*** Begin Patch", "*** Update File: a.ts", "@@", "-export const a = 1;",
      "+export const a = 2;", "*** End Patch", ""].join("\n");
    expect((await run(root, ["patch", "--check"], envelope)).text).toContain("placed at line 1");
    expect(await Bun.file(join(root, "a.ts")).text()).toBe("export const a = 1;\n");
    const absent = ["*** Begin Patch", "*** Update File: a.ts", "@@", "-missing", "+x", "*** End Patch", ""].join("\n");
    const missing = await run(root, ["patch", "--check"], absent);
    expect(missing.failed).toBe(true);
    expect(missing.text).toContain("not in the file");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("an envelope writes nothing unless every hunk of every file would apply", async () => {
  const root = await workspace({ "one.ts": "export const a = 1;\n",
    "two.ts": "export const b = 2;\nexport const c = 2;\n" });
  try {
    // `git apply` is atomic and this path was not: it wrote each file as it
    // went. A measured run had the first file changed while the second was
    // ambiguous, missed the partial application, retried, and duplicated a
    // branch in the file that had succeeded.
    const ambiguous = ["*** Begin Patch", "*** Update File: one.ts", "@@", "-export const a = 1;",
      "+export const a = 42;", "*** Update File: two.ts", "@@", "- = 2;", "+ = 99;",
      "*** End Patch", ""].join("\n");
    const refused = await run(root, ["patch"], ambiguous);
    expect(refused.failed).toBe(true);
    expect(refused.text).toContain("appears 2 times");
    expect(refused.text).toContain("Nothing was applied");
    // The first file is untouched, which is the whole point.
    expect(await Bun.file(join(root, "one.ts")).text()).toBe("export const a = 1;\n");
    // A missing file in second position also protects the first.
    const absent = ["*** Begin Patch", "*** Update File: one.ts", "@@", "-export const a = 1;",
      "+export const a = 42;", "*** Update File: gone.ts", "@@", "-x", "+y", "*** End Patch", ""].join("\n");
    const alsoRefused = await run(root, ["patch"], absent);
    expect(alsoRefused.failed).toBe(true);
    expect(await Bun.file(join(root, "one.ts")).text()).toBe("export const a = 1;\n");
    // And when every hunk is good, both files change.
    const good = ["*** Begin Patch", "*** Update File: one.ts", "@@", "-export const a = 1;",
      "+export const a = 42;", "*** Update File: two.ts", "@@", "-export const c = 2;",
      "+export const c = 99;", "*** End Patch", ""].join("\n");
    expect((await run(root, ["patch"], good)).failed).toBeUndefined();
    expect(await Bun.file(join(root, "one.ts")).text()).toBe("export const a = 42;\n");
    expect(await Bun.file(join(root, "two.ts")).text()).toBe("export const b = 2;\nexport const c = 99;\n");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
