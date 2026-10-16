import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** Aggregate tool counts from enabled telemetry logs. */
interface RunSummary {
  runId: string;
  at: string;
  toolCalls: number;
  tools: Record<string, number>;
}

interface AdoptionReport {
  runs: number;
  skipped: number;
  since?: string;
  totalCalls: number;
  /** Call count and the share of runs that used it, per tool. */
  tools: Array<{ name: string; calls: number; runs: number; shareOfRuns: number }>;
}

const MAX_FILES = 500;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

export async function readAdoption(directory: string, options: { days?: number } = {}): Promise<AdoptionReport> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter(name => name.endsWith(".jsonl"));
  } catch {
    return { runs: 0, skipped: 0, totalCalls: 0, tools: [] };
  }
  const cutoff = options.days === undefined ? 0 : Date.now() - options.days * 86_400_000;
  const runs: RunSummary[] = [];
  let skipped = 0;
  for (const name of names.slice(0, MAX_FILES)) {
    const path = join(directory, name);
    try {
      if ((await stat(path)).size > MAX_FILE_BYTES) { skipped += 1; continue; }
      const summary = summarize(await readFile(path, "utf8"));
      if (!summary) { skipped += 1; continue; }
      if (cutoff && Date.parse(summary.at) < cutoff) continue;
      runs.push(summary);
    } catch {
      skipped += 1;
    }
  }
  const calls = new Map<string, { calls: number; runs: number }>();
  for (const run of runs) {
    for (const [tool, count] of Object.entries(run.tools)) {
      const entry = calls.get(tool) ?? { calls: 0, runs: 0 };
      entry.calls += count;
      entry.runs += 1;
      calls.set(tool, entry);
    }
  }
  const withCalls = runs.filter(run => run.toolCalls > 0).length;
  return {
    runs: runs.length,
    skipped,
    ...(runs.length ? { since: runs.map(run => run.at).sort()[0]! } : {}),
    totalCalls: runs.reduce((sum, run) => sum + run.toolCalls, 0),
    tools: [...calls.entries()]
      .map(([name, entry]) => ({ name, calls: entry.calls, runs: entry.runs,
        shareOfRuns: withCalls ? entry.runs / withCalls : 0 }))
      .sort((a, b) => b.calls - a.calls),
  };
}

/** Ignore malformed/foreign records; keep usable metadata and counts. */
function summarize(text: string): RunSummary | undefined {
  let runId = "", at = "", toolCalls = 0;
  const tools: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (record.schemaVersion !== 1) continue;
    if (typeof record.runId === "string") runId ||= record.runId;
    if (typeof record.at === "string") at ||= record.at;
    if (record.type !== "tool" || typeof record.tool !== "string") continue;
    tools[record.tool] = (tools[record.tool] ?? 0) + 1;
    toolCalls += 1;
  }
  return runId ? { runId, at, toolCalls, tools } : undefined;
}

export function renderAdoption(report: AdoptionReport, directory: string): string {
  if (!report.runs) {
    return [`No saved runs in ${directory}.`, "",
      "Adoption is measured from telemetry files. Set telemetry.enabled in",
      "nekopi.json to keep them, then use nekopi normally for a few days.",
      "/nekopi stats reports the current run without any setup."].join("\n");
  }
  const lines = [`Tool adoption across ${report.runs} run(s) since ${report.since?.slice(0, 10) ?? "unknown"}`, ""];
  const width = Math.max(8, ...report.tools.map(tool => tool.name.length));
  lines.push(`  ${"tool".padEnd(width)}${"calls".padStart(8)}${"runs".padStart(7)}${"of runs".padStart(10)}`);
  for (const tool of report.tools) {
    lines.push(`  ${tool.name.padEnd(width)}${String(tool.calls).padStart(8)}${String(tool.runs).padStart(7)}`
      + `${`${Math.round(tool.shareOfRuns * 100)}%`.padStart(10)}`);
  }
  lines.push(`  ${"TOTAL".padEnd(width)}${String(report.totalCalls).padStart(8)}`);
  if (report.skipped) lines.push("", `${report.skipped} file(s) were unreadable or not nekopi telemetry.`);
  lines.push("", "The share is of runs that called any tool. A tool at 0 was available and",
    "never chosen, which is a product finding, not a gap in the data.");
  return lines.join("\n");
}
