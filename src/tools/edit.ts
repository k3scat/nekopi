import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { createEditToolDefinition, defineTool, type EditOperations, type EditToolInput } from "@earendil-works/pi-coding-agent";

const MAX_SOURCE_BYTES = 1024 * 1024, MAX_ERROR_BYTES = 4096, MAX_CANDIDATES = 4;
const localOperations: EditOperations = {
  access: path => access(path, constants.R_OK | constants.W_OK),
  readFile: path => readFile(path),
  writeFile: (path, text) => writeFile(path, text, "utf8"),
};
const lf = (text: string) => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

function ambiguousEdit(error: unknown, input: EditToolInput): number | undefined {
  if (!(error instanceof Error)) return;
  const match = /^Found ([1-9]\d*) occurrences of (the text|edits\[([0-9]+)\]) in /.exec(error.message);
  if (!match || Number(match[1]) < 2 || !Number.isSafeInteger(Number(match[1]))) return;
  const single = input.edits.length === 1, index = single ? 0 : Number(match[3]);
  if (single !== (match[2] === "the text") || !Number.isSafeInteger(index) || index < 0 || index >= input.edits.length) return;
  const expected = single
    ? `Found ${match[1]} occurrences of the text in ${input.path}. The text must be unique. Please provide more context to make it unique.`
    : `Found ${match[1]} occurrences of edits[${index}] in ${input.path}. Each oldText must be unique. Please provide more context to make it unique.`;
  return error.message === expected ? index : undefined;
}

function missingEdit(error: unknown, input: EditToolInput): number | undefined {
  if (!(error instanceof Error)) return;
  if (input.edits.length === 1) return error.message === `Could not find the exact text in ${input.path}. The old text must match exactly including all whitespace and newlines.` ? 0 : undefined;
  const match = /^Could not find edits\[([0-9]+)\] in /.exec(error.message);
  if (!match) return;
  const index = Number(match[1]);
  if (!Number.isSafeInteger(index) || index < 0 || index >= input.edits.length) return;
  return error.message === `Could not find edits[${index}] in ${input.path}. The oldText must match exactly including all whitespace and newlines.` ? index : undefined;
}

function recovery(error: Error, input: EditToolInput, index: number, snapshot: Buffer, whitespace: boolean): string | undefined {
  const decoded = snapshot.toString("utf8"), source = lf(decoded.startsWith("\uFEFF") ? decoded.slice(1) : decoded);
  const needle = lf(input.edits[index]!.oldText);
  if (!needle || Buffer.byteLength(needle) > MAX_SOURCE_BYTES) return;
  const lines = source.split("\n"), requested = needle.split("\n");
  const terminalLF = needle.endsWith("\n");
  if (terminalLF) requested.pop(); // A terminating LF is not an additional blank line.
  if (whitespace && !requested.some(line => line.trim().length)) return;
  // Locate whitespace-related source only. Native matching and mutation remain authoritative.
  const haystack = whitespace ? `\n${lines.map(line => line.trim()).join("\n")}\n` : source;
  const search = whitespace ? `\n${requested.map(line => line.trim()).join("\n")}\n` : needle;
  const candidates: Array<{ first: number; last: number }> = [];
  const lineAt = (text: string, position: number) => text.slice(0, position).split("\n").length;
  let count = 0, offset = haystack.indexOf(search), syntheticOnly = false;
  while (offset !== -1) {
    // Count every location, but compute line coordinates for only the returned candidates.
    if (whitespace && terminalLF && offset + search.length === haystack.length) { syntheticOnly = true; break; } // Last delimiter is synthetic.
    count++;
    if (candidates.length < MAX_CANDIDATES) {
      const first = lineAt(haystack, offset);
      candidates.push({ first, last: whitespace ? first + requested.length - 1 : lineAt(source, offset + needle.length - 1) });
    }
    offset = haystack.indexOf(search, offset + 1);
  }
  // A missing single-line edit can have a mistyped suffix or argument. Show
  // only a globally unique literal anchor, without inferring a replacement.
  let prefix: string | undefined;
  if (whitespace && !count && !needle.includes("\n")) {
    const characters = Array.from(needle.trim());
    if (characters.length > 32) {
      const anchor = characters.slice(0, 32).join(""), at = source.indexOf(anchor);
      if (at >= 0 && source.indexOf(anchor, at + 1) === -1) {
        prefix = anchor; count = 1;
        const first = lineAt(source, at);
        candidates.push({ first, last: first });
      }
    }
  }
  /** A unique leading run anchors context, not a replacement target. */
  let anchored = 0;
  // Do not report a differing line when only the terminal newline is missing.
  if (whitespace && !count && !syntheticOnly && requested.length > 1) {
    for (let run = requested.length - 1; run >= 1; run--) {
      const lead = `\n${requested.slice(0, run).map(line => line.trim()).join("\n")}\n`;
      const at = haystack.indexOf(lead);
      if (at === -1 || haystack.indexOf(lead, at + 1) !== -1) continue;
      const first = lineAt(haystack, at);
      anchored = run; count = 1;
      candidates.push({ first, last: Math.min(lines.length, first + requested.length - 1) });
      break;
    }
  }
  if (!count) return; // Native fuzzy matching is authoritative; do not emulate it.
  const tight = prefix !== undefined || anchored > 0;
  // Name the match kind so the model does not treat these as exact oldText matches.
  const matchKind = prefix
    ? `unique prefix ${JSON.stringify(prefix)}, not a replacement target`
    : anchored
      ? `its first ${anchored} of ${requested.length} lines matched here; the source below is what the rest differs from`
      : whitespace ? "equal after trimming each line's edge whitespace" : "exact; native fuzzy matching may find more";
  const parts = [`edits[${index}].oldText (${matchKind}), from the pre-attempt snapshot:`];
  let bytes = Buffer.byteLength(error.message) + 2 + Buffer.byteLength(parts[0]!);
  const footerReserve = 256;
  if (bytes > MAX_ERROR_BYTES - footerReserve) return;
  const append = (text: string) => {
    const size = Buffer.byteLength(text) + 1;
    if (bytes + size > MAX_ERROR_BYTES - footerReserve) return false;
    parts.push(text); bytes += size; return true;
  };
  let shown = 0, omittedContext = 0;
  let nextSourceLine = 1;
  for (const { first, last } of candidates) {
    const label = `${input.path}:${first}${first === last ? "" : `-${last}`}`;
    // Prefix evidence is useful only with its complete source line.
    if (tight && bytes + Buffer.byteLength(label) + Buffer.byteLength(`${first}: ${JSON.stringify(lines[first - 1])}`) + 2 > MAX_ERROR_BYTES - footerReserve) return;
    if (!append(label)) break;
    shown++;
    // Candidate windows arrive in source order. Skip lines already returned or omitted.
    const from = Math.max(nextSourceLine, tight ? first : Math.max(1, first - 1));
    const to = tight ? last : Math.min(lines.length, last + 1);
    for (let line = from; line <= to; line++) {
      if (!append(`${line}: ${JSON.stringify(lines[line - 1])}`)) omittedContext++;
    }
    nextSourceLine = Math.max(nextSourceLine, to + 1);
  }
  // Report counts only when something was left out.
  if (shown < count || omittedContext) {
    const footer = `${shown}/${count} locations shown${omittedContext ? `, ${omittedContext} source lines omitted` : ""}.`;
    parts.push(footer); bytes += Buffer.byteLength(footer) + 1;
  }
  if (!whitespace) {
    const hint = `Make edits[${index}].oldText unique with more context, or use Bash to replace every occurrence after asserting the count.`;
    // Source locations and omission metadata take priority over optional guidance.
    if (bytes + Buffer.byteLength(hint) + 1 <= MAX_ERROR_BYTES) parts.push(hint);
  }
  return parts.join("\n");
}

/** Native edit owns argument preparation, matching, queuing and writes. */
export function createEditRecoveryTool(cwd: string, operations: EditOperations = localOperations) {
  const native = createEditToolDefinition(cwd, { operations });
  return defineTool({ ...native,
    async execute(...args: Parameters<typeof native.execute>) {
      // Native edit captures these fields before waiting for the file mutation queue.
      const input = { ...args[1] };
      let snapshot: Buffer | undefined, writeStarted = false;
      const attempt = createEditToolDefinition(cwd, { operations: {
        access: path => operations.access(path),
        async readFile(path) {
          const buffer = await operations.readFile(path);
          if (Buffer.isBuffer(buffer) && buffer.length <= MAX_SOURCE_BYTES && isUtf8(buffer)) snapshot = Buffer.from(buffer);
          return buffer;
        },
        writeFile(path, text) { writeStarted = true; return operations.writeFile(path, text); },
      } });
      try { return await attempt.execute(...args); }
      catch (error) {
        const ambiguous = ambiguousEdit(error, input), index = ambiguous ?? missingEdit(error, input);
        if (index === undefined || !snapshot || writeStarted || !(error instanceof Error)) throw error;
        const evidence = recovery(error, input, index, snapshot, ambiguous === undefined);
        if (!evidence) throw error;
        throw new Error(`${error.message}\n\n${evidence}`, { cause: error });
      }
    },
  });
}
