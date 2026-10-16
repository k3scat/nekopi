import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createTsserverTool } from "../typescript.ts";

/**
 * TypeScript answers without an installed language server.
 *
 * `typescript-language-server` is a separate install, but a TypeScript project
 * already carries a compiler, and this repository already speaks the TypeScript
 * server protocol. Routing the overlapping actions here keeps `lsp` useful out
 * of the box for the language most Pi users work in.
 *
 * Only the actions whose semantics match are routed. Anything else reports that
 * the real server is missing, rather than guessing.
 */
export const FALLBACK_ACTIONS = new Set(["definition", "implementation", "references", "diagnostics"]);
export const FALLBACK_LANGUAGES = new Set(["typescript", "tsx", "javascript"]);

/**
 * Actions that search the whole project rather than following one edge.
 *
 * Without a tsconfig the server builds an inferred project holding only the
 * file it was handed, so these answer about that file alone and say nothing
 * about the rest of the workspace. `definition` still resolves, because it
 * follows an import the open file states itself.
 */
export const PROJECT_WIDE_ACTIONS = new Set(["references"]);

/**
 * Whether a TypeScript project file covers this source file.
 *
 * A project-wide answer from an inferred project is not wrong so much as
 * narrow, and a narrow answer to "find every use" is the dangerous kind. The
 * caller reports the limit rather than presenting one reference as all of them.
 */
export function hasProjectConfig(root: string, file: string): boolean {
  let directory = dirname(resolve(root, file));
  const stop = resolve(root);
  for (;;) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      if (existsSync(join(directory, name))) return true;
    }
    if (directory === stop) return false;
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

interface FallbackLocation {
  path: string; line: number; column: number; endLine: number; endColumn: number;
}

interface TsserverResult {
  results?: Array<Record<string, unknown>>;
  target?: unknown;
}

function point(value: unknown): { line: number; column: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.line === "number" && typeof record.column === "number"
    ? { line: record.line, column: record.column } : undefined;
}

interface FallbackOutcome {
  locations?: FallbackLocation[];
  diagnostics?: unknown[];
}

/**
 * Holds one TypeScript server for the session.
 *
 * A fresh server for every call costs seconds, which is what stopped the
 * earlier compiler tool from being used at all. The server is created on the
 * first fallback query and reused until dispose.
 */
export class TsserverFallback {
  private tool?: ReturnType<typeof createTsserverTool>;

  constructor(private readonly root: string) {}

  private get client() {
    this.tool ??= createTsserverTool(this.root, { allowHarnessFallback: false, persistent: true });
    return this.tool;
  }

  /**
   * Run one query through the project's TypeScript server.
   *
   * Diagnostics are translated into the protocol's zero-based shape so the
   * renderer does not need to know which backend answered.
   */
  async run(options: {
    file: string;
    action: string;
    line?: number;
    column?: number;
    signal?: AbortSignal;
  }): Promise<FallbackOutcome> {
    const action = options.action;
    const query: Record<string, unknown> = { action, file: options.file };
    if (action !== "diagnostics") {
      query.line = options.line;
      query.column = options.column;
    }
    const result = await this.client.execute("lsp/fallback", query as never,
      options.signal ?? new AbortController().signal, undefined, { cwd: this.root } as never);
    const block = result.content.find(item => item.type === "text");
    if (block?.type !== "text") throw new Error("The TypeScript server returned no usable result.");
    const parsed = JSON.parse(block.text) as TsserverResult;
    const entries = parsed.results ?? [];
    if (action === "diagnostics") {
      return { diagnostics: entries.flatMap(entry => {
        const start = point(entry.start), end = point(entry.end);
        if (!start || !end) return [];
        return [{
          range: { start: { line: start.line - 1, character: start.column - 1 },
            end: { line: end.line - 1, character: end.column - 1 } },
          severity: entry.severity === "error" ? 1 : entry.severity === "warning" ? 2 : 3,
          code: entry.code, message: entry.message,
        }];
      }) };
    }
    return { locations: entries.flatMap(entry => {
      const start = point(entry.start), end = point(entry.end);
      if (!start || !end || typeof entry.file !== "string") return [];
      return [{ path: relative(this.root, resolve(this.root, entry.file)),
        line: start.line, column: start.column, endLine: end.line, endColumn: end.column }];
    }) };
  }


  async dispose(): Promise<void> {
    const tool = this.tool;
    this.tool = undefined;
    await tool?.dispose();
  }
}
