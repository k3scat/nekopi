import { createGrepToolDefinition, getAgentDir, type ExtensionAPI, type ExtensionToolContext, type GrepToolInput } from "@earendil-works/pi-coding-agent";
import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { Type } from "typebox";
import { searchFiles, searchResultPath, type FileSearchDetails } from "./search/files.ts";
import { quotedSearchErrors } from "./search/errors.ts";
import { indexSymbols, labelFor, type SymbolIndex } from "./syntax/labels.ts";

/** Matches counted past the shown limit before counting itself stops. */
const COUNT_CEILING = 5_000;
/** Files named in a truncation notice, enough to narrow to without a dump. */
const FILES_SHOWN = 5;


export type { FileSearchDetails } from "./search/files.ts";
type SearchInput = Omit<GrepToolInput, "glob" | "path"> & {
  path?: string | string[];
  glob?: string | string[];
  outputMode?: "content" | "files";
  maxMatchesPerFile?: number;
};
interface SearchResult {
  content: { type: "text"; text: string }[];
  details: SearchDetails | FileSearchDetails;
  isError?: boolean;
}

interface ByteRange { start: number; end: number }
export interface SearchRow {
  path: string;
  line: number;
  kind: "match" | "context";
  /** Ripgrep line bytes after BOM decoding, before replacement decoding; excludes LF. */
  sourceBytes: number;
  matches: ByteRange[];
  excerpts: (ByteRange & { text: string })[];
  encodingLoss: boolean;
}
export interface SearchDetails {
  rows: SearchRow[];
  scanComplete: boolean;
  resultOverflow: boolean;
  clippedText: boolean;
  omittedSpans: number;
  omittedContextLines: number;
  omittedMatchingLines: number;
  observedMatchingLines: number;
  outputTruncated: boolean;
  errors: string[];
  maxMatchesPerFile?: number;
  filesAtMatchLimit?: string[];
  /** Distribution beyond the display limit, for narrowing capped results. */
  matchesByFile?: Array<[string, number]>;
  /** Whether counting itself was cut short, so the distribution is partial. */
  countTruncated?: boolean;
}
export interface SearchOptions { executable?: string; maxOutputBytes?: number; maxStreamBytes?: number }
interface SourceRow extends Omit<SearchRow, "excerpts"> { source: Buffer }
const OUTPUT_LIMIT = 50 * 1024, STREAM_LIMIT = 8 * 1024 * 1024;
export const SEARCH_PATH_LIMIT = 64;
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/u;
/** A path with any control character is quoted so one hit stays on one line. */
const UNSAFE_PATH = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/** Use an existing Pi-managed binary or PATH; never download or import private Pi APIs. */
export async function resolveRipgrep(agentDir = getAgentDir(), searchPath = process.env.PATH ?? "", cwd = process.cwd()): Promise<string> {
  const binary = process.platform === "win32" ? "rg.exe" : "rg";
  const candidates = [join(agentDir, "bin", binary), ...searchPath.split(delimiter).map(directory => resolve(cwd, directory, binary))];
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw new Error("ripgrep is unavailable. Install rg on PATH or let Pi install its managed binary before enabling source inspection.");
}

function decoded(value: { text?: string; bytes?: string } | undefined): Buffer {
  if (typeof value?.text === "string") return Buffer.from(value.text);
  if (typeof value?.bytes === "string") return Buffer.from(value.bytes, "base64");
  throw new Error("ripgrep returned an invalid text field.");
}

function decodedPath(cwd: string, value: { text?: string; bytes?: string } | undefined): string {
  const bytes = decoded(value);
  if (!isUtf8(bytes)) throw new Error("A non-UTF-8 filename cannot be represented faithfully; search is incomplete.");
  return searchResultPath(cwd, bytes.toString("utf8"));
}

/** Move over ripgrep line bytes; invalid UTF-8 is explicitly decoded with replacement. */
function step(source: Buffer, offset: number, amount: number, encodingLoss: boolean): number {
  const direction = Math.sign(amount);
  for (let count = 0; count < Math.abs(amount); count++) {
    if (direction < 0) {
      if (!offset) break;
      offset--;
      if (!encodingLoss) while (offset > 0 && (source[offset]! & 0xc0) === 0x80) offset--;
    } else {
      if (offset >= source.length) break;
      offset++;
      if (!encodingLoss) while (offset < source.length && (source[offset]! & 0xc0) === 0x80) offset++;
    }
  }
  return offset;
}

function windows(row: SourceRow): ByteRange[] {
  let short = true, length = 0;
  for (const _point of row.source.toString("utf8")) if (++length > 500) { short = false; break; }
  if (short) return [{ start: 0, end: row.sourceBytes }];
  if (row.kind === "context") return [{ start: 0, end: step(row.source, 0, 160, row.encodingLoss) }];
  const ranges = row.matches.map(({ start, end }) => {
    if (!row.encodingLoss) {
      while (start > 0 && start < row.sourceBytes && (row.source[start]! & 0xc0) === 0x80) start--;
      while (end < row.sourceBytes && (row.source[end]! & 0xc0) === 0x80) end++;
    }
    return { start: step(row.source, start, -80, row.encodingLoss), end: step(row.source, end, 80, row.encodingLoss) };
  }).sort((a, b) => a.start - b.start);
  const merged: ByteRange[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * Render one hit as line: text, under a heading its file and symbol supply.
 *
 * The path used to lead every line and the enclosing symbol used to trail
 * every match, which was about half of this tool's output. Both are facts
 * about a group of hits, so the group states them once. Clipping and unsafe
 * characters stay visible.
 */
function renderExcerpt(row: SourceRow, range: ByteRange, sampled = false): { text: string; line: string } {
  const text = row.source.subarray(range.start, range.end).toString("utf8");
  const separator = row.kind === "match" ? ":" : "-";
  const lead = range.start > 0 ? "…" : "", trail = range.end < row.sourceBytes ? "…" : "";
  const body = row.encodingLoss || CONTROL.test(text) ? JSON.stringify(text) : `${lead}${text}${trail}`;
  return { text, line: `  ${row.line}${separator}${sampled ? " [sample]" : ""} ${body}` };
}

/** The file and symbol headings a run of hits no longer repeats per line. */
function heading(path: string, label: string | undefined, previous: { path?: string; label?: string }): string[] {
  const lines: string[] = [];
  const display = UNSAFE_PATH.test(path) ? JSON.stringify(path) : path;
  if (path !== previous.path) { lines.push(display); previous.path = path; previous.label = undefined; }
  if (label !== previous.label) {
    if (label) lines.push(`[${label}]`);
    previous.label = label;
  }
  return lines;
}

function searchArgs(cwd: string, input: SearchInput, mode: string[]) {
  const args = [...mode, "--no-config", "--hidden", "--color=never", "--no-require-git"];
  if (input.maxMatchesPerFile !== undefined) args.push("--max-count", String(input.maxMatchesPerFile));
  if (input.literal) args.push("--fixed-strings");
  if (input.ignoreCase) args.push("--ignore-case");
  for (const glob of Array.isArray(input.glob) ? input.glob : input.glob ? [input.glob] : []) args.push("--glob", glob);
  const paths = Array.isArray(input.path) ? input.path : [input.path ?? "."];
  args.push("--glob", "!.git", "--", input.pattern, ...paths.map(path => resolve(cwd, path)));
  return args;
}

async function collect(cwd: string, input: SearchInput, executable: string, maxStreamBytes: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const args = searchArgs(cwd, input, ["--json", "--context", String(input.context ?? 0)]);
  const limit = input.limit ?? 100;
  return new Promise<{ rows: SourceRow[]; observed: number; overflow: boolean; omittedSpans: number; complete: boolean; errors: string[];
    maxMatchesPerFile?: number; filesAtMatchLimit?: string[];
    matchesByFile: Map<string, number>; countTruncated: boolean }>((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const rows: SourceRow[] = [], errors: string[] = [];
    const filesAtMatchLimit = new Set<string>();
    const fileMatches = new Map<string, number>();
    let buffered: Buffer = Buffer.alloc(0), stderr: Buffer = Buffer.alloc(0), bytes = 0, observed = 0;
    let stopped = false, overflow = false, aborted = false, omittedSpans = 0;
    // Counting continues past the row limit so a capped result can say where
    // the rest are. Bounded, because a pattern matching everything would
    // otherwise be counted in full.
    const matchesByFile = new Map<string, number>();
    let countTruncated = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
    };
    const abort = () => { aborted = true; stop(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped) return;
      const remaining = maxStreamBytes - bytes;
      bytes += chunk.length;
      // Parse complete events within the bounded prefix before discarding the tail.
      buffered = Buffer.concat([buffered, chunk.subarray(0, Math.max(0, remaining))]);
      let newline: number;
      try {
        while (!stopped && (newline = buffered.indexOf(10)) >= 0) {
          const event = JSON.parse(buffered.subarray(0, newline).toString("utf8"));
          buffered = buffered.subarray(newline + 1);
          if (event.type === "end" && event.data.binary_offset != null) errors.push("ripgrep stopped at binary data; further matches in that file are unknown.");
          if (event.type === "begin" && input.maxMatchesPerFile !== undefined) fileMatches.set(decodedPath(cwd, event.data.path), 0);
          if (event.type !== "match" && event.type !== "context") continue;
          if (event.type === "match") observed++;
          const data = event.data, path = decodedPath(cwd, data.path);
          if (event.type === "match") {
            matchesByFile.set(path, (matchesByFile.get(path) ?? 0) + 1);
            if (observed >= COUNT_CEILING) { countTruncated = true; stop(); break; }
          }
          if (event.type === "match" && input.maxMatchesPerFile !== undefined) {
            const count = (fileMatches.get(path) ?? 0) + 1;
            fileMatches.set(path, count);
            if (count >= input.maxMatchesPerFile) filesAtMatchLimit.add(path);
          }
          let source = decoded(data.lines);
          if (source.at(-1) === 10) source = source.subarray(0, -1); // Retain CR and all original match offsets.
          if (!Number.isSafeInteger(data.line_number) || data.line_number < 1) throw new Error("Invalid ripgrep line number.");
          const matches: ByteRange[] = (data.submatches ?? []).map(({ start, end }: ByteRange) => {
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.length) {
              throw new Error("Invalid ripgrep match byte range.");
            }
            return { start, end };
          });
          // Past the limit the rows stop but the counting does not, which is
          // what turns "narrow it" into "narrow it to these files".
          if (observed > limit) { overflow = true; omittedSpans += matches.length; continue; }
          rows.push({ path, line: data.line_number, kind: event.type,
            sourceBytes: source.length, source, matches, encodingLoss: !isUtf8(source) });
        }
      } catch (error) { errors.push(String(error)); stop(); }
      if (!stopped && bytes > maxStreamBytes) {
        // Past the row limit the stream is only being counted, so running out
        // of bytes makes the distribution partial rather than the result
        // broken. Before the counting pass this stopped at the row limit and
        // never reached here; erroring instead would turn a capped search on a
        // very broad pattern into a failed one.
        if (overflow) countTruncated = true;
        else errors.push("Search stream byte limit reached; remaining matches and context are unknown.");
        stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-8192); });
    child.on("error", (error) => { errors.push(error.message); });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (aborted) { reject(new DOMException("Search aborted.", "AbortError")); return; }
      if (!stopped && (code !== 0 && code !== 1 || buffered.length)) errors.push(stderr.toString("utf8").trim() || `ripgrep exited ${code} or returned incomplete JSON.`);
      else if (stderr.length) errors.push(stderr.toString("utf8").trim());
      resolveResult({ rows, observed, overflow, omittedSpans, matchesByFile, countTruncated,
        complete: !stopped && errors.length === 0 && filesAtMatchLimit.size === 0, errors,
        ...(input.maxMatchesPerFile !== undefined ? { maxMatchesPerFile: input.maxMatchesPerFile, filesAtMatchLimit: [...filesAtMatchLimit] } : {}) });
    });
  });
}

/** One closing line, only when the result is incomplete. A complete result says nothing. */
function notices(details: SearchDetails, observed: number, shownLines: number): string[] {
  const lines: string[] = [];
  const omitted = details.omittedMatchingLines;
  if (details.resultOverflow || details.outputTruncated || omitted > 0) {
    const reason = details.resultOverflow ? `${observed} matching lines found, ${shownLines} shown`
      : `output limit reached, ${omitted} matching lines omitted`;
    const recovery = details.outputTruncated
      ? "Narrow path or glob, reduce context, or use outputMode: files."
      : "Narrow path or glob, raise limit, or use outputMode: files.";
    lines.push(`Incomplete: ${reason}. ${recovery}`);
    // Where to narrow to. A capped result is the first matches in traversal
    // order, so without this the model is told to narrow and has to guess.
    const spread = details.matchesByFile ?? [];
    if (spread.length > 1) {
      const shown = spread.slice(0, FILES_SHOWN).map(([path, count]) => `${path} ${count}`).join(", ");
      const rest = spread.length - Math.min(spread.length, FILES_SHOWN);
      lines.push(`Matches by file: ${shown}${rest > 0 ? `, and ${rest} more file(s)` : ""}`
        + `${details.countTruncated ? ", counted only as far as the scan got" : ""}.`);
    }
  } else if (!details.scanComplete && !details.errors.length) {
    lines.push("Incomplete: the scan stopped early; unscanned matches may exist.");
  }
  if (details.filesAtMatchLimit?.length) {
    lines.push(`Per-file cap ${details.maxMatchesPerFile} reached in ${details.filesAtMatchLimit.length} file(s) marked [sample]; rerun those paths uncapped for all matches.`);
  }
  if (details.rows.some((row) => row.encodingLoss)) {
    lines.push("Invalid UTF-8 was decoded with replacement; those lines are quoted.");
  }
  if (details.errors.length) lines.push(`Search error: ${quotedSearchErrors(details.errors)}`);
  else if (!observed) lines.push("No matches found.");
  return lines;
}

function pack(scan: Awaited<ReturnType<typeof collect>>, maxBytes: number, symbols?: SymbolIndex) {
  const details: SearchDetails = { rows: [], scanComplete: scan.complete, resultOverflow: scan.overflow, clippedText: false,
    omittedSpans: scan.omittedSpans, omittedContextLines: 0, omittedMatchingLines: 0, observedMatchingLines: scan.observed, outputTruncated: false, errors: scan.errors,
    matchesByFile: [...scan.matchesByFile].sort((a, b) => b[1] - a[1]), countTruncated: scan.countTruncated,
    ...(scan.maxMatchesPerFile !== undefined ? { maxMatchesPerFile: scan.maxMatchesPerFile, filesAtMatchLimit: scan.filesAtMatchLimit } : {}) };
  const order = new Map(scan.rows.map((row, index) => [row, index]));
  const rendered: { index: number; text: string; path: string; label?: string }[] = [];
  const selected: { index: number; row: SearchRow }[] = [];
  const sampledFiles = new Set(scan.filesAtMatchLimit ?? []);
  const render = (row: SourceRow, range: ByteRange) => renderExcerpt(row, range, sampledFiles.has(row.path));
  // A file's heading is charged to the first of its rows, so the saved
  // repetition is spent on more matches rather than left on the table. Which
  // row carries it can shift if that one is dropped; the footer reserve covers
  // the difference, which is one heading at most.
  const headed = new Set<number>();
  for (const row of scan.rows) {
    const index = order.get(row)!;
    if (!headed.has(index) && ![...headed].some(other => scan.rows[other]!.path === row.path)) headed.add(index);
  }
  // Reserve a bounded footer so notices never push the response past its limit.
  const footerReserve = 512;
  let bytes = 0;
  const append = (line: string, row: SourceRow) => {
    const index = order.get(row)!;
    const label = symbols && row.kind === "match" ? labelFor(symbols, row.path, row.line) : undefined;
    const overhead = headed.has(index) ? Buffer.byteLength(row.path) + 1 : 0;
    const size = Buffer.byteLength(line) + 1 + overhead + (label ? Buffer.byteLength(label) + 4 : 0);
    if (bytes + size > maxBytes - footerReserve) { details.outputTruncated = true; return false; }
    rendered.push({ index, text: line, path: row.path, ...(label ? { label } : {}) });
    bytes += size; return true;
  };
  // Optional surrounding lines must not consume the space needed for matching lines.
  for (const row of [...scan.rows.filter((row) => row.kind === "match"), ...scan.rows.filter((row) => row.kind === "context")]) {
    const { source, ...metadata } = row;
    const kept: SearchRow = { ...metadata, excerpts: [] };
    let ranges = windows(row);
    if (row.kind === "context" && ranges[0]!.end < row.sourceBytes) {
      const whole = { start: 0, end: row.sourceBytes };
      // Matching lines have already been packed. Retain requested context when it fits.
      if (bytes + Buffer.byteLength(render(row, whole).line) + 1 <= maxBytes - footerReserve) ranges = [whole];
    }
    for (const range of ranges) {
      const { text, line } = render(row, range);
      if (append(line, row)) kept.excerpts.push({ ...range, text });
    }
    const omitted = row.matches.filter((match) => !kept.excerpts.some((span) => span.start <= match.start && span.end >= match.end)).length;
    details.omittedSpans += omitted;
    if (!kept.excerpts.length) {
      if (row.kind === "context") details.omittedContextLines++;
      else {
        // A matching line that cannot fit still names its location.
        details.omittedMatchingLines++;
        append(`  ${row.line}: [omitted, ${row.sourceBytes} bytes]`, row);
      }
    } else selected.push({ index: order.get(row)!, row: kept });
    if (kept.excerpts.length !== 1 || kept.excerpts[0]!.start !== 0 || kept.excerpts[0]!.end !== row.sourceBytes) details.clippedText = true;
  }
  // Headings are inserted here, where the final order is known, so a run of
  // hits in one file and one symbol states both once instead of per line.
  const previous: { path?: string; label?: string } = {};
  const lines = rendered.sort((a, b) => a.index - b.index)
    .flatMap(item => [...heading(item.path, item.label, previous), item.text]);
  details.rows = selected.sort((a, b) => a.index - b.index).map((item) => item.row);
  details.omittedMatchingLines += Math.max(0, scan.observed - scan.rows.filter((row) => row.kind === "match").length);
  const shownMatchLines = details.rows.filter((row) => row.kind === "match").length;
  const footer = notices(details, scan.observed, shownMatchLines);
  const bodyBytes = Buffer.byteLength(lines.join("\n"));
  if (bodyBytes + (lines.length ? 1 : 0) + Buffer.byteLength(footer.join("\n")) > maxBytes) {
    details.outputTruncated = true;
    if (!footer.some(line => line.startsWith("Incomplete:"))) {
      footer.unshift("Incomplete: output limit reached; some diagnostics omitted.");
    }
    // A long file list is optional. Keep the incomplete and error notices visible.
    footer.sort((a, b) => Number(a.startsWith("Matches by file:")) - Number(b.startsWith("Matches by file:")));
  }
  let outputBytes = bodyBytes;
  for (let line of footer) {
    const separator = lines.length ? 1 : 0;
    const remaining = maxBytes - outputBytes - separator;
    if (remaining <= 0) break;
    if (line.startsWith("Matches by file:") && Buffer.byteLength(line) > remaining) {
      line = "Matches by file: list omitted by output limit; narrow path or glob.";
    }
    if (Buffer.byteLength(line) > remaining) {
      let clipped = "", size = Buffer.byteLength("…");
      for (const char of line) {
        const next = Buffer.byteLength(char);
        if (size + next > remaining) break;
        clipped += char; size += next;
      }
      line = clipped ? `${clipped}…` : "";
    }
    if (!line) continue;
    lines.push(line);
    outputBytes += separator + Buffer.byteLength(line);
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }], details, ...(scan.errors.length ? { isError: true } : {}) };
}

function validScope(value: unknown, maxItems = 16): boolean {
  return value === undefined || typeof value === "string" || Array.isArray(value) && value.length >= 1 && value.length <= maxItems
    && [...value].every(item => typeof item === "string" && item.length > 0);
}

/** Native Pi search fields with multiple paths, ordered globs and a files mode. */
export function createSearchTool(cwd: string, options: SearchOptions = {}) {
  const { renderCall: _renderCall, renderResult: _renderResult, ...native } = createGrepToolDefinition(cwd);
  const maxBytes = options.maxOutputBytes ?? OUTPUT_LIMIT, streamBytes = options.maxStreamBytes ?? STREAM_LIMIT;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || !Number.isSafeInteger(streamBytes) || streamBytes < 1) throw new Error("Invalid search byte limits.");
  return {
    ...native,
    parameters: Type.Object({ ...native.parameters.properties,
      path: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: SEARCH_PATH_LIMIT })], {
        description: `One path, or up to ${SEARCH_PATH_LIMIT} searched together (default: current directory). Relative to the session directory; ~ and @ are literal. Explicit files bypass ignore and glob filters.`,
      })),
      glob: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 16 })], {
        description: "One ripgrep glob, or up to 16 ordered rules. Prefix ! to exclude; later rules win. Example: ['*.{ts,tsx}', '!**/*.generated.ts'].",
      })),
      outputMode: Type.Optional(Type.Union([Type.Literal("content"), Type.Literal("files")], { description: "content returns matching lines (default); files returns unique matching paths." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum matching lines, or files in files mode (default: 100)." })),
      maxMatchesPerFile: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Content mode: cap matches per file for broad discovery, for example 1. Omitted means uncapped." })),
      context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Surrounding lines per match, content mode only (default: 0)." })),
    }),
    description: "Search file contents with ripgrep. Content mode heads each file's hits with its path, names the enclosing symbol in brackets where one is known, and returns `line: text` per match, with `-` instead of `:` for context lines. Long lines are clipped around the match and marked with an ellipsis. Files mode returns unique matching paths.",

    promptGuidelines: ["Prefer named paths and globs over a repository-wide search."],
    async execute(_id: string, args: unknown, signal?: AbortSignal, _onUpdate?: unknown, ctx?: Pick<ExtensionToolContext, "cwd">): Promise<SearchResult> {
      const input = args as SearchInput;
      if (!input || typeof input.pattern !== "string" || Buffer.byteLength(JSON.stringify(input)) > 64 * 1024
        || !validScope(input.path, SEARCH_PATH_LIMIT) || !validScope(input.glob)
        || !Number.isSafeInteger(input.limit ?? 100) || (input.limit ?? 100) < 1 || (input.limit ?? 100) > 1000
        || !Number.isSafeInteger(input.context ?? 0) || (input.context ?? 0) < 0 || (input.context ?? 0) > 20
        || input.maxMatchesPerFile !== undefined && (!Number.isSafeInteger(input.maxMatchesPerFile) || input.maxMatchesPerFile < 1 || input.maxMatchesPerFile > 1000)
        || input.outputMode !== undefined && !["content", "files"].includes(input.outputMode)) throw new Error("Invalid search parameters or input exceeds 64 KiB.");
      if (input.outputMode === "files" && input.maxMatchesPerFile !== undefined) throw new Error("maxMatchesPerFile applies to content mode only; files mode already returns unique paths.");
      const request = { ...input, ...(Array.isArray(input.glob) ? { glob: [...input.glob] } : {}),
        ...(Array.isArray(input.path) ? { path: [...input.path] } : {}) };
      const sessionCwd = ctx?.cwd ?? cwd;
      signal?.throwIfAborted();
      const executable = options.executable ?? await resolveRipgrep(undefined, undefined, sessionCwd);
      signal?.throwIfAborted();
      if (request.outputMode === "files") return searchFiles(sessionCwd, executable,
        searchArgs(sessionCwd, request, ["--files-with-matches", "--null"]), request.limit ?? 100,
        { maxStreamBytes: streamBytes, maxOutputBytes: maxBytes }, signal);
      const scan = await collect(sessionCwd, request, executable, streamBytes, signal);
      signal?.throwIfAborted();
      const symbols = await indexSymbols(sessionCwd, scan.rows.filter(row => row.kind === "match").map(row => row.path));
      signal?.throwIfAborted();
      return pack(scan, maxBytes, symbols);
    },
  };
}

export default function searchExtension(pi: ExtensionAPI): void {
  pi.registerTool(createSearchTool(process.cwd()));
}
