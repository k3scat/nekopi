import type { Usage } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { addUsage, emptyUsage } from "./usage.ts";

export const MAX_TELEMETRY_BYTES = 10 * 1024 * 1024;
export const MAX_PENDING_RECORDS = 128;
const MAX_METADATA_LENGTH = 256;

export type TelemetryRecord =
  | { type: "session_start" | "session_end" }
  | {
      type: "tool";
      tool: string;
      callId: string;
      parentId?: string;
      durationMs: number;
      isError: boolean;
      outputBytes: number;
    }
  | { type: "usage"; provider: string; model: string; usage: Usage; usageReported?: boolean; calls?: number };

/** Per-tool counters, so adoption is visible rather than inferred from a total. */
interface ToolTotals {
  calls: number;
  errors: number;
  durationMs: number;
  outputBytes: number;
}

export interface TelemetrySnapshot {
  enabled: boolean;
  recording: boolean;
  filePath?: string;
  recordsWritten: number;
  recordsDropped: number;
  bytesWritten: number;
  toolCalls: number;
  outerToolCalls: number;
  nestedToolCalls: number;
  toolErrors: number;
  totalToolDurationMs: number;
  totalOutputBytes: number;
  outerOutputBytes: number;
  nestedOutputBytes: number;
  modelCalls: number;
  usage: Usage;
  usageReported: boolean;
  /** Counters for each tool called in this run, most used first. */
  tools: Record<string, ToolTotals>;
  omittedTools: number;
}

export interface Telemetry {
  record(record: TelemetryRecord): Promise<void>;
  close(): Promise<void>;
  snapshot(): TelemetrySnapshot;
}

/** Records only allowlisted metadata; callers should await each record for backpressure. */
export function createTelemetry(options: {
  directory: string;
  sessionId: string;
  enabled: boolean;
  onError?: (error: Error) => void;
}): Telemetry {
  const runId = randomUUID();
  const directory = resolve(options.directory);
  const filePath = join(directory, `${runId}.jsonl`);
  const sessionId = metadata(options.sessionId);
  // A session can register many tools; bound the breakdown rather than the run.
  const MAX_TRACKED_TOOLS = 64;
  const byTool = new Map<string, ToolTotals>();
  const totals = {
    recordsWritten: 0,
    recordsDropped: 0,
    bytesWritten: 0,
    toolCalls: 0,
    outerToolCalls: 0,
    nestedToolCalls: 0,
    toolErrors: 0,
    totalToolDurationMs: 0,
    totalOutputBytes: 0,
    outerOutputBytes: 0,
    nestedOutputBytes: 0,
    modelCalls: 0,
    usage: emptyUsage(),
    usageReported: true,
    omittedTools: 0,
  };
  let handle: FileHandle | undefined;
  let fileCreated = false;
  let stopped = false;
  let closed = false;
  let reportedError = false;
  let pending = 0;
  let tail = Promise.resolve();
  let closing: Promise<void> | undefined;

  function report(message: string): void {
    if (reportedError) return;
    reportedError = true;
    try {
      options.onError?.(new Error(message));
    } catch {
      // Diagnostics cannot interrupt the agent.
    }
  }

  function accumulate(record: TelemetryRecord): void {
    if (record.type === "tool") {
      let tool = byTool.get(record.tool);
      if (!tool) {
        if (byTool.size >= MAX_TRACKED_TOOLS) totals.omittedTools += 1;
        else { tool = { calls: 0, errors: 0, durationMs: 0, outputBytes: 0 }; byTool.set(record.tool, tool); }
      }
      if (tool) {
        tool.calls += 1;
        tool.errors += Number(record.isError);
        tool.durationMs += record.durationMs;
        tool.outputBytes += record.outputBytes;
      }
      totals.toolCalls += 1;
      totals.toolErrors += Number(record.isError);
      totals.totalToolDurationMs += record.durationMs;
      totals.totalOutputBytes += record.outputBytes;
      totals[record.parentId === undefined ? "outerToolCalls" : "nestedToolCalls"] += 1;
      totals[record.parentId === undefined ? "outerOutputBytes" : "nestedOutputBytes"] += record.outputBytes;
    } else if (record.type === "usage") {
      totals.modelCalls += record.calls ?? 1;
      addUsage(totals.usage, record.usage);
      totals.usageReported &&= record.usageReported !== false;
    }
  }

  async function append(line: string): Promise<void> {
    if (stopped) {
      totals.recordsDropped += 1;
      return;
    }
    const bytes = Buffer.byteLength(line);
    if (totals.bytesWritten + bytes > MAX_TELEMETRY_BYTES) {
      stopped = true;
      totals.recordsDropped += 1;
      report("Telemetry recording stopped at the 10 MiB run limit. Totals remain available.");
      return;
    }
    try {
      if (handle === undefined) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
        handle = await open(filePath, "ax", 0o600);
        fileCreated = true;
      }
      await handle.appendFile(line, "utf8");
      totals.recordsWritten += 1;
      totals.bytesWritten += bytes;
    } catch {
      stopped = true;
      totals.recordsDropped += 1;
      report("Telemetry recording stopped after a file write failure. Totals remain available.");
    }
  }

  return {
    record(input) {
      if (closed) return Promise.resolve();
      let projected: TelemetryRecord;
      try {
        projected = projectRecord(input);
        // Counters are in memory and always accumulate. Only the file is
        // optional, so `/nekopi stats` reports tool adoption with no setup.
        accumulate(projected);
      } catch {
        // An invalid record is dropped and counted, as it was before counters
        // became independent of the file.
        totals.recordsDropped += 1;
        report("Telemetry dropped an invalid metadata record.");
        return Promise.resolve();
      }
      if (!options.enabled) return Promise.resolve();
      let line: string;
      try {
        const record = projected;
        if (stopped || pending >= MAX_PENDING_RECORDS) {
          totals.recordsDropped += 1;
          if (!stopped) report("Telemetry dropped records because its write queue is full.");
          return Promise.resolve();
        }
        line = `${JSON.stringify({ schemaVersion: 1, runId, sessionId, at: new Date().toISOString(), ...record })}\n`;
      } catch {
        totals.recordsDropped += 1;
        report("Telemetry dropped an invalid metadata record.");
        return Promise.resolve();
      }
      pending += 1;
      const write = tail.then(() => append(line)).finally(() => { pending -= 1; });
      tail = write;
      return write;
    },
    close() {
      if (closing !== undefined) return closing;
      closed = true;
      closing = tail.then(async () => {
        try {
          await handle?.close();
        } catch {
          report("Telemetry could not close its log file.");
        }
      });
      return closing;
    },
    snapshot() {
      return {
        enabled: options.enabled,
        recording: options.enabled && !closed && !stopped,
        ...(fileCreated ? { filePath } : {}),
        ...totals,
        usage: structuredClone(totals.usage),
        tools: Object.fromEntries([...byTool.entries()]
          .sort(([, a], [, b]) => b.calls - a.calls)
          .map(([name, tool]) => [name, { ...tool }])),
      };
    },
  };
}

function metadata(value: string): string {
  if (typeof value !== "string") throw new TypeError("Expected telemetry metadata string");
  return value.slice(0, MAX_METADATA_LENGTH);
}

function amount(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("Expected nonnegative telemetry amount");
  }
  return value;
}

function projectRecord(record: TelemetryRecord): TelemetryRecord {
  switch (record.type) {
    case "session_start":
    case "session_end":
      return { type: record.type };
    case "tool":
      if (typeof record.isError !== "boolean") throw new TypeError("Expected tool error flag");
      return {
        type: "tool",
        tool: metadata(record.tool),
        callId: metadata(record.callId),
        ...(record.parentId === undefined ? {} : { parentId: metadata(record.parentId) }),
        durationMs: amount(record.durationMs),
        isError: record.isError,
        outputBytes: amount(record.outputBytes),
      };
    case "usage":
      if (record.usageReported !== undefined && typeof record.usageReported !== "boolean") {
        throw new TypeError("Expected usage completeness flag");
      }
      if (record.calls !== undefined && (!Number.isInteger(record.calls) || record.calls < 0)) {
        throw new TypeError("Expected nonnegative telemetry call count");
      }
      return {
        type: "usage",
        provider: metadata(record.provider),
        model: metadata(record.model),
        usage: projectUsage(record.usage),
        ...(record.usageReported === undefined ? {} : { usageReported: record.usageReported }),
        ...(record.calls === undefined ? {} : { calls: record.calls }),
      };
    default:
      throw new TypeError("Unknown telemetry record type");
  }
}

function projectUsage(usage: Usage): Usage {
  return {
    input: amount(usage.input),
    output: amount(usage.output),
    cacheRead: amount(usage.cacheRead),
    cacheWrite: amount(usage.cacheWrite),
    ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: amount(usage.cacheWrite1h) }),
    ...(usage.reasoning === undefined ? {} : { reasoning: amount(usage.reasoning) }),
    totalTokens: amount(usage.totalTokens),
    cost: {
      input: amount(usage.cost.input),
      output: amount(usage.cost.output),
      cacheRead: amount(usage.cost.cacheRead),
      cacheWrite: amount(usage.cost.cacheWrite),
      total: amount(usage.cost.total),
    },
  };
}
