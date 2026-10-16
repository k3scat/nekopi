import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { join } from "node:path";
import { createDiagnosticMutationTools, type DiagnoseFile } from "../../src/tools/edit/diagnostics.ts";
import { workspaces } from "../helpers/workspace.ts";

const workspace = workspaces("mutation");
afterEach(workspace.cleanup);
const fixture = workspace.make;

/** Record what the provider was asked, so a test can assert it was not called. */
function recorder(report: DiagnoseFile) {
  const asked: string[] = [];
  const diagnose: DiagnoseFile = async (file, signal) => { asked.push(file); return report(file, signal); };
  return { asked, diagnose };
}

/**
 * A provider asked twice: once for the baseline, once after the change.
 *
 * The report is only useful if it names what the edit caused, so every test
 * of the report has to distinguish the two answers.
 */
function sequence(...reports: Array<string | undefined>) {
  const asked: string[] = [];
  const diagnose: DiagnoseFile = async (file) => {
    asked.push(file);
    return reports[Math.min(asked.length, reports.length) - 1];
  };
  return { asked, diagnose };
}

function tools(root: string, diagnose: DiagnoseFile) {
  const created = createDiagnosticMutationTools(root, diagnose);
  return { edit: created.find(tool => tool.name === "edit")!, write: created.find(tool => tool.name === "write")! };
}

const text = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.flatMap(block => block.type === "text" ? [block.text ?? ""] : []).join("\n");

test("a write reports the diagnostic it introduced and not the file's existing ones", async () => {
  const root = await fixture();
  const existing = "a.ts:9:3  error 2304: Cannot find name 'legacy'.";
  const { asked, diagnose } = sequence(existing,
    `${existing}\na.ts:1:14  error 2322: Type 'string' is not assignable to type 'number'.`);
  const { write } = tools(root, diagnose);
  const content = "export const value: number = 'wrong';\n";
  const result = await write.execute("write", { path: "a.ts", content }, undefined, undefined, { cwd: root } as never);
  expect(result.isError).not.toBe(true);
  // Twice: the baseline, then the report it is measured against.
  expect(asked).toEqual(["a.ts", "a.ts"]);
  expect(text(result)).toContain("This edit introduced 1 diagnostic in this file");
  expect(text(result)).toContain("error 2322");
  // The pre-existing error is the file's problem, not this edit's.
  expect(text(result)).not.toContain("2304");
  expect(await readFile(join(root, "a.ts"), "utf8")).toBe(content);
});

test("an edit that breaks nothing appends nothing, however broken the file already is", async () => {
  const root = await fixture({ "a.ts": "export const value = 1;\n" });
  const noisy = ["a.ts:9:3  error 2304: Cannot find name 'legacy'.",
    "a.ts:11:1  warning 6133: 'unused' is declared but never read."].join("\n");
  const { edit } = tools(root, sequence(noisy, noisy).diagnose);
  const result = await edit.execute("edit", { path: "a.ts", edits: [{ oldText: "1", newText: "2" }] },
    undefined, undefined, { cwd: root } as never);
  expect(text(result)).not.toContain("diagnostic");
  expect(text(result)).not.toContain("2304");
  expect(await readFile(join(root, "a.ts"), "utf8")).toBe("export const value = 2;\n");
});

test("a diagnostic that only moved is not reported as introduced", async () => {
  // An edit above a diagnostic shifts its line. Identity is the message, not
  // the position, or every edit would look like it broke something.
  const root = await fixture({ "a.ts": "export const value = 1;\n" });
  const { edit } = tools(root, sequence(
    "a.ts:9:3  error 2304: Cannot find name 'legacy'.",
    "a.ts:14:3  error 2304: Cannot find name 'legacy'.").diagnose);
  const result = await edit.execute("edit", { path: "a.ts", edits: [{ oldText: "1", newText: "2" }] },
    undefined, undefined, { cwd: root } as never);
  expect(text(result)).not.toContain("2304");
});

test("a second copy of a message the file already had is still introduced", async () => {
  const root = await fixture({ "a.ts": "export const value = 1;\n" });
  const one = "a.ts:3:3  error 2304: Cannot find name 'legacy'.";
  const { edit } = tools(root, sequence(one, `${one}\na.ts:8:3  error 2304: Cannot find name 'legacy'.`).diagnose);
  const result = await edit.execute("edit", { path: "a.ts", edits: [{ oldText: "1", newText: "2" }] },
    undefined, undefined, { cwd: root } as never);
  expect(text(result)).toContain("This edit introduced 1 diagnostic");
  expect(text(result)).toContain("2304");
});

test("a clean file before and after is reported as nothing to say", async () => {
  const root = await fixture({ "a.ts": "export const value = 1;\n" });
  const { edit } = tools(root, sequence("No diagnostics.", "No diagnostics.").diagnose);
  const result = await edit.execute("edit", { path: "a.ts", edits: [{ oldText: "1", newText: "2" }] },
    undefined, undefined, { cwd: root } as never);
  expect(result.isError).not.toBe(true);
  expect(text(result)).not.toContain("introduced");
  expect(await readFile(join(root, "a.ts"), "utf8")).toBe("export const value = 2;\n");
});

test("a failed mutation asks for the baseline only, and keeps the native error", async () => {
  const root = await fixture({ "a.ts": "export const value = 1;\n" });
  const { asked, diagnose } = recorder(async () => "a.ts:1:1  error 1: existing");
  const { edit } = tools(root, diagnose);
  await expect(edit.execute("edit", { path: "a.ts", edits: [{ oldText: "absent", newText: "x" }] },
    undefined, undefined, { cwd: root } as never)).rejects.toThrow();
  // The baseline has to be taken before the file changes, so a failing edit
  // spends it. One request on a warm server, against naming what an edit
  // actually broke instead of listing the file's whole history of errors.
  expect(asked).toEqual(["a.ts"]);
});

test("edit recovery feedback survives, and a recovered failure asks for no report", async () => {
  const root = await fixture({ "a.ts": "shared\nshared\n" });
  const { asked, diagnose } = recorder(async () => "a.ts:1:1  error 1: existing");
  const { edit } = tools(root, diagnose);
  const failure = await edit.execute("edit", { path: "a.ts", edits: [{ oldText: "shared", newText: "x" }] },
    undefined, undefined, { cwd: root } as never).catch((error: Error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("edits[0].oldText (");
  // The baseline, and nothing after it: there is no change to diagnose.
  expect(asked).toEqual(["a.ts"]);
});

test("a path outside the workspace is never sent to the provider", async () => {
  const root = await fixture();
  const { asked, diagnose } = recorder(async () => "should not be reached");
  const { write } = tools(root, diagnose);
  for (const path of ["~/outside.ts", "@literal.ts"]) {
    await write.execute("write", { path, content: "export const x = 1;\n" },
      undefined, undefined, { cwd: root } as never).catch(() => undefined);
  }
  expect(asked).toEqual([]);
});

test("a provider failure preserves the successful file change", async () => {
  const root = await fixture();
  const { write } = tools(root, async () => { throw new Error("the server went away"); });
  const content = "export const value = 1;\n";
  const result = await write.execute("write", { path: "a.ts", content }, undefined, undefined, { cwd: root } as never);
  expect(result.isError).not.toBe(true);
  expect(text(result)).toContain("Post-edit diagnostics unavailable");
  expect(text(result)).toContain("the server went away");
  expect(text(result)).toContain("it was not rolled back");
  expect(await readFile(join(root, "a.ts"), "utf8")).toBe(content);
});

test("an unavailable provider appends nothing at all", async () => {
  const root = await fixture();
  const { write } = tools(root, async () => undefined);
  const result = await write.execute("write", { path: "a.ts", content: "export const x = 1;\n" },
    undefined, undefined, { cwd: root } as never);
  expect(text(result)).not.toContain("Post-edit diagnostics");
});

test("an oversized report is replaced by a short notice and the change is kept", async () => {
  const root = await fixture();
  const { write } = tools(root, sequence(undefined, `a.ts:1:1  error 1: ${"x".repeat(5_000)}`).diagnose);
  const content = "export const value = 1;\n";
  const result = await write.execute("write", { path: "a.ts", content }, undefined, undefined, { cwd: root } as never);
  const appended = text(result);
  expect(appended).toContain("report exceeds 4 KiB");
  expect(appended).not.toContain("x".repeat(100));
  expect(await readFile(join(root, "a.ts"), "utf8")).toBe(content);
});

test("the mutation tools keep the native names and say what they append", () => {
  const created = createDiagnosticMutationTools(".", async () => undefined);
  expect(created.map(tool => tool.name)).toEqual(["edit", "write"]);
  for (const tool of created) {
    expect(tool.description).toContain("Reports any diagnostic this change introduced");
  }
});
