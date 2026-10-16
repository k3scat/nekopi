import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { compactRepeatedVitestFailures, compactVitestPreview } from "../../src/tools/bash/compact-vitest.ts";
import { nativeBashFeedback } from "../../src/tools/bash/feedback.ts";

// The error and footer shapes are shortened from a saved Vitest failure. The
// saved stream contains many copies of these errors and stays outside git.
const rejection = (name: string) => `⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯
ReferenceError: styles is not defined
 ❯ resolve packages/runtime-dom/src/apiCustomElement.ts:315:22
    315|       if (__DEV__ && styles && def.shadowRoot === false) {
       |                      ^
This error originated in "packages/runtime-dom/__tests__/customElement.spec.ts" test file.
The latest test that might've caused the error is "${name}".
- The error was thrown, while Vitest was running this test.

`;
const exception = `⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯
TypeError: Cannot set properties of null (setting 'ce')
 ❯ Module.<anonymous> packages/runtime-dom/src/apiCustomElement.ts:262:25
    262|         this._instance!.ce = undefined
       |                         ^
This error originated in "packages/runtime-dom/__tests__/customElement.spec.ts" test file.

`;
const footer = `  Snapshots  1 failed
      Tests  36 failed | 2 passed (39)
     Errors  87 errors
[Showing lines 3047-3655 of 3655 (50.0KB limit). Full output: /tmp/pi-bash-example.log]
Command exited with code 1
`;
const preview = `${rejection("should work").repeat(20)}${rejection("with slots")}${exception.repeat(8)}${exception}${footer}`
  .replace("      Tests", "\x1b[2m      Tests\x1b[22m");

function event(text = preview): ToolResultEvent {
  return { type: "tool_result", toolCallId: "vitest", toolName: "bash",
    input: { command: "pnpm test-unit packages/runtime-dom/__tests__/customElement.spec.ts" },
    content: [{ type: "text", text }], details: { truncation: { fullOutputPath: "/tmp/pi-bash-example.log" } },
    structuredContent: { output: `complete native output\n${text}`, truncated: false, exit_code: 1 }, isError: true };
}

test("repeated Vitest failures keep distinct evidence, final summary and native result", () => {
  const original = event();
  const result = compactRepeatedVitestFailures(original);
  expect(result?.content?.[0]?.type).toBe("text");
  const shown = result?.content?.[0]?.type === "text" ? result.content[0].text : "";
  expect(Buffer.byteLength(shown)).toBeLessThan(Buffer.byteLength(preview) / 3);
  expect(shown).toContain("ReferenceError: styles is not defined");
  expect(shown).toContain("TypeError: Cannot set properties of null");
  expect(shown).toContain('The latest test that might\'ve caused the error is "with slots".');
  expect(shown).toContain("21 × ReferenceError");
  expect(shown).toContain("9 × TypeError");
  expect(shown.endsWith(footer)).toBe(true);
  expect(result?.structuredContent === original.structuredContent).toBe(true);
  expect(original.content[0]).toMatchObject({ text: preview });
});

test("unfamiliar or unrecoverable Bash output is left whole", () => {
  expect(compactVitestPreview("⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯\nError: different\n"))
    .toBeUndefined();
  for (const change of [
    { isError: false },
    { toolName: "other" },
    { structuredContent: { output: preview, exit_code: 0 } },
    { content: [{ type: "text" as const, text: preview.replace("Full output: ", "Log: ") }] },
    { content: [{ type: "text" as const, text: preview.replaceAll("Vitest", "Runner") }] },
    { content: [{ type: "text" as const, text: preview.replace("36 failed", "36 passed") }] },
  ]) expect(compactRepeatedVitestFailures({ ...event(), ...change })).toBeUndefined();
});

test("a folded result keeps an existing Bash recovery note", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nekopi-vitest-"));
  try {
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { check: "vitest run" } }));
    const result = await nativeBashFeedback({ ...event(), structuredContent: {
      output: `${preview}\nERR_PNPM_NO_SCRIPT Missing script: "wrong"\n`,
      truncated: false, exit_code: 1,
    } }, cwd);
    const shown = result?.content?.filter(block => block.type === "text").map(block => block.text).join("\n") ?? "";
    expect(shown).toContain("Visible repeated Vitest errors");
    expect(shown).toContain("This project's package.json scripts: check.");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
