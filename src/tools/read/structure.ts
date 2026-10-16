import { readFile } from "node:fs/promises";
import { isParsed, parseSource } from "../syntax/parser.ts";
import { outlineOf, type Symbol } from "../syntax/symbols.ts";

/** Attach a bounded symbol map when a read cannot return the whole file. */
const MAX_SYMBOLS = 48;
const MAX_DEPTH = 2;

/** Default prefix for reads without an explicit selection. */
export const UNBOUNDED_LINES = 200;

export interface Shape {
  /** Lines in the whole file, so a caller can tell whether the cap bit. */
  lines: number;
  text: string;
}

function render(symbols: readonly Symbol[], depth: number, lines: string[], budget: { left: number }): void {
  for (const symbol of symbols) {
    if (budget.left <= 0) return;
    budget.left -= 1;
    const range = symbol.endLine === symbol.startLine ? `${symbol.startLine}` : `${symbol.startLine}-${symbol.endLine}`;
    lines.push(`${"  ".repeat(depth)}${range}  ${symbol.kind} ${symbol.name}`);
    if (depth + 1 < MAX_DEPTH) render(symbol.children, depth + 1, lines, budget);
  }
}

function count(symbols: readonly Symbol[], depth: number): number {
  let total = 0;
  for (const symbol of symbols) {
    total += 1;
    if (depth + 1 < MAX_DEPTH) total += count(symbol.children, depth + 1);
  }
  return total;
}

/** Omit the map when parsing is unavailable or finds no declarations. */
export async function shapeOf(file: string, display: string): Promise<Shape | undefined> {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch { return undefined; }
  const lines = text.length ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
  const parsed = await parseSource(display, text);
  if (!isParsed(parsed)) return undefined;
  try {
    const { symbols } = outlineOf(parsed.tree.rootNode, parsed.rules, { includeMembers: false });
    if (!symbols.length) return undefined;
    const rendered: string[] = [];
    render(symbols, 0, rendered, { left: MAX_SYMBOLS });
    if (!rendered.length) return undefined;
    const total = count(symbols, 0);
    const omitted = total - rendered.length;
    return { lines, text: [`Shape of ${display}, to read a range from:`, ...rendered,
      ...(omitted > 0 ? [`(+${omitted} more; read a range for the rest)`] : [])].join("\n") };
  } finally {
    parsed.tree.delete();
  }
}
