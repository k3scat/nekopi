import { expect, test } from "bun:test";
import { createTelemetry, type TelemetrySnapshot } from "../src/telemetry.ts";
import { renderStats } from "../src/stats.ts";
import { emptyUsage } from "../src/usage.ts";

function snapshot(overrides: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return {
    enabled: false, recording: false, recordsWritten: 0, recordsDropped: 0, bytesWritten: 0,
    toolCalls: 0, outerToolCalls: 0, nestedToolCalls: 0, toolErrors: 0, totalToolDurationMs: 0,
    totalOutputBytes: 0, outerOutputBytes: 0, nestedOutputBytes: 0, modelCalls: 0,
    usage: emptyUsage(), usageReported: true, tools: {}, omittedTools: 0, ...overrides,
  };
}

/** A tool record with the shape the extension emits. */
function call(tool: string, durationMs = 10, outputBytes = 100, isError = false) {
  return { type: "tool" as const, tool, callId: `${tool}-${Math.random()}`, durationMs, isError, outputBytes };
}

test("per-tool counters work with telemetry off, which is the default", async () => {
  const telemetry = createTelemetry({ enabled: false, directory: "/nonexistent", sessionId: "s" });
  for (const name of ["grep", "grep", "grep", "read", "outline"]) await telemetry.record(call(name));
  await telemetry.record(call("lsp", 700, 50, true));
  const current = telemetry.snapshot();
  expect(current.enabled).toBe(false);
  // Most used first, so the adoption answer is the first line.
  expect(Object.keys(current.tools)).toEqual(["grep", "read", "outline", "lsp"]);
  expect(current.tools.grep).toEqual({ calls: 3, errors: 0, durationMs: 30, outputBytes: 300 });
  expect(current.tools.lsp).toEqual({ calls: 1, errors: 1, durationMs: 700, outputBytes: 50 });
  expect(current.toolCalls).toBe(6);
  expect(current.toolErrors).toBe(1);
  await telemetry.close();
});

test("the breakdown is bounded and reports what it stopped tracking", async () => {
  const telemetry = createTelemetry({ enabled: false, directory: "/nonexistent", sessionId: "s" });
  for (let index = 0; index < 70; index++) await telemetry.record(call(`tool-${index}`));
  const current = telemetry.snapshot();
  expect(Object.keys(current.tools)).toHaveLength(64);
  expect(current.omittedTools).toBe(6);
  // The total still counts every call, so it never disagrees with the records.
  expect(current.toolCalls).toBe(70);
  await telemetry.close();
});

test("a tool nekopi provides but the agent never called is named explicitly", () => {
  const text = renderStats(snapshot({ toolCalls: 2, totalToolDurationMs: 50, totalOutputBytes: 400,
    tools: { grep: { calls: 2, errors: 0, durationMs: 50, outputBytes: 400 } } }));
  expect(text).toContain("grep");
  // A zero is the finding, so unused tools are listed rather than omitted.
  expect(text).toContain("Not called this run: edit, find, lsp, read, write.");
});

test("a run that called everything reports no unused tools", () => {
  const tools = Object.fromEntries(["grep", "find", "lsp", "read", "edit", "write"]
    .map(name => [name, { calls: 1, errors: 0, durationMs: 1, outputBytes: 1 }]));
  const text = renderStats(snapshot({ toolCalls: 6, tools }));
  expect(text).not.toContain("Not called this run");
});

test("an empty run says so instead of printing an empty table", () => {
  expect(renderStats(snapshot())).toContain("No tool has been called yet.");
});

test("the view explains that counters need no setup when telemetry is off", () => {
  const off = renderStats(snapshot({ tools: { grep: { calls: 1, errors: 0, durationMs: 1, outputBytes: 1 } }, toolCalls: 1 }));
  expect(off).toContain("file            off");
  expect(off).toContain("need no setup");
  const on = renderStats(snapshot({ enabled: true, recording: true, filePath: "/agent/nekopi/telemetry/run.jsonl",
    recordsWritten: 12, tools: { grep: { calls: 1, errors: 0, durationMs: 1, outputBytes: 1 } }, toolCalls: 1 }));
  expect(on).toContain("/agent/nekopi/telemetry/run.jsonl");
  expect(on).toContain("12 written, 0 dropped");
  expect(on).not.toContain("need no setup");
});

test("incomplete provider usage is marked rather than shown as a total", () => {
  const usage = { ...emptyUsage(), totalTokens: 1_234 };
  expect(renderStats(snapshot({ usage, usageReported: false, modelCalls: 2 }))).toContain("incomplete");
  expect(renderStats(snapshot({ usage, usageReported: true, modelCalls: 2 }))).not.toContain("incomplete");
});

test("stopped recording says the counters are still accurate", () => {
  const text = renderStats(snapshot({ enabled: true, recording: false, recordsDropped: 3,
    tools: { grep: { calls: 1, errors: 0, durationMs: 1, outputBytes: 1 } }, toolCalls: 1 }));
  expect(text).toContain("counters above remain accurate");
});
