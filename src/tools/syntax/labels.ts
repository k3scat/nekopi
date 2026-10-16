import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { languageFor } from "./languages.ts";
import { isParsed, parseSource } from "./parser.ts";
import { enclosing, outlineOf, type Symbol } from "./symbols.ts";

/** Parsing is bounded so a wide search does not become a parse job. */
const MAX_FILES = 24;
const MAX_LABEL = 60;

export type SymbolIndex = Map<string, Symbol[]>;

/**
 * Outline the files a search matched, so each hit can name the symbol that
 * contains it. Only matched files are parsed, so the cost follows the result
 * rather than the repository. Any failure drops the label and never the hit.
 */
export async function indexSymbols(cwd: string, paths: readonly string[], lines?: ReadonlyMap<string, readonly number[]>): Promise<SymbolIndex> {
  const index: SymbolIndex = new Map();
  const distinct = [...new Set(paths)].filter(path => languageFor(path)).slice(0, MAX_FILES);
  await Promise.all(distinct.map(async path => {
    try {
      const text = await readFile(resolve(cwd, path), "utf8");
      const parsed = await parseSource(path, text);
      if (!isParsed(parsed)) return;
      try {
        index.set(path, outlineOf(parsed.tree.rootNode, parsed.rules, { lines: lines?.get(path) }).symbols);
      } finally {
        parsed.tree.delete();
      }
    } catch {
      // A file that cannot be read or parsed simply has no labels.
    }
  }));
  return index;
}

/**
 * Name the innermost symbol containing a line, with its owners.
 *
 * The label answers "where am I" for a search hit. It is omitted at module
 * scope, where it would add nothing.
 */
export function labelFor(index: SymbolIndex, path: string, line: number): string | undefined {
  const symbols = index.get(path);
  if (!symbols) return undefined;
  const trail = enclosing(symbols, line);
  if (!trail.length) return undefined;
  const leaf = trail[trail.length - 1]!;
  const owners = trail.slice(0, -1).map(symbol => symbol.name);
  const label = [...owners, `${leaf.kind} ${leaf.name}`].join(" > ");
  return label.length > MAX_LABEL ? `…${label.slice(label.length - MAX_LABEL + 1)}` : label;
}
