import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Language, Parser, Tree } from "web-tree-sitter";
import { languageFor, type LanguageRules } from "./languages.ts";

/** Parsing is bounded: a very large file is cheaper to search than to parse. */
export const MAX_PARSE_BYTES = 2 * 1024 * 1024;

type Runtime = { Parser: typeof Parser; Language: typeof Language };

let runtime: Promise<Runtime | undefined> | undefined;
const grammars = new Map<string, Promise<Language | undefined>>();
const parsers = new Map<string, Parser>();

/**
 * The syntax layer is optional. A missing or broken grammar bundle degrades to
 * no outline instead of failing the session, so callers treat undefined as
 * "unavailable" rather than as an error.
 */
function loadRuntime(): Promise<Runtime | undefined> {
  runtime ??= (async () => {
    try {
      const module = await import("web-tree-sitter");
      await module.Parser.init();
      return { Parser: module.Parser, Language: module.Language };
    } catch {
      return undefined;
    }
  })();
  return runtime;
}

function grammarDirectory(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return join(dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")), "wasm");
  } catch {
    return undefined;
  }
}

function loadGrammar(rules: LanguageRules): Promise<Language | undefined> {
  let pending = grammars.get(rules.grammar);
  if (pending) return pending;
  pending = (async () => {
    const [loaded, directory] = [await loadRuntime(), grammarDirectory()];
    if (!loaded || !directory) return undefined;
    try {
      return await loaded.Language.load(join(directory, `tree-sitter-${rules.grammar}.wasm`));
    } catch {
      return undefined;
    }
  })();
  grammars.set(rules.grammar, pending);
  return pending;
}

interface Parsed {
  tree: Tree;
  rules: LanguageRules;
  language: string;
}

/** Reasons a file has no syntax tree. Each one is reported in one short line. */
type ParseFailure =
  | { reason: "unsupported"; detail: string }
  | { reason: "too_large"; detail: string }
  | { reason: "unavailable"; detail: string };

/**
 * Parse one source file. Trees are not cached: a parse costs milliseconds and a
 * cached tree would go stale after an edit.
 */
export async function parseSource(path: string, text: string): Promise<Parsed | ParseFailure> {
  const language = languageFor(path);
  if (!language) return { reason: "unsupported", detail: `No grammar for ${path.slice(path.lastIndexOf(".")) || path}.` };
  if (Buffer.byteLength(text) > MAX_PARSE_BYTES) {
    return { reason: "too_large", detail: `File exceeds the ${MAX_PARSE_BYTES / 1024 / 1024} MiB parse limit.` };
  }
  const [loaded, grammar] = [await loadRuntime(), await loadGrammar(language.rules)];
  if (!loaded || !grammar) return { reason: "unavailable", detail: "The syntax grammar bundle is unavailable." };
  let parser = parsers.get(language.rules.grammar);
  if (!parser) {
    parser = new loaded.Parser();
    parser.setLanguage(grammar);
    parsers.set(language.rules.grammar, parser);
  }
  // A WASM trap can leave this parser unusable. Retry once with a fresh parser;
  // a clean parse has no extra work.
  let tree;
  try {
    tree = parser.parse(text);
  } catch (error) {
    parsers.delete(language.rules.grammar);
    try { parser.delete(); } catch { /* The trapped parser may no longer be safe to release. */ }
    const message = error instanceof Error ? error.message : String(error);
    if (!/out of bounds memory access|memory access out of bounds/iu.test(message)) {
      return { reason: "unavailable", detail: `The parser failed: ${message}` };
    }
    try {
      parser = new loaded.Parser();
      parser.setLanguage(grammar);
      tree = parser.parse(text);
      parsers.set(language.rules.grammar, parser);
    } catch (retryError) {
      try { parser.delete(); } catch { /* A trapped parser may not be releasable. */ }
      return { reason: "unavailable", detail: `The parser failed: ${retryError instanceof Error ? retryError.message : String(retryError)}` };
    }
  }
  if (!tree) return { reason: "unavailable", detail: "The parser returned no tree." };
  return { tree, rules: language.rules, language: language.id };
}

export function isParsed(value: Parsed | ParseFailure): value is Parsed {
  return "tree" in value;
}

/** Release parsers and grammars. Session shutdown and reload call this. */
export function disposeSyntax(): void {
  for (const parser of parsers.values()) parser.delete();
  parsers.clear();
  grammars.clear();
  runtime = undefined;
}
