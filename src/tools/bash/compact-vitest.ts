import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/gu;
const FAILURE = /^[⎯─]{3,}[ \t]+(?:Unhandled Rejection|Uncaught Exception)[ \t]+[⎯─]+[ \t]*$/gmu;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function signature(block: string): string | undefined {
  const error = /^[A-Za-z][\w.]*(?:Error|Exception): [^\n]+$/mu.exec(block);
  const frame = /^[ \t]*❯[ \t]+[^\n]+$/mu.exec(block);
  return error && frame ? `${error[0]} at ${frame[0].trim()}` : undefined;
}

/** Fold repeated Vitest errors in a Bash preview; keep every distinct line and the final summary. */
export function compactVitestPreview(preview: string): string | undefined {
  const text = preview.replace(ANSI, "").replace(/\r\n?/gu, "\n");
  const headers = [...text.matchAll(FAILURE)];
  if (headers.length < 3) return;

  const seen = new Map<string, { lines: Set<string>; count: number }>();
  let output = text.slice(0, headers[0]!.index);
  for (let index = 0; index < headers.length - 1; index++) {
    const block = text.slice(headers[index]!.index, headers[index + 1]!.index);
    const key = signature(block);
    if (!key) { output += block; continue; }
    const previous = seen.get(key);
    const lines = block.split("\n");
    if (!previous) {
      seen.set(key, { lines: new Set(lines.filter(Boolean)), count: 1 });
      output += block;
      continue;
    }
    previous.count++;
    const newLines = lines.filter(line => {
      if (!line || previous.lines.has(line)) return false;
      previous.lines.add(line);
      return true;
    });
    if (newLines.length) {
      output += `[New lines in visible occurrence ${previous.count} of ${key}]\n${newLines.join("\n")}\n`;
    }
  }

  // The last block also carries Vitest's final summary and Pi's full-log path.
  // Leave it whole, even when its error appeared earlier.
  const tail = text.slice(headers.at(-1)!.index);
  const last = signature(tail);
  if (last) {
    const entry = seen.get(last);
    if (entry) entry.count++;
    else seen.set(last, { lines: new Set(), count: 1 });
  }
  const repeated = [...seen].filter(([, entry]) => entry.count > 1);
  if (!repeated.length) return;
  output += `[Visible repeated Vitest errors: ${repeated.map(([key, entry]) => `${entry.count} × ${key}`).join("; ")}]\n${tail}`;
  if (Buffer.byteLength(text) - Buffer.byteLength(output) < 4096) return;
  return output;
}

/** Keep Pi's complete structured output and exit status available to other hooks. */
export function compactRepeatedVitestFailures(event: ToolResultEvent): ToolResultEventResult | undefined {
  const result = event.structuredContent;
  if (event.toolName !== "bash" || !event.isError || !object(result)
    || !Number.isSafeInteger(result.exit_code) || result.exit_code === 0
    || typeof result.output !== "string" || event.content.length !== 1
    || event.content[0]?.type !== "text") return;
  const preview = event.content[0].text;
  const plain = preview.replace(ANSI, "");
  if (Buffer.byteLength(preview) < 12 * 1024
    || !/\bVitest\b/u.test(plain)
    || !/\[Showing lines \d+-\d+ of \d+ \([^\n]+\)\. Full output: [^\]\n]+\]/u.test(plain)
    || !/^[ \t]*Tests[ \t]+\d+ failed/mu.test(plain)) return;
  const compacted = compactVitestPreview(preview);
  if (!compacted) return;
  return { content: [{ ...event.content[0], text: compacted }], structuredContent: event.structuredContent };
}
