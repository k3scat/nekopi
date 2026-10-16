import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { discoveryNote, wanted } from "../../src/tools/bash/discovery.ts";
import { createSdkFixture } from "../helpers/model-server.ts";

test("only the shapes a runner prints are recognized", () => {
  // The three real failures, from five audits that each lost a call to one.
  expect(wanted("ERR_PNPM_NO_SCRIPT  Missing script: typecheck\n"))
    .toEqual({ kind: "script", named: "typecheck" });
  expect(wanted('npm error Missing script: "build:all"'))
    .toEqual({ kind: "script", named: "build:all" });
  expect(wanted("error TS5058: The specified path does not exist: 'packages/x/tsconfig.json'."))
    .toEqual({ kind: "tsconfig", named: "packages/x/tsconfig.json" });
  // An unrelated failure stays quiet, which is most of them.
  for (const quiet of ["", "error: 1 test failed", "fatal: not a git repository",
    "ENOENT: no such file or directory, open 'x.ts'", "Command exited with code 1"]) {
    expect(wanted(quiet)).toBeUndefined();
  }
});

test("the note names what exists and nothing else", async () => {
  const root = await mkdtemp(join(tmpdir(), "nekopi-discovery-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { check: "tsc --noEmit", test: "vitest", "test-unit": "vitest -c u.ts" } }));
    const note = await discoveryNote(root, "ERR_PNPM_NO_SCRIPT  Missing script: typecheck\n");
    expect(note).toContain("check");
    expect(note).toContain("test-unit");
    // The name it guessed is not echoed back as if it existed.
    expect(note).not.toContain("typecheck");
    await mkdir(join(root, "packages/dom"), { recursive: true });
    await writeFile(join(root, "tsconfig.json"), "{}");
    await writeFile(join(root, "packages/dom/tsconfig.build.json"), "{}");
    await mkdir(join(root, "node_modules/dep"), { recursive: true });
    await writeFile(join(root, "node_modules/dep/tsconfig.json"), "{}");
    const configs = await discoveryNote(root,
      "error TS5058: The specified path does not exist: 'packages/dom/tsconfig.json'.");
    expect(configs).toContain("tsconfig.json");
    expect(configs).toContain("packages/dom/tsconfig.build.json");
    // Dependencies are not this project.
    expect(configs).not.toContain("node_modules");
    // Nothing to say where there is nothing to list.
    const bare = await mkdtemp(join(tmpdir(), "nekopi-discovery-bare-"));
    expect(await discoveryNote(bare, "ERR_PNPM_NO_SCRIPT  Missing script: x\n")).toBeUndefined();
    await rm(bare, { recursive: true, force: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed command carries the note, and a successful one carries nothing", async () => {
  const fixture = await createSdkFixture({ loadPackage: true });
  try {
    await writeFile(join(fixture.cwd, "package.json"), JSON.stringify({ scripts: { check: "true" } }));
    fixture.setResponses([
      fauxAssistantMessage(fauxToolCall("bash",
        { command: "echo 'ERR_PNPM_NO_SCRIPT  Missing script: typecheck' >&2; exit 1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo ok" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    ]);
    await fixture.session.prompt("Run the checks.");
    const results = fixture.session.messages.filter(message => message.role === "toolResult");
    expect(JSON.stringify(results[0])).toContain("package.json scripts");
    expect(JSON.stringify(results[0])).toContain("check");
    // Nothing is appended to a command that worked.
    expect(JSON.stringify(results[1])).not.toContain("package.json scripts");
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
}, 20_000);

test("missing Python commands name an executable workspace runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "nekopi-python-discovery-"));
  try {
    const python = join(root, ".venv/bin/python");
    await mkdir(join(root, ".venv/bin"), { recursive: true });
    await writeFile(python, "#!/bin/sh\nexit 0\n");
    await chmod(python, 0o755);

    for (const command of ["python", "pytest"]) {
      const note = await discoveryNote(root,
        `/bin/bash: line 1: ${command}: command not found\n`);
      expect(note).toContain("./.venv/bin/python -m pytest -q path/to/test_file.py::test_name");
      expect(note).not.toContain("passed");
    }

    // A mention in test output is not a Bash command failure.
    for (const output of [
      "python: command not found\n",
      "assertion failed: expected 'pytest: command not found'\n",
      "/bin/bash: line 1: python3: command not found\n",
      "/bin/bash: line 1: python: No module named pytest\n",
    ]) expect(await discoveryNote(root, output)).toBeUndefined();

    await chmod(python, 0o644);
    expect(await discoveryNote(root, "/bin/bash: line 1: python: command not found\n"))
      .toBeUndefined();
    await rm(python);
    expect(await discoveryNote(root, "/bin/bash: line 1: pytest: command not found\n"))
      .toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a native Bash failure carries the Python note through the Pi session", async () => {
  const fixture = await createSdkFixture({ loadPackage: true });
  try {
    const python = join(fixture.cwd, ".venv/bin/python");
    await mkdir(join(fixture.cwd, ".venv/bin"), { recursive: true });
    await writeFile(python, "#!/bin/sh\nexit 0\n");
    await chmod(python, 0o755);
    fixture.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command:
        "printf '/bin/bash: line 1: python: command not found\\n' >&2; exit 127" }),
      { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("bash", { command:
        "printf '/bin/bash: line 1: python: command not found\\n'" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    ]);
    await fixture.session.prompt("Run a focused Python test.");
    const results = fixture.session.messages.filter(message => message.role === "toolResult");
    expect(JSON.stringify(results[0])).toContain("./.venv/bin/python -m pytest -q");
    expect(JSON.stringify(results[1])).not.toContain("./.venv/bin/python -m pytest -q");
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
}, 20_000);

test("a lookalike nekocli is named, and an unrelated missing command is not", async () => {
  // The measured case: a model typed a Cyrillic "нек" and lost seven calls to
  // seven identical "command not found" lines. The glyphs are the only
  // evidence in the output that anything was wrong.
  const cyrillic = "некocli";
  expect(wanted(`/bin/bash: line 1: ${cyrillic}: command not found`))
    .toEqual({ kind: "command", named: cyrillic });
  const note = await discoveryNote(process.cwd(), `/bin/bash: line 1: ${cyrillic}: command not found`);
  expect(note).toContain("\"nekocli\"");
  expect(note).toContain("another alphabet");

  // The shells differ in wording; all of them name the command first.
  expect(wanted("bash: nekocli: command not found")).toEqual({ kind: "command", named: "nekocli" });
  expect(wanted("sh: 1: nekocli: not found")).toEqual({ kind: "command", named: "nekocli" });

  // Correctly spelled and genuinely absent is not a typo, so there is nothing
  // to say that the shell has not already said.
  expect(await discoveryNote(process.cwd(), "bash: nekocli: command not found")).toBeUndefined();
  // Another project's missing command is not ours to guess at.
  expect(await discoveryNote(process.cwd(), "bash: pnpm: command not found")).toBeUndefined();
  expect(await discoveryNote(process.cwd(), "bash: gopls: command not found")).toBeUndefined();
});

test("a Bash octal-quoted Cyrillic short alias is named", async () => {
  const output = String.raw`/bin/bash: line 1: $'\320\275\320\265\320\272': command not found`;
  expect(wanted(output)).toEqual({ kind: "command", named: "нек" });
  const note = await discoveryNote(process.cwd(), output);
  expect(note).toContain('"nek"');
  expect(note).toContain('"нек"');
  expect(note).toContain("another alphabet");

  expect(await discoveryNote(process.cwd(), "bash: нек: command not found")).toContain('"nek"');
  expect(await discoveryNote(process.cwd(), "bash: nek: command not found")).toBeUndefined();
  expect(await discoveryNote(process.cwd(), String.raw`bash: $'\377': command not found`)).toBeUndefined();
});
