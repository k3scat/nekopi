import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fileUri, LspBusyError, LspUnavailableError } from "./lsp/client.ts";
import { LspSession, type Held, type SessionOptions } from "./lsp/session.ts";
import { overrideLanguageFor, RECIPES } from "./lsp/servers.ts";
import { languageFor } from "./syntax/languages.ts";
import { isParsed, parseSource } from "./syntax/parser.ts";
import { findSymbol, occurrenceOf, outlineOf } from "./syntax/symbols.ts";
import { NoWorkspaceCompilerError } from "./typescript/project.ts";
import { inside, resolveInside } from "./workspace-path.ts";
import type { DiagnoseFile } from "./edit/diagnostics.ts";
import { FALLBACK_ACTIONS, FALLBACK_LANGUAGES, PROJECT_WIDE_ACTIONS, hasProjectConfig,
  TsserverFallback } from "./lsp/tsserver-fallback.ts";

const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_RESULTS = 100;
/**
 * How long an empty first result is retried before it is believed.
 *
 * Servers differ in what they do while loading: gopls holds a query until its
 * view is ready, while rust-analyzer answers at once with nothing, or with
 * `ContentModified`, until its first index pass finishes. Measured on ripgrep
 * that pass took between two and four seconds, where the earlier budget of six
 * tries at 150 ms gave up after one and reported no references.
 *
 * So the wait is short unless the server says it is working: the floor covers
 * the moment before its first progress notification arrives, and the budget
 * applies while progress is in flight or it answers `ContentModified`. A
 * genuinely empty result from a quiet server therefore costs the floor, not the
 * budget, and only the first answer of a session waits at all.
 */
const WARMUP_FLOOR_MS = 1_500, WARMUP_BUDGET_MS = 15_000, WARMUP_DELAY_MS = 250;

/**
 * The questions the layer answers.
 *
 * None of them is a tool the model selects. Over two batches and 450 runs the
 * model chose `lsp` 0.01 to 0.03 times per run while its definition cost about
 * 324 tokens on every request, which over about 15 requests is 4,795 tokens per
 * run, or 0.37 of a turn at the measured 12,800 tokens a turn costs. A tool has
 * to save a turn every 2.7 runs to pay for itself at that price; this one saved
 * none. So the layer stays and the tool is gone: `edit` and `write` report the
 * diagnostics they introduce, and `/nekopi lsp` reports what a workspace has.
 */
const ACTIONS = ["definition", "implementation", "type_definition", "references"] as const;

/** Diagnostics are reached by the edit tools, not named by the model. */
type Action = (typeof ACTIONS)[number] | "diagnostics";

/** One semantic question about one file. */
export interface Query {
  action: Action;
  /** Workspace-relative source file. Picks the language and the project root. */
  file: string;
  /** Declaration name in this file, optionally `Owner/member`, instead of line and column. */
  symbol?: string;
  /** One-based source line. */
  line?: number;
  /** One-based UTF-16 column. */
  column?: number;
}

/** What a query returns: rendered text for a reader, and the counts for a caller. */
export interface LspAnswer {
  content: Array<{ type: "text"; text: string }>;
  details: LspDetails;
}

/** The semantic layer, reached by the tools and the scripts rather than by the model. */
export interface SemanticLayer {
  query(input: Query, signal?: AbortSignal, cwd?: string): Promise<LspAnswer>;
  diagnose: DiagnoseFile;
  session: LspSession;
  dispose(): Promise<void>;
}

export interface LspDetails {
  action: string;
  language: string;
  server?: string;
  root?: string;
  results: number;
  changedFiles?: string[];
  unavailable?: string;
}

interface Location { path: string; line: number; column: number; endLine: number; endColumn: number }

const METHODS: Record<string, string> = {
  definition: "textDocument/definition",
  implementation: "textDocument/implementation",
  type_definition: "textDocument/typeDefinition",
  references: "textDocument/references",
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positionOf(value: unknown): { line: number; character: number } | undefined {
  const point = object(value);
  if (!point || typeof point.line !== "number" || typeof point.character !== "number") return undefined;
  return { line: point.line, character: point.character };
}

/** Accept Location, LocationLink and DocumentSymbol shapes alike. */
function locationsOf(value: unknown, root: string): Location[] {
  const list = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  const locations: Location[] = [];
  for (const item of list) {
    const entry = object(item);
    if (!entry) continue;
    const uri = typeof entry.uri === "string" ? entry.uri
      : typeof entry.targetUri === "string" ? entry.targetUri
      : typeof object(entry.location)?.uri === "string" ? object(entry.location)!.uri as string : undefined;
    const range = object(entry.range) ?? object(entry.targetSelectionRange) ?? object(entry.targetRange)
      ?? object(object(entry.location)?.range);
    if (!uri || !range) continue;
    const start = positionOf(range.start), end = positionOf(range.end);
    if (!start || !end) continue;
    let path: string;
    try { path = fileURLToPath(uri); } catch { continue; }
    if (!inside(root, path)) continue;
    locations.push({ path: relative(root, path), line: start.line + 1, column: start.character + 1,
      endLine: end.line + 1, endColumn: end.character + 1 });
  }
  return locations;
}

/** Render a location with the source line it points at. */
async function renderLocations(root: string, locations: readonly Location[]): Promise<string[]> {
  const sources = new Map<string, string[]>();
  const lines: string[] = [];
  for (const location of locations) {
    let source = sources.get(location.path);
    if (!source) {
      try { source = (await readFile(resolve(root, location.path), "utf8")).split("\n"); }
      catch { source = []; }
      sources.set(location.path, source);
    }
    const text = source[location.line - 1]?.trim() ?? "";
    lines.push(`${location.path}:${location.line}:${location.column}${text ? `  ${text.slice(0, 200)}` : ""}`);
  }
  return lines;
}

const SEVERITY = ["", "error", "warning", "information", "hint"];

function renderDiagnostics(list: readonly unknown[], file: string): string[] {
  const lines: string[] = [];
  for (const item of list) {
    const entry = object(item);
    const start = positionOf(object(entry?.range)?.start);
    if (!entry || !start) continue;
    const severity = typeof entry.severity === "number" ? SEVERITY[entry.severity] ?? "" : "";
    const code = entry.code === undefined || entry.code === null ? "" : ` ${entry.code}`;
    const message = typeof entry.message === "string" ? entry.message.replace(/\s+/gu, " ").slice(0, 400) : "";
    lines.push(`${file}:${start.line + 1}:${start.character + 1}  ${severity}${code}: ${message}`);
  }
  return lines;
}

/** Resolve a declaration name to a position using the syntax layer. */
async function symbolPosition(absolute: string, display: string, name: string) {
  const text = await readFile(absolute, "utf8");
  const parsed = await parseSource(display, text);
  if (!isParsed(parsed)) throw new Error(`Cannot resolve a symbol in ${display}: ${parsed.detail}`);
  try {
    const matches = findSymbol(outlineOf(parsed.tree.rootNode, parsed.rules, { includeMembers: true }).symbols, name);
    const first = matches[0];
    if (first) return { line: first.nameLine, column: first.nameColumn, ambiguous: matches.length > 1 };
    // The file may only use the name, not declare it. That is the ordinary
    // editor gesture and a server resolves it from any occurrence.
    const use = occurrenceOf(parsed.tree.rootNode, name.split(/[/.]/u).filter(Boolean).at(-1) ?? name);
    if (!use) throw new Error(`No symbol ${JSON.stringify(name)} in ${display}. Read it to list what it declares.`);
    return { line: use.line, column: use.column, ambiguous: false };
  } finally {
    parsed.tree.delete();
  }
}

export function createSemanticLayer(cwd: string, options: SessionOptions = {}): SemanticLayer {
  const session = new LspSession(options);
  // One TypeScript server for the session, created only if a fallback is needed.
  const fallbacks = new Map<string, TsserverFallback>();
  const fallbackFor = (root: string) => {
    let held = fallbacks.get(root);
    if (!held) { held = new TsserverFallback(root); fallbacks.set(root, held); }
    return held;
  };
  const query = async (input: Query, signal?: AbortSignal, root = cwd): Promise<LspAnswer> => {
      const file = await resolveInside(root, input.file);
      if (!file) throw new Error("A semantic query needs a workspace-relative file inside the workspace.");
      const { root: base, absolute, display } = file;
      // The syntax layer maps the languages it has a grammar for; an override
      // can claim an extension beyond that set.
      const overrides = options.servers ?? {};
      const mapped = languageFor(display)?.id ?? overrideLanguageFor(display, overrides);
      if (!mapped) {
        return unavailable(input.action, `No language is mapped to ${display}.`);
      }
      const language = { id: mapped };
      if (!RECIPES[language.id] && !overrides[language.id]) {
        return unavailable(input.action, `No language server is configured for ${language.id}.`, language.id);
      }

      const needsPosition = input.action !== "diagnostics";
      let position: { line: number; character: number } | undefined;
      let ambiguous = false;
      if (needsPosition) {
        if (input.symbol !== undefined) {
          if (input.line !== undefined || input.column !== undefined) {
            throw new Error("Use symbol, or line and column, not both.");
          }
          const found = await symbolPosition(absolute, display, input.symbol);
          position = { line: found.line - 1, character: found.column - 1 };
          ambiguous = found.ambiguous;
        } else {
          if (input.line === undefined || input.column === undefined) {
            throw new Error(`${input.action} needs symbol, or line and column.`);
          }
          position = { line: input.line - 1, character: input.column - 1 };
        }
      }

      let held: Held | undefined;
      try {
        const outcome = await session.run(language.id, base, display, signal, async (entry) => {
          held = entry;
          await entry.client.sync(absolute, language.id);
          const uri = fileUri(absolute);
          const document = { textDocument: { uri } };
          /**
           * Retry an empty location result while the server is still cold.
           * Without this, a query issued during project load reports "no
           * results", which the agent would read as "none exist".
           */
          const locationQuery = async (method: string, params: unknown) => {
            const started = Date.now();
            for (;;) {
              let found: Location[] = [], busy: LspBusyError | undefined;
              try {
                found = locationsOf(await entry.client.call(method, params, signal), base);
              } catch (error) {
                if (!(error instanceof LspBusyError)) throw error;
                busy = error;
              }
              if (found.length) { entry.client.markWarm(); return { kind: "locations" as const, locations: found }; }
              const cold = !entry.client.warm;
              const loading = busy !== undefined || entry.client.busy;
              const wait = loading ? WARMUP_BUDGET_MS : WARMUP_FLOOR_MS;
              if ((!cold && !loading) || Date.now() - started >= wait) {
                // A server that only ever said its state was changing has not
                // told us there are no results. Saying there are none would be
                // the one answer the agent must not be given.
                if (busy) throw busy;
                return { kind: "locations" as const, locations: found, cold };
              }
              await new Promise(resolve => setTimeout(resolve, WARMUP_DELAY_MS));
            }
          };
          if (input.action === "diagnostics") return diagnosticsResult(entry, absolute, display, signal);
          if (input.action === "references") {
            return locationQuery(METHODS.references!, { ...document, position, context: { includeDeclaration: true } });
          }
          return locationQuery(METHODS[input.action]!, { ...document, position });
        });
        if (!outcome) {
          // TypeScript still has an answer without an installed server.
          const fallback = await tryFallback(fallbackFor(base), input, display, language.id, position, base, signal);
          if (fallback) return render(input, fallback, base, language.id, undefined, ambiguous, "project tsserver");
          return unavailable(input.action,
            `No language server for ${language.id}, and no workspace compiler to fall back on. Use read and grep.`,
            language.id);
        }
        return render(input, outcome, base, language.id, held, ambiguous);
      } catch (error) {
        if (error instanceof LspUnavailableError) {
          return unavailable(input.action, `The ${language.id} server is unavailable: ${error.message}`, language.id);
        }
        throw error;
      }
  };
  return {
    query,
    session,
    async dispose() {
      const held = [...fallbacks.values()];
      fallbacks.clear();
      await Promise.all([session.dispose(), ...held.map(item => item.dispose())]);
    },
    /** Diagnostics for one file, for the mutation tools to reuse the warm session. */
    async diagnose(file: string, signal?: AbortSignal) {
      const result = await query({ action: "diagnostics", file }, signal);
      if (result.details.unavailable) return undefined;
      const block = result.content.find(item => item.type === "text");
      return block?.type === "text" ? block.text : undefined;
    },
  };
}

/** Route the overlapping actions to the project compiler when no server is installed. */
async function tryFallback(fallback: TsserverFallback, input: Query, file: string, language: string,
  position: { line: number; character: number } | undefined, root: string,
  signal?: AbortSignal): Promise<Outcome | undefined> {
  if (!FALLBACK_LANGUAGES.has(language) || !FALLBACK_ACTIONS.has(input.action)) return undefined;
  try {
    const outcome = await fallback.run({ file, action: input.action,
      ...(position ? { line: position.line + 1, column: position.character + 1 } : {}), ...(signal ? { signal } : {}) });
    if (outcome.diagnostics) return { kind: "diagnostics", items: outcome.diagnostics, file };
    // An inferred project holds only this file, so a project-wide search here
    // reports about one file and would otherwise read as the whole answer.
    const oneFileOnly = PROJECT_WIDE_ACTIONS.has(input.action) && !hasProjectConfig(root, file);
    return { kind: "locations", locations: outcome.locations ?? [], oneFileOnly };
  } catch (error) {
    // A project with no TypeScript installation is the expected miss, and the
    // caller turns it into advice to use read and grep. Anything else is this
    // layer being broken, and reporting it as a missing installation is how a
    // crash on every project pinning TypeScript below 5.9 stayed invisible
    // across a 138 run batch.
    if (error instanceof NoWorkspaceCompilerError) return undefined;
    if (error instanceof Error && error.message.startsWith("No workspace TypeScript installation")) return undefined;
    throw new LspUnavailableError(error instanceof Error ? error.message : String(error));
  }
}

async function diagnosticsResult(entry: Held, absolute: string, display: string, signal?: AbortSignal) {
  // Prefer the pull model; fall back to what the server pushed on open.
  if (entry.client.serverCapabilities.diagnosticProvider) {
    const raw = await entry.client.call<Record<string, unknown>>("textDocument/diagnostic",
      { textDocument: { uri: fileUri(absolute) } }, signal);
    const items = object(raw)?.items;
    if (Array.isArray(items)) return { kind: "diagnostics" as const, items, file: display };
  }
  // A push server needs a moment after didOpen before its first publish arrives.
  for (let attempt = 0; attempt < 20; attempt++) {
    const pushed = entry.client.pushedDiagnostics(absolute);
    if (pushed) return { kind: "diagnostics" as const, items: pushed, file: display };
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return { kind: "diagnostics" as const, items: [], file: display, unconfirmed: true };
}

type Outcome =
  | { kind: "locations"; locations: Location[]; cold?: boolean; oneFileOnly?: boolean }
  | { kind: "diagnostics"; items: unknown[]; file: string; unconfirmed?: boolean };

function unavailable(action: string, reason: string, language = "unknown") {
  return {
    content: [{ type: "text" as const, text: reason }],
    details: { action, language, results: 0, unavailable: reason } satisfies LspDetails,
  };
}

async function render(input: Query, outcome: Outcome, root: string,
  language: string, held: Held | undefined, ambiguous: boolean, backend?: string) {
  const details: LspDetails = { action: input.action, language, results: 0,
    ...(held ? { server: held.server.command, root: relative(root, held.root) || "." }
      : backend ? { server: backend } : {}) };
  const lines: string[] = [];
  const notices: string[] = [];
  if (ambiguous) notices.push(`Several declarations are named ${JSON.stringify(input.symbol)}; the first was used.`);
  if (outcome.kind === "locations" && outcome.oneFileOnly) {
    notices.push("This workspace has no tsconfig.json, so the compiler sees only this file "
      + "and this result covers nothing outside it. Use grep to search the rest.");
  }

  if (outcome.kind === "diagnostics") {
    const rendered = renderDiagnostics(outcome.items, outcome.file);
    details.results = rendered.length;
    if (rendered.length) lines.push(...rendered.slice(0, MAX_RESULTS));
    else lines.push(outcome.unconfirmed
      ? "No diagnostics were reported; the server published none for this file."
      : "No diagnostics.");
    if (rendered.length > MAX_RESULTS) notices.push(`Incomplete: ${rendered.length - MAX_RESULTS} more diagnostics.`);
  } else {
    const kept = outcome.locations.slice(0, MAX_RESULTS);
    details.results = kept.length;
    lines.push(...await renderLocations(root, kept));
    if (!kept.length) {
      lines.push(outcome.cold
        ? `No ${String(input.action).replace("_", " ")} results yet; the server is still loading the project. Retry, or use read and grep.`
        : `No ${String(input.action).replace("_", " ")} results in this project.`);
    }
    if (outcome.locations.length > kept.length) {
      notices.push(`Incomplete: ${outcome.locations.length - kept.length} more results.`);
    }
  }

  let text = [...lines, ...notices].join("\n");
  if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) {
    const budget: string[] = [];
    let bytes = 0;
    for (const line of lines) {
      const size = Buffer.byteLength(line) + 1;
      if (bytes + size > MAX_OUTPUT_BYTES - 256) break;
      budget.push(line); bytes += size;
    }
    text = [...budget, `Incomplete: ${lines.length - budget.length} lines omitted by the output limit.`, ...notices].join("\n");
  }
  return { content: [{ type: "text" as const, text }], details };
}
