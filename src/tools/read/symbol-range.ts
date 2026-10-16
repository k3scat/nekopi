import { readFile } from "node:fs/promises";
import { isParsed, parseSource } from "../syntax/parser.ts";
import { findSymbol, outlineOf, type Symbol } from "../syntax/symbols.ts";
import type { SourceRange } from "./ranges.ts";

const MAX_LISTED = 24;

/** Names by increasing depth, so the shallow ones a miss usually meant come first. */
function declaredNames(symbols: readonly Symbol[]): string[] {
  const byDepth: string[][] = [];
  const walk = (list: readonly Symbol[], trail: string, depth: number): void => {
    if (depth > 2) return;
    for (const symbol of list) {
      const path = trail ? `${trail}/${symbol.name}` : symbol.name;
      (byDepth[depth] ??= []).push(path);
      walk(symbol.children, path, depth + 1);
    }
  };
  walk(symbols, "", 0);
  return byDepth.flat();
}

/**
 * Declared names that look like the one asked for, closest first.
 *
 * Seven of 140 debrief answers asked for this in so many words: "It could
 * have suggested the similarly named TestPullRequestExportData". The list of
 * declared names already carried the answer and buried it, because it was
 * ordered by depth and cut at 24, and a workspace search then reported the
 * name as absent because a word boundary does not match inside a longer
 * identifier.
 */
function nearNames(query: string, available: readonly string[]): string[] {
  const wanted = query.toLowerCase();
  const shared = (name: string): number => {
    const other = name.toLowerCase();
    let at = 0;
    while (at < wanted.length && at < other.length && wanted[at] === other[at]) at++;
    return at;
  };
  return available
    .map(name => ({ name, prefix: shared(name), contains: name.toLowerCase().includes(wanted)
      || wanted.includes(name.toLowerCase().split("/").pop() ?? "") }))
    .filter(one => one.contains || one.prefix >= 4)
    .sort((a, b) => Number(b.contains) - Number(a.contains) || b.prefix - a.prefix
      || a.name.length - b.name.length)
    .map(one => one.name);
}

/** Accept the declaration labels emitted by grep without changing literal lookup. */
function labelledSymbol(symbols: readonly Symbol[], query: string, language: string): Symbol[] {
  const parts = query.trim().split(/\s+>\s+/u);
  const leaf = parts.pop() ?? "";
  if (!leaf || parts.some(part => !part.trim())) return [];
  const lookup = (label: string, owners: readonly string[]): Symbol[] => {
    const matches: Symbol[] = [];
    const walk = (list: readonly Symbol[], trail: readonly string[]): void => {
      for (const symbol of list) {
        if (`${symbol.kind} ${symbol.name}` === label
          && owners.length <= trail.length
          && owners.every((owner, index) => owner === trail[trail.length - owners.length + index])) {
          matches.push(symbol);
        }
        walk(symbol.children, [...trail, symbol.name]);
      }
    };
    walk(symbols, []);
    return matches;
  };
  // Keep the raw symbol name intact. Splitting a C++ `Owner::member` path here
  // would make its definition indistinguishable from an in-class declaration.
  let matches = lookup(leaf, parts);
  if (!matches.length && language === "rust" && leaf.startsWith("method ")) {
    matches = lookup(`fn ${leaf.slice("method ".length)}`, parts);
  }
  // A Go receiver method is flat in the syntax outline. Preserve the existing
  // type/member spelling, but require a declared type before ignoring its owner.
  if (!matches.length && language === "go" && parts.length === 1 && leaf.startsWith("method ")
    && symbols.some(symbol => symbol.kind === "type" && symbol.name === parts[0])) {
    matches = lookup(leaf, []);
  }
  return matches.length === 1 ? matches : [];
}

/**
 * Resolve a symbol name to the source range that declares it.
 *
 * A miss lists the names the file does declare, because the usual cause is a
 * near-miss on the name and the agent should not have to read the file to find
 * the right one. An ambiguous name returns every candidate range rather than
 * choosing one.
 */
export async function symbolRanges(absolutePath: string, displayPath: string, query: string, source?: string): Promise<SourceRange[]> {
  if (!query.trim() || query.length > 256) throw new Error("symbol must be a nonblank name of at most 256 characters.");
  const text = source ?? await readFile(absolutePath, "utf8");
  const parsed = await parseSource(displayPath, text);
  if (!isParsed(parsed)) throw new Error(`Cannot resolve a symbol in ${displayPath}: ${parsed.detail}`);
  let symbols: Symbol[];
  try {
    symbols = outlineOf(parsed.tree.rootNode, parsed.rules, { includeMembers: true }).symbols;
  } finally {
    parsed.tree.delete();
  }
  const literal = findSymbol(symbols, query);
  const matches = literal.length ? literal : labelledSymbol(symbols, query, parsed.language);
  if (!matches.length) {
    const available = declaredNames(symbols);
    if (!available.length) {
      throw new Error(`No symbol ${JSON.stringify(query)} in ${displayPath}; the file declares none.`);
    }
    // Near names first, so the one the caller meant is never cut off the end
    // of the list, and named outright when there is one.
    const near = nearNames(query, available);
    const ordered = [...near, ...available.filter(name => !near.includes(name))];
    const listed = ordered.slice(0, MAX_LISTED).join(", ");
    throw new Error(`No symbol ${JSON.stringify(query)} in ${displayPath}.`
      + (near.length ? ` Did you mean ${near.slice(0, 3).join(", ")}?` : "")
      + ` Declared: ${listed}${ordered.length > MAX_LISTED ? `, and ${ordered.length - MAX_LISTED} more` : ""}.`);
  }
  // Several declarations can share a name through overloads or separate scopes.
  return matches.slice(0, 16).map(symbol => ({ start: symbol.startLine, end: symbol.endLine }));
}
