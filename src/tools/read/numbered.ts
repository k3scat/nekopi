import { createReadToolDefinition, formatSize, truncateHead,
  type ReadToolDetails, type ReadToolOptions, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isUtf8 } from "node:buffer";
import { readSnapshot } from "./snapshot.ts";

export interface NumberedReadDetails extends ReadToolDetails {
  numberedRead?: {
    path: string;
    startLine: number;
    endLine: number | null;
    totalSourceLines: number;
    sourceLinesReturned: number;
    sourceLinesOmittedForNumbering: number;
    numberedOutputBytes: number;
    truncatedByNumbering: boolean;
    linePrefixesOmitted: boolean;
    encodingLoss: boolean;
  };
}

/** Numbered presentation. Registration and session authority belong to the caller. */
export function createNumberedReadToolDefinition(cwd: string, options: ReadToolOptions = {}) {
  const template = createReadToolDefinition(cwd, options);
  const definition: ToolDefinition<typeof template.parameters, NumberedReadDetails | undefined> = {
    ...template,
    description: `${template.description} Positive integer ranges return original 1-based source line labels. Numbered text retains the native line and byte caps; continuation notices identify the next source line.`,
    async execute(...args: Parameters<typeof template.execute>) {
      const originalInput = args[1];
      // Native read captures these values before its first await. Formatting uses the same range.
      const input = { ...originalInput };
      args[1] = input;
      const { result, captured, image } = await readSnapshot(cwd, options, args);
      // Images, native oversized-line notices and unusual native numeric semantics stay native.
      if (!captured || image || result.content.length !== 1 || result.content[0]?.type !== "text"
        || result.details?.truncation?.firstLineExceedsLimit
        || [input.offset, input.limit].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 1))) return result;

      const source = captured.buffer.toString("utf8"), allLines = source.split("\n");
      const sourceLines = source.length ? allLines.slice(0, source.endsWith("\n") ? -1 : undefined) : [];
      const start = (input.offset ?? 1) - 1;
      const selected = allLines.slice(start, input.limit === undefined ? undefined : start + input.limit);
      const nativeWindow = result.details?.truncation ?? truncateHead(selected.join("\n"));
      const output = result.content[0].text;
      // Verify a known source prefix. Never infer source boundaries by matching footer text.
      if (!output.startsWith(nativeWindow.content)) return result;
      const count = Math.min(result.details?.truncation ? nativeWindow.outputLines : selected.length, Math.max(0, sourceLines.length - start));
      const rows = sourceLines.slice(start, start + count);
      const numbered = rows.map((line, index) => `${start + index + 1}: ${line}`).join("\n")
        + (nativeWindow.content.endsWith("\n") ? "\n" : "");
      const bounded = truncateHead(numbered);
      const linePrefixesOmitted = bounded.firstLineExceedsLimit;
      const returned = linePrefixesOmitted ? rows.length : Math.min(rows.length, bounded.outputLines);
      const end = returned ? start + returned : null;
      const path = captured.path;
      let body = linePrefixesOmitted ? nativeWindow.content : bounded.content;
      let notice = output.slice(nativeWindow.content.length);
      if (bounded.truncated && !linePrefixesOmitted) {
        notice = `\n\n[Numbered output limited to ${formatSize(bounded.maxBytes)}. Showing source lines ${start + 1}-${end}. Use offset=${start + returned + 1} to continue.]`;
      }
      const encodingLoss = !isUtf8(captured.buffer);
      const heading = `File ${JSON.stringify(path)}\n${returned ? `Source lines ${start + 1}-${end}.` : "No source lines returned."}`;
      if (linePrefixesOmitted) body = `[Line prefixes omitted to preserve a source line that exceeds the numbered byte limit.]\n${body}`;
      if (encodingLoss) notice += "\n[Invalid UTF-8 was decoded with replacement; source line numbers follow LF separators.]";
      return { ...result, content: [{ type: "text", text: `${heading}\n${body}${notice}` }],
        details: { ...result.details, numberedRead: {
          path, startLine: start + 1, endLine: end, totalSourceLines: sourceLines.length,
          sourceLinesReturned: returned, sourceLinesOmittedForNumbering: rows.length - returned,
          numberedOutputBytes: Buffer.byteLength(linePrefixesOmitted ? nativeWindow.content : bounded.content),
          truncatedByNumbering: bounded.truncated && !linePrefixesOmitted, linePrefixesOmitted, encodingLoss,
        } } };
    },
  };
  return definition;
}
