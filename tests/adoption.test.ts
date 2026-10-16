import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAdoption, renderAdoption } from "../src/adoption.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(runs: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "nekopi-adoption-"));
  roots.push(root);
  for (const [name, content] of Object.entries(runs)) await writeFile(join(root, name), content);
  return root;
}

/** One telemetry line, in the shape the writer emits. */
function line(runId: string, at: string, record: Record<string, unknown>) {
  return `${JSON.stringify({ schemaVersion: 1, runId, sessionId: "s", at, ...record })}\n`;
}

function toolLine(runId: string, at: string, tool: string) {
  return line(runId, at, { type: "tool", tool, callId: `${tool}-1`, durationMs: 5, isError: false, outputBytes: 10 });
}

test("adoption counts calls and the share of runs that used each tool", async () => {
  const root = await fixture({
    "a.jsonl": line("a", "2026-10-01T00:00:00.000Z", { type: "session_start" })
      + toolLine("a", "2026-10-01T00:00:01.000Z", "grep")
      + toolLine("a", "2026-10-01T00:00:02.000Z", "grep")
      + toolLine("a", "2026-10-01T00:00:03.000Z", "outline"),
    "b.jsonl": line("b", "2026-10-02T00:00:00.000Z", { type: "session_start" })
      + toolLine("b", "2026-10-02T00:00:01.000Z", "grep"),
  });
  const report = await readAdoption(root);
  expect(report.runs).toBe(2);
  expect(report.totalCalls).toBe(4);
  expect(report.since).toBe("2026-10-01T00:00:00.000Z");
  // grep in both runs, outline in one: the share is what answers adoption.
  expect(report.tools).toEqual([
    { name: "grep", calls: 3, runs: 2, shareOfRuns: 1 },
    { name: "outline", calls: 1, runs: 1, shareOfRuns: 0.5 },
  ]);
});

test("a run that called no tool does not dilute the share", async () => {
  const root = await fixture({
    "a.jsonl": line("a", "2026-10-01T00:00:00.000Z", { type: "session_start" })
      + toolLine("a", "2026-10-01T00:00:01.000Z", "grep"),
    // A session that ended before calling anything is not evidence either way.
    "b.jsonl": line("b", "2026-10-02T00:00:00.000Z", { type: "session_start" })
      + line("b", "2026-10-02T00:00:01.000Z", { type: "session_end" }),
  });
  const report = await readAdoption(root);
  expect(report.runs).toBe(2);
  expect(report.tools[0]).toEqual({ name: "grep", calls: 1, runs: 1, shareOfRuns: 1 });
});

test("the day window keeps only recent runs", async () => {
  const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const root = await fixture({
    "new.jsonl": line("new", recent, { type: "session_start" }) + toolLine("new", recent, "lsp"),
    "old.jsonl": line("old", old, { type: "session_start" }) + toolLine("old", old, "grep"),
  });
  expect((await readAdoption(root)).runs).toBe(2);
  const windowed = await readAdoption(root, { days: 7 });
  expect(windowed.runs).toBe(1);
  expect(windowed.tools.map(tool => tool.name)).toEqual(["lsp"]);
});

test("unreadable, foreign and truncated files are counted as skipped", async () => {
  const root = await fixture({
    "good.jsonl": line("good", "2026-10-01T00:00:00.000Z", { type: "session_start" })
      + toolLine("good", "2026-10-01T00:00:01.000Z", "grep"),
    // A different schema version is another tool's file, not ours.
    "foreign.jsonl": `${JSON.stringify({ schemaVersion: 2, runId: "x", type: "tool", tool: "grep" })}\n`,
    "broken.jsonl": '{"schemaVersion":1,"runId":"b","type":"to',
    "notes.txt": "ignored entirely\n",
  });
  const report = await readAdoption(root);
  expect(report.runs).toBe(1);
  expect(report.skipped).toBe(2);
  // A partial last line is skipped without losing the rest of the directory.
  expect(report.tools.map(tool => tool.name)).toEqual(["grep"]);
});

test("a missing directory reports no runs rather than failing", async () => {
  const report = await readAdoption(join(tmpdir(), "nekopi-absent-telemetry"));
  expect(report).toEqual({ runs: 0, skipped: 0, totalCalls: 0, tools: [] });
});

test("an empty report explains how to collect data", () => {
  const text = renderAdoption({ runs: 0, skipped: 0, totalCalls: 0, tools: [] }, "/agent/nekopi/telemetry");
  expect(text).toContain("No saved runs in /agent/nekopi/telemetry.");
  expect(text).toContain("Set telemetry.enabled");
  // The current run needs no setup, so say where to look instead.
  expect(text).toContain("/nekopi stats");
});

test("the report says a zero is a finding, not missing data", () => {
  const text = renderAdoption({ runs: 3, skipped: 1, totalCalls: 9, since: "2026-10-01T00:00:00.000Z",
    tools: [{ name: "grep", calls: 9, runs: 3, shareOfRuns: 1 }] }, "/agent");
  expect(text).toContain("Tool adoption across 3 run(s) since 2026-10-01");
  expect(text).toContain("100%");
  expect(text).toContain("1 file(s) were unreadable");
  expect(text).toContain("never chosen, which is a product finding");
});
