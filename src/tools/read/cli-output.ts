import { truncateHead } from "@earendil-works/pi-coding-agent";

import { CLI_READ_MAX_BYTES, CLI_READ_MAX_LINES, linesIn, shellQuote, nextSpan, rewriteContinuations } from "./cli-budget.ts";
export { CLI_READ_MAX_BYTES, cliRangeLimits } from "./cli-budget.ts";

interface ReadResult {
  content: readonly { type: string; text?: string }[];
  details?: unknown;
}

interface ReadDetails {
  numberedRead?: { startLine: number; totalSourceLines: number };
  rangeRead?: { totalSourceLines: number };
}

function lastSourceLine(text: string): number | undefined {
  let last: number | undefined;
  for (const match of text.matchAll(/^(\d+): /gmu)) last = Number(match[1]);
  return last;
}

function shapePart(text: string): { body: string; shape: string } {
  const matches = [...text.matchAll(/\n\nShape of [^\n]+, to read a range from:\n/gu)];
  const at = matches.at(-1)?.index;
  if (at === undefined) return { body: text, shape: "" };
  return { body: text.slice(0, at), shape: text.slice(at) };
}

/** Keep source headings and a useful map before Pi Bash applies its tail cap. */
export function cliReadText(result: ReadResult, path: string, prefix = ""): string {
  const details = result.details as ReadDetails | undefined;
  const total = details?.numberedRead?.totalSourceLines ?? details?.rangeRead?.totalSourceLines;
  let text = result.content.flatMap(block => block.type === "text" && block.text ? [block.text] : []).join("\n");
  text = rewriteContinuations(text, path, total);
  const whole = prefix + text;
  if (Buffer.byteLength(whole) <= CLI_READ_MAX_BYTES && linesIn(whole) <= CLI_READ_MAX_LINES) return whole;

  const prefixWindow = truncateHead(prefix, { maxBytes: 4 * 1024, maxLines: 100 });
  const front = prefixWindow.content + (prefixWindow.truncated ? "\n[Declaration list limited; select a file to narrow it.]\n" : "");
  const parts = shapePart(text);
  const shapeWindow = truncateHead(parts.shape, { maxBytes: 8 * 1024, maxLines: 80 });
  const shape = shapeWindow.content + (shapeWindow.truncated ? "\n[Symbol map limited; read a narrower range.]" : "");
  const quoted = shellQuote(path);
  let budget = CLI_READ_MAX_BYTES - Buffer.byteLength(front + shape) - Buffer.byteLength(quoted) - 256;
  let lineBudget = CLI_READ_MAX_LINES - linesIn(front + shape) - 4;
  while (true) {
    const window = truncateHead(parts.body, { maxBytes: Math.max(1, budget), maxLines: Math.max(1, lineBudget) });
    const last = details?.numberedRead || details?.rangeRead ? lastSourceLine(window.content) : undefined;
    const next = last === undefined ? details?.numberedRead?.startLine : last + 1;
    const note = !window.truncated ? "" : next !== undefined && (total === undefined || next <= total)
      ? `\n\n[Read output limited for Bash. Continue with nek read ${quoted} --lines ${nextSpan(next, total)}.]`
      : "\n\n[Read output limited for Bash. Use a narrower --lines range.]";
    const body = last === undefined ? window.content : window.content.replace(
      /^(File [^\n]+\nSource lines \d+)-\d+\./u, `$1-${last}.`);
    const output = front + body + note + shape;
    const excessBytes = Buffer.byteLength(output) - CLI_READ_MAX_BYTES;
    const excessLines = linesIn(output) - CLI_READ_MAX_LINES;
    if (excessBytes <= 0 && excessLines <= 0) return output;
    budget -= Math.max(0, excessBytes) + 1;
    lineBudget -= Math.max(0, excessLines) + 1;
  }
}
