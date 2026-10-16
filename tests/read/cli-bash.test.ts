import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { readPreviewFeedback } from "../../src/tools/bash/read-preview.ts";
import { createSdkFixture } from "../helpers/model-server.ts";

test("a real Pi Bash read keeps its heading and early source after CLI capping", async () => {
  const fixture = await createSdkFixture();
  try {
    const source = Array.from({ length: 400 }, (_, index) =>
      `export function step${index}() { return "${"x".repeat(300)}"; }`).join("\n") + "\n";
    await writeFile(join(fixture.cwd, "big.ts"), source);
    fixture.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "nek read big.ts" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    ]);
    await fixture.session.prompt("Read the source.");
    const result = fixture.session.messages.find(message => message.role === "toolResult");
    expect(result?.role === "toolResult" && result.isError).toBe(false);
    const output = result?.role === "toolResult"
      ? result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n") : "";
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(50 * 1024);
    expect(output).toStartWith('File "big.ts"\nSource lines 1-');
    expect(output).toContain("1: export function step0()");
    expect(output).toContain("Shape of big.ts");
    expect(output).not.toContain("Full output:");
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
}, 30_000);

test("a chained Bash read keeps the first source lines and the later command result", async () => {
  const fixture = await createSdkFixture();
  try {
    const source = Array.from({ length: 400 }, (_, index) =>
      `export function step${index}() { return "${"x".repeat(300)}"; }`).join("\n") + "\n";
    await writeFile(join(fixture.cwd, "big.ts"), source);
    fixture.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "nek read big.ts && printf '%010000d\\n' 0" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    ]);
    await fixture.session.prompt("Read the source and run the next command.");
    const result = fixture.session.messages.find(message => message.role === "toolResult");
    expect(result?.role === "toolResult" && result.isError).toBe(false);
    const output = result?.role === "toolResult"
      ? result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n") : "";
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(50 * 1024);
    expect(output).toStartWith('File "big.ts"\nSource lines 1-');
    expect(output).toContain("1: export function step0()");
    expect(output).toContain("Middle output omitted. Full output:");
    expect(output).toContain("0".repeat(100));
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
}, 30_000);

test("a chained read after a large prelude is found in the last log window", async () => {
  const fixture = await createSdkFixture();
  try {
    const source = Array.from({ length: 400 }, (_, index) =>
      `export function step${index}() { return "${"x".repeat(300)}"; }`).join("\n") + "\n";
    await writeFile(join(fixture.cwd, "big.ts"), source);
    fixture.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command:
        "yes 0 | head -c 1100000; printf '\\n'; nek read big.ts && printf '%010000d\\n' 0" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    ]);
    await fixture.session.prompt("Read the source after the earlier output.");
    const result = fixture.session.messages.find(message => message.role === "toolResult");
    expect(result?.role === "toolResult" && result.isError).toBe(false);
    const output = result?.role === "toolResult"
      ? result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n") : "";
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(50 * 1024);
    expect(output).toStartWith('File "big.ts"\nSource lines 1-');
    expect(output).toContain("1: export function step0()");
    expect(output).toContain("Middle output omitted. Full output:");
    expect(output).toContain("0".repeat(100));
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
}, 30_000);

test("the read preview keeps Pi's structured output and exit status", async () => {
  const root = await mkdtemp(join(tmpdir(), "nekopi-read-preview-"));
  try {
    const path = join(root, "full.log");
    const full = `File "big.ts"\nSource lines 1-200.\n1: first source\n${"2: later source\n".repeat(3500)}failed at the end\n`;
    await writeFile(path, full);
    const structuredContent = { output: full, truncated: false, exit_code: 1, wall_time_seconds: 0.1 };
    const event = { type: "tool_result", toolCallId: "read", toolName: "bash",
      input: { command: "nek read big.ts && false" }, isError: true,
      content: [{ type: "text", text: "native tail preview" }],
      details: { truncation: { truncated: true }, fullOutputPath: path }, structuredContent } as ToolResultEvent;
    const preview = await readPreviewFeedback(event);
    const output = preview?.content?.find(block => block.type === "text")?.text ?? "";
    expect(output).toStartWith('File "big.ts"\nSource lines 1-200.\n1: first source');
    expect(output).toContain("failed at the end");
    expect(output).toContain("Command exited with code 1");
    expect(output).toContain("Middle output omitted. Full output:");
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(50 * 1024);
    expect(preview?.structuredContent).toBe(structuredContent);
  } finally { await rm(root, { recursive: true, force: true }); }
});
