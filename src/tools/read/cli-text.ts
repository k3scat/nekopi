import { isUtf8 } from "node:buffer";
import { open } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { inside, resolveInside } from "../workspace-path.ts";
import { MAX_PARSE_BYTES } from "../syntax/parser.ts";
import { cliRangeLimits, CLI_READ_MAX_BYTES, CLI_READ_MAX_LINES, linesIn, rewriteContinuations } from "./cli-budget.ts";
import { formatRanges, sourceRanges, type SourceRange } from "./range-output.ts";
import { symbolRanges } from "./symbol-range.ts";

/** Only ordinary literal text paths use the fast reader. Native read owns all other cases. */
async function snapshot(cwd: string, path: string, maxBytes = MAX_PARSE_BYTES) {
  if (process.platform === "win32" || !/^[\w./ [\]()-]+$/u.test(path)
    || isAbsolute(path) || !inside(cwd, resolve(cwd, path))) return;
  const file = await open(resolve(cwd, path), "r").catch(() => undefined);
  if (!file) return;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) return;
    // Bound the read even if a writer grows the file after stat.
    const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > info.size) return;
    const bytes = buffer.subarray(0, length);
    // Native MIME detection and image resizing remain authoritative, including disguised images.
    if (!isUtf8(bytes) || bytes.includes(0) || /^(GIF8|BM|RIFF)/u.test(bytes.subarray(0, 4).toString("ascii"))) return;
    return { path: relative(cwd, resolve(cwd, path)), buffer: bytes };
  } finally { await file.close(); }
}

/** Small complete reads need no native schema, renderer, image pipeline or syntax map. */
export async function readSmallText(cwd: string, path: string) {
  const captured = await snapshot(cwd, path, CLI_READ_MAX_BYTES);
  if (!captured) return;
  const source = captured.buffer.toString("utf8");
  const lines = source ? source.split("\n") : [];
  if (source.endsWith("\n")) lines.pop();
  if (lines.length > 200) return;
  const body = lines.map((line, index) => `${index + 1}: ${line}`).join("\n") + (source.endsWith("\n") ? "\n" : "");
  const text = `File ${JSON.stringify(captured.path)}\n${lines.length ? `Source lines 1-${lines.length}.` : "No source lines returned."}\n${body}`;
  if (Buffer.byteLength(text) > CLI_READ_MAX_BYTES) return;
  return { content: [{ type: "text" as const, text }] };
}

/** Syntax and formatting share one snapshot. Fall back for images, special paths and large files. */
export async function readTextSelection(cwd: string, input: { path: string; symbol?: string; ranges?: SourceRange[] }, prefix = "") {
  const requested = input.symbol === undefined ? sourceRanges(input.ranges ?? []) : undefined;
  const file = input.symbol !== undefined ? await resolveInside(cwd, input.path) : undefined;
  if (input.symbol !== undefined && !file) return;
  const captured = await snapshot(cwd, input.path);
  if (!captured) return;
  const ranges = input.symbol !== undefined
    ? await symbolRanges(file!.absolute, file!.display, input.symbol, captured.buffer.toString("utf8"))
    : requested!;
  return formatRanges(captured, ranges, cliRangeLimits(input.path, prefix));
}

/** The normal case is already bounded. Load native truncation only when framing needs it. */
export async function cliText(result: { content: readonly { type: string; text?: string }[]; details?: unknown }, path: string, prefix = "") {
  const details = result.details as { numberedRead?: { totalSourceLines: number }; rangeRead?: { totalSourceLines: number } } | undefined;
  const total = details?.numberedRead?.totalSourceLines ?? details?.rangeRead?.totalSourceLines;
  const text = prefix + rewriteContinuations(result.content.flatMap(block => block.type === "text" && block.text ? [block.text] : []).join("\n"), path, total);
  if (Buffer.byteLength(text) <= CLI_READ_MAX_BYTES && linesIn(text) <= CLI_READ_MAX_LINES) return text;
  return (await import("./cli-output.ts")).cliReadText(result, path, prefix);
}
