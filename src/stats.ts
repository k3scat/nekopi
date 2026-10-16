import type { TelemetrySnapshot } from "./telemetry.ts";

/** Tools nekopi adds or replaces. Their call counts are the adoption question. */
const NEKOPI_TOOLS = new Set(["grep", "find", "lsp", "read", "edit", "write"]);

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Render the current run for a person.
 *
 * The question this answers is adoption: which tools did the agent actually
 * reach for. A tool that is never called has no value whatever its test
 * coverage, and that was this project's recorded failure before. Counters are
 * in memory, so this works whether or not telemetry writes a file.
 */
export function renderStats(snapshot: TelemetrySnapshot): string {
  const lines: string[] = ["NekoPi, current run", ""];
  const entries = Object.entries(snapshot.tools);

  if (!entries.length) {
    lines.push("No tool has been called yet.");
  } else {
    const width = Math.max(8, ...entries.map(([name]) => name.length));
    lines.push("Tool calls");
    lines.push(`  ${"tool".padEnd(width)}${"calls".padStart(8)}${"errors".padStart(8)}${"time".padStart(10)}${"output".padStart(11)}`);
    for (const [name, tool] of entries) {
      lines.push(`  ${name.padEnd(width)}${String(tool.calls).padStart(8)}${String(tool.errors).padStart(8)}`
        + `${duration(tool.durationMs).padStart(10)}${bytes(tool.outputBytes).padStart(11)}`);
    }
    lines.push(`  ${"TOTAL".padEnd(width)}${String(snapshot.toolCalls).padStart(8)}${String(snapshot.toolErrors).padStart(8)}`
      + `${duration(snapshot.totalToolDurationMs).padStart(10)}${bytes(snapshot.totalOutputBytes).padStart(11)}`);
    if (snapshot.omittedTools) lines.push(`  ${snapshot.omittedTools} further tool name(s) were not tracked.`);

    // Name what was available but unused: a zero is the finding, not an absence.
    const unused = [...NEKOPI_TOOLS].filter(name => !(name in snapshot.tools)).sort();
    if (unused.length) lines.push("", `Not called this run: ${unused.join(", ")}.`);
  }

  lines.push("", "Model");
  lines.push(`  requests        ${snapshot.modelCalls}`);
  lines.push(`  tokens          ${snapshot.usage.totalTokens.toLocaleString("en-US")}`
    + (snapshot.usageReported ? "" : " (incomplete; a provider reported none)"));
  if (snapshot.usage.cost.total > 0) lines.push(`  cost            ${snapshot.usage.cost.total.toFixed(4)}`);

  lines.push("", "Telemetry");
  lines.push(`  file            ${snapshot.enabled ? snapshot.filePath ?? "pending" : "off"}`);
  if (snapshot.enabled) {
    lines.push(`  records         ${snapshot.recordsWritten} written, ${snapshot.recordsDropped} dropped`);
    if (!snapshot.recording) lines.push("  recording       stopped; counters above remain accurate");
  } else {
    lines.push("  Counters above are in memory and need no setup. Set telemetry.enabled");
    lines.push("  to keep a file across runs.");
  }
  return lines.join("\n");
}
