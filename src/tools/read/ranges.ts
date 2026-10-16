import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type createReadToolDefinition, type ReadToolOptions } from "@earendil-works/pi-coding-agent";
import { isUtf8 } from "node:buffer";
import { readSnapshot } from "./snapshot.ts";

export interface SourceRange { start: number; end: number }
export interface RangeOutputLimits {
  maxBytes?: number;
  maxLines?: number;
  continuation?: (start: number, end: number) => string;
}
export interface RangeReadDetails {
  rangeRead: {
    path: string;
    totalSourceLines: number;
    requestedRanges: SourceRange[];
    ranges: (SourceRange & {
      availableEnd: number | null;
      returnedEnd: number | null;
      sourceLinesReturned: number;
      sourceLinesOmitted: number;
      complete: boolean;
    })[];
    sourceLinesReturned: number;
    sourceLinesOmitted: number;
    unrequestedSourceLines: number;
    outputBytes: number;
    truncated: boolean;
    complete: boolean;
    encodingLoss: boolean;
  };
}

/** Validate and copy before any asynchronous native operation. */
export function sourceRanges(value: unknown): SourceRange[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error("ranges must contain 1 to 16 inclusive source line ranges.");
  return value.map(range => {
    if (!range || typeof range !== "object" || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start < 1 || range.end < range.start) throw new Error("Each range needs safe integer start/end with 1 <= start <= end.");
    return { start: range.start, end: range.end };
  });
}

function mergeRanges(requested: SourceRange[]): SourceRange[] {
  const merged: SourceRange[] = [];
  for (const range of requested.toSorted((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function continuation(start: number, end: number): string {
  return `[Output limit: source lines ${start}-${end} not returned. Continue with ranges=[{"start":${start},"end":${end}}].]`;
}

/** One native read supplies every range. Whole source lines retain their original coordinates. */
export async function readRanges(cwd: string, options: ReadToolOptions,
  args: Parameters<ReturnType<typeof createReadToolDefinition>["execute"]>,
  requested: SourceRange[], limits: RangeOutputLimits = {}) {
  // Native read owns path resolution, access checks and cancellation. Its preview is not used.
  const { captured } = await readSnapshot(cwd, options, [args[0], { path: args[1].path, offset: 1, limit: 1 }, args[2], args[3], args[4]], true);
  if (!captured) throw new Error("Native read returned no text snapshot.");
  const source = captured.buffer.toString("utf8");
  const lines = source.length ? source.split("\n") : [];
  if (source.endsWith("\n")) lines.pop();
  const total = lines.length, encodingLoss = !isUtf8(captured.buffer);
  const ranges = mergeRanges(requested).map(range => ({ ...range, availableEnd: Math.min(range.end, total), rows: [] as string[], bytes: 0,
    next: undefined as { text: string; bytes: number } | undefined }));
  const available = (range: typeof ranges[number]) => Math.max(0, range.availableEnd - range.start + 1);
  const selected = ranges.reduce((sum, range) => sum + available(range), 0);
  const heading = `File ${JSON.stringify(captured.path)}\nRequested ${selected} of ${total} source lines; ${total - selected} other source lines are not requested.`;
  const encodingNote = encodingLoss ? "\n[Invalid UTF-8 was decoded with replacement; source line numbers follow LF separators.]" : "";
  const limitsNote = "\n[Ranges share the native line and byte limits. If one source line cannot fit, use ordinary read or grep for matching evidence.]";
  const header = (range: SourceRange) => `[Requested source lines ${range.start}-${range.end}]`;
  const eofNote = (range: SourceRange) => range.end > total
    ? `[File ends at line ${total}; requested lines ${Math.max(range.start, total + 1)}-${range.end} do not exist.]` : "";
  const continueWith = limits.continuation ?? continuation;
  // Reserve the largest possible notice for every range before allocating source evidence.
  const envelopeBytes = Buffer.byteLength(heading + encodingNote + limitsNote) + ranges.reduce((sum, range) => sum
    + Buffer.byteLength(header(range) + eofNote(range) + continueWith(range.end, range.end) + "No source lines returned.") + 8, 0);
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = limits.maxLines ?? DEFAULT_MAX_LINES;
  if (envelopeBytes > maxBytes) throw new Error("Range read metadata exceeds the output limit. Use fewer ranges or a shorter path.");
  const bodyBudget = Math.max(0, maxBytes - envelopeBytes);
  const active = ranges.filter(range => available(range) > 0);
  let usedBytes = 0, usedLines = 0;
  const next = (range: typeof ranges[number]) => {
    if (range.rows.length >= available(range)) return;
    if (!range.next) {
      const number = range.start + range.rows.length;
      const text = `${number}: ${lines[number - 1]}\n`;
      range.next = { text, bytes: Buffer.byteLength(text) };
    }
    return range.next;
  };
  const take = (range: typeof ranges[number]) => {
    const row = next(range)!;
    range.rows.push(row.text); range.bytes += row.bytes;
    usedBytes += row.bytes; usedLines++; range.next = undefined;
  };
  // Each requested region first gets an equal share. An early large range cannot consume all output.
  const byteShare = Math.floor(bodyBudget / Math.max(1, active.length));
  const lineShare = Math.floor(maxLines / Math.max(1, active.length));
  for (const range of active) {
    while (range.rows.length < lineShare && next(range) && range.bytes + next(range)!.bytes <= byteShare) take(range);
  }
  // Reuse unused shares, one complete line per range per pass.
  while (usedLines < maxLines) {
    let progress = false;
    for (const range of active) {
      if (usedLines === maxLines) break;
      const row = next(range);
      if (row && usedBytes + row.bytes <= bodyBudget) { take(range); progress = true; }
    }
    if (!progress) break;
  }
  const sections = ranges.map(range => {
    const notices = [range.rows.length < available(range) ? continueWith(range.start + range.rows.length, range.availableEnd) : "", eofNote(range)].filter(Boolean);
    return `${header(range)}\n${range.rows.length ? range.rows.join("").slice(0, -1) : "No source lines returned."}${notices.length ? "\n" + notices.join("\n") : ""}`;
  });
  const output = [heading, ...sections].join("\n\n") + (usedLines < selected ? limitsNote : "") + encodingNote;
  const details: RangeReadDetails = { rangeRead: {
    path: captured.path, totalSourceLines: total, requestedRanges: requested,
    ranges: ranges.map(range => ({ start: range.start, end: range.end,
      availableEnd: available(range) ? range.availableEnd : null,
      returnedEnd: range.rows.length ? range.start + range.rows.length - 1 : null,
      sourceLinesReturned: range.rows.length, sourceLinesOmitted: available(range) - range.rows.length,
      complete: range.rows.length === range.end - range.start + 1,
    })),
    sourceLinesReturned: usedLines, sourceLinesOmitted: selected - usedLines, unrequestedSourceLines: total - selected,
    outputBytes: Buffer.byteLength(output), truncated: usedLines < selected,
    complete: ranges.every(range => range.rows.length === range.end - range.start + 1), encodingLoss,
  } };
  return { content: [{ type: "text" as const, text: output }], details };
}
