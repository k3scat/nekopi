import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type ts from "typescript";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { ProjectRefreshLimitError, TsserverOwner } from "./typescript/session.ts";
import { checkProjectPlugins, resolveCompiler } from "./typescript/project.ts";
import { inside } from "./workspace-path.ts";
import { offset, source, type Point, type SourceText } from "./typescript/source.ts";

const parameters = Type.Object({
  // The four the fallback routes. `symbols` and the call hierarchy pair were
  // here while `code_intel` was a tool of its own; `tryFallback` gates on
  // `FALLBACK_ACTIONS`, so nothing could pass them in once that went.
  action: Type.Union([Type.Literal("definition"), Type.Literal("implementation"), Type.Literal("references"), Type.Literal("diagnostics")]),
  file: Type.String({ minLength: 1, description: "A workspace-relative source file." }),
  line: Type.Optional(Type.Integer({ minimum: 1, description: "One-based source line." })),
  column: Type.Optional(Type.Integer({ minimum: 1, description: "One-based UTF-16 column." })),
}, { additionalProperties: false });
type Query = Static<typeof parameters>;
type RecordValue = Record<string, unknown>;
export interface TsserverOptions {
  /** Experiments can opt into the pinned development compiler. Products use the project. */
  allowHarnessFallback?: boolean;
  /** Retain a server until dispose. Standalone experiments remain ephemeral by default. */
  persistent?: boolean;
  serverPath?: string;
  nodeExecutable?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxResults?: number;
  /** Evaluation lifecycle observer. It receives no source or credentials. */
  onSpawn?: (pid: number) => void;
}
const object = (value: unknown): RecordValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid tsserver response object.");
  return value as RecordValue;
};
const positive = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
/** Report a counter only when it has something to report. */
const nonzero = (counters: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(counters).filter(([, count]) => count !== 0));
function point(value: unknown): Point {
  const item = object(value);
  if (!positive(item.line) || !positive(item.offset)) throw new Error("Invalid tsserver UTF-16 position.");
  return { line: item.line as number, offset: item.offset as number };
}

/**
 * Whether this project's compiler can hold client-owned watches.
 *
 * Every link is optional because the shape of this namespace changed inside
 * the supported range. TypeScript below 5.9 exposes the tsserver protocol
 * enums only from `tsserverlibrary.js`, so `server` is present on the compiler
 * and `protocol` is not. Guarding only `server` threw, the semantic layer
 * reported "no workspace compiler to fall back on" instead, and every query in
 * a project pinning 5.2 failed that way. vuejs/core pins 5.2, which is half the
 * benchmark, so the layer was unreachable there across a 138 run batch and
 * nothing in the results said so.
 */
export function supportsWatchChange(compiler: Pick<typeof ts, "server">): boolean {
  return compiler.server?.protocol?.CommandTypes?.WatchChange !== undefined;
}

/** Read-only official tsserver requests, ephemeral unless the caller owns disposal. */
export function createTsserverTool(cwd: string, options: TsserverOptions = {}): ToolDefinition<typeof parameters> & { dispose(): Promise<void> } {
  const timeoutMs = options.timeoutMs ?? 30_000, maxOutputBytes = options.maxOutputBytes ?? 16_384, maxResults = options.maxResults ?? 100;
  if (!positive(timeoutMs) || !positive(maxResults) || !positive(maxOutputBytes) || maxOutputBytes < 1_024) throw new Error("Invalid tsserver limits.");
  const owner = new TsserverOwner();
  async function query(input: Query, callSignal: AbortSignal, retain: boolean) {
    const controller = { signal: callSignal };
    let persistent = false;
    try {
      const root = await realpath(cwd), requested = resolve(root, input.file);
      if (isAbsolute(input.file) || !inside(root, requested)) throw new Error("code_intel requires a workspace-relative file inside the workspace.");
      const target = await realpath(requested);
      if (!inside(root, target) || !/\.[cm]?[jt]sx?$/.test(target)) throw new Error("code_intel requires a source file inside the workspace; symlink escapes are rejected.");
      const initial = await source(target);
      if (input.action !== "diagnostics") {
        if (!positive(input.line) || !positive(input.column)) throw new Error("Symbol queries require one-based line and UTF-16 column.");
        offset(initial, { line: input.line!, offset: input.column! });
      }
      const { serverPath, version, compiler } = await resolveCompiler(root, target, options, import.meta.url);
      // Client-owned watches prevent background configuration/plugin changes between preflights.
      // Older project compilers keep the existing ephemeral behavior.
      //
      // Every link is optional because the shape of this namespace changed
      // inside the supported range. TypeScript below 5.9 exposes the tsserver
      // protocol enums only from `tsserverlibrary.js`, so `server` is present
      // on the compiler and `protocol` is not. Guarding only `server` threw
      // here, `tryFallback` swallowed it, and every semantic query in a project
      // pinning 5.2 answered "no workspace compiler to fall back on". vuejs/core
      // pins 5.2, which is half the benchmark, so the whole semantic layer was
      // unreachable there and the measurements never showed it.
      persistent = retain && options.persistent === true && supportsWatchChange(compiler);
      const snapshot = await checkProjectPlugins(root, target, compiler, controller.signal, persistent);
      controller.signal.throwIfAborted();
      const server = await owner.get(root, serverPath, options.nodeExecutable ?? "node", snapshot.project, persistent, controller.signal, options.onSpawn);
      const request = (command: string, args: RecordValue) => {
        controller.signal.throwIfAborted(); return server.request(command, args);
      };
      await server.refresh(root, target, initial.text, snapshot, controller.signal);
      const project = object(await request("projectInfo", { file: target, needFileNameList: persistent }));
      if (project.languageServiceDisabled === true || typeof project.configFileName !== "string") throw new Error("TypeScript project is unresolved or language service disabled.");
      const configured = /\.json$/i.test(project.configFileName);
      let config: string | null = null;
      let configDiagnostics: unknown[] = [];
      if (configured) {
        const configPath = await realpath(project.configFileName);
        if (!inside(root, configPath)) throw new Error("Configured TypeScript project is outside workspace.");
        config = relative(root, configPath);
        const diagnostics = await request("compilerOptionsDiagnostics-full", { projectFileName: project.configFileName });
        if (!Array.isArray(diagnostics)) throw new Error("Invalid project configuration diagnostics.");
        configDiagnostics = [...diagnostics, ...server.diagnostics()];
      } else if (input.action === "diagnostics") throw new Error("Diagnostics require a resolved configured project; inferred project scope cannot establish a clean target.");
      const warnings = [...new Map(configDiagnostics.map(value => {
        const diagnostic = object(value);
        if (!Number.isSafeInteger(diagnostic.code)) throw new Error("Invalid project configuration diagnostic.");
        const message = typeof diagnostic.message === "string" ? diagnostic.message : typeof diagnostic.text === "string" ? diagnostic.text
          : compiler.flattenDiagnosticMessageText(diagnostic.message as ts.DiagnosticMessageChain, " ");
        if (typeof message !== "string") throw new Error("Invalid project configuration diagnostic message.");
        return [String(diagnostic.code) + message, { code: diagnostic.code, message: message.slice(0, 300) }];
      })).values()];
      // Keep only project facts the model can act on. Version and coverage prose stay in details.
      const scope = { ...(configured ? { config } : { inferred: true }),
        ...(warnings.length ? { warnings: warnings.slice(0, 3), warningCount: warnings.length, omittedWarnings: Math.max(0, warnings.length - 3) } : {}) };

      const queryArgs = { file: target, ...(input.action === "diagnostics" ? { includeLinePosition: true } : { line: input.line, offset: input.column }) };
      const cache = new Map<string, SourceText>();
      async function cachedSource(path: string) {
        let file = cache.get(path);
        if (!file) { file = await source(path); cache.set(path, file); }
        return file;
      }
      async function verifySources() {
        for (const [path, file] of cache) if ((await source(path)).sha256 !== file.sha256) throw new Error("Result source changed during verification; retry on current disk state.");
        if ((await source(target)).sha256 !== initial.sha256) throw new Error("Target source changed during the query; retry on current disk state.");
      }
      async function finish(text: string) {
        controller.signal.throwIfAborted();
        server.assertHealthy();
        if (persistent) await server.remember(snapshot, project.fileNames, controller.signal);
        return { content: [{ type: "text" as const, text }], details: { backend: "tsserver", version } };
      }
      let raw: unknown[];
      if (input.action === "diagnostics") {
        const syntax = await request("syntacticDiagnosticsSync", queryArgs), semantic = await request("semanticDiagnosticsSync", queryArgs);
        if (!Array.isArray(syntax) || !Array.isArray(semantic)) throw new Error("Invalid tsserver diagnostics response.");
        raw = [...syntax.map(value => ({ ...object(value), diagnosticKind: "syntax" })), ...semantic.map(value => ({ ...object(value), diagnosticKind: "semantic" }))];
      } else {
        const response = await request(input.action, queryArgs);
        if (input.action === "definition" || input.action === "implementation") {
          if (!Array.isArray(response)) throw new Error(`Invalid tsserver ${input.action} response.`);
          raw = response;
        } else {
          const refs = object(response).refs;
          if (!Array.isArray(refs)) throw new Error("Invalid tsserver references response.");
          raw = refs;
        }
      }
      const results: RecordValue[] = [];
      let inspectedResults = 0;
      let excludedOutsideWorkspace = 0, excludedLibraries = 0, omittedExcerptLines = 0, truncatedMessages = 0, unverifiedResults = 0;
      for (const value of raw) {
        controller.signal.throwIfAborted();
        // Bound source reads and AST work before materializing references.
        // Excluded libraries do not consume useful workspace result slots.
        if (input.action !== "diagnostics" && results.length >= maxResults) break;
        inspectedResults++;
        const entry = object(value), diagnostic = input.action === "diagnostics";
        if (entry.unverified !== undefined && typeof entry.unverified !== "boolean") throw new Error("Invalid tsserver semantic uncertainty flag.");
        const serverFile = diagnostic ? target : entry.file;
        if (typeof serverFile !== "string") throw new Error("Invalid tsserver result file.");
        const actual = await realpath(serverFile);
        unverifiedResults += Number(entry.unverified === true);
        if (actual.startsWith(dirname(serverPath) + sep + "lib.")) { excludedLibraries++; continue; }
        if (!inside(root, actual)) { excludedOutsideWorkspace++; continue; }
        if (relative(root, actual).split(sep).includes("node_modules")) { excludedLibraries++; continue; }
        const start = point(diagnostic ? entry.startLocation : entry.start), end = point(diagnostic ? entry.endLocation : entry.end);
        const file = await cachedSource(actual);
        const first = offset(file, start), last = offset(file, end);
        if (last < first) throw new Error("Invalid reversed tsserver span.");
        if (diagnostic && (entry.start !== first || entry.length !== last - first)) throw new Error("Diagnostic position disagrees with current source.");
        if (!diagnostic && typeof entry.lineText === "string" && entry.lineText.replace(/[\u2028\u2029]$/, "") !== file.lines[start.line - 1]!) throw new Error("Reference excerpt disagrees with current source.");
        const item: RecordValue = { file: relative(root, actual), start: { line: start.line, column: start.offset }, end: { line: end.line, column: end.offset } };
        {
          const excerptEnd = Math.min(end.line, start.line + 3), excerpts = file.lines.slice(start.line - 1, excerptEnd).map((text, index) => ({ line: start.line + index, text }));
          omittedExcerptLines += end.line - excerptEnd;
          Object.assign(item, { spanText: file.text.slice(first, last), excerpts,
            ...(end.line > excerptEnd ? { omittedExcerptLines: end.line - excerptEnd } : {}) });
        }
        if (diagnostic) {
          if (typeof entry.message !== "string" || !Number.isSafeInteger(entry.code) || !["error", "warning", "suggestion", "message"].includes(String(entry.category))) throw new Error("Invalid diagnostic metadata.");
          const message = entry.message; truncatedMessages += Number(message.length > 2_000);
          Object.assign(item, { kind: entry.diagnosticKind, code: entry.code, severity: entry.category, message: message.slice(0, 2_000),
            ...(message.length > 2_000 ? { messageTruncated: true } : {}) });
        } else {
          if (entry.unverified === true) item.unverified = true;
          if (entry.isDefinition === true) item.isDefinition = true;
          if (entry.isWriteAccess === true) item.isWriteAccess = true;
        }
        results.push(item);
      }
      await verifySources();
      const totalInside = results.length;
      const uninspectedResults = raw.length - inspectedResults;
      const diagnosticTarget = input.action === "diagnostics"
        ? { file: relative(root, target), sha256: initial.sha256 } : undefined;
      results.splice(maxResults);
      const output = () => JSON.stringify({ backend: "tsserver", action: input.action, project: scope,
          ...(diagnosticTarget ? { target: diagnosticTarget } : {}),
          results, ...nonzero({ omitted: totalInside - results.length, uninspectedResults, excludedOutsideWorkspace,
            excludedLibraries, omittedExcerptLines, truncatedMessages, unverifiedResults }),
          ...(uninspectedResults === 0 && totalInside === results.length && excludedOutsideWorkspace === 0
            && excludedLibraries === 0 && omittedExcerptLines === 0 && truncatedMessages === 0 && unverifiedResults === 0
            ? {} : { incomplete: true }) });
      while (results.length && Buffer.byteLength(output()) > maxOutputBytes) results.pop();
      const text = output();
      if (Buffer.byteLength(text) > maxOutputBytes) throw new Error("Project metadata exceeds output limit.");
      // Observe validation failures before asynchronous cleanup delays promise adoption.
      return await finish(text);
    } finally {
      if (!persistent) await owner.reset();
    }
  }
  return {
    dispose: () => owner.dispose(),
    name: "code_intel", label: "Code intelligence", parameters, executionMode: "sequential",
    description: "TypeScript and JavaScript symbol queries through the workspace tsserver: definitions, implementations, references and file diagnostics. Positions are one-based UTF-16 columns, after any leading BOM. Results are candidates in the loaded project, not an exhaustive repository search. Read-only.",
    promptSnippet: "Use code_intel for TypeScript symbol identity instead of inferring it from text matches.",
    execute(_id, input: Query, signal) {
      return owner.run(signal, timeoutMs, async (callSignal) => {
        try { return await query(input, callSignal, true); }
        catch (error) {
          if (!(error instanceof ProjectRefreshLimitError)) throw error;
          // Large refresh inventories use the original one-call server under the same deadline.
          await owner.reset();
          return query(input, callSignal, false);
        }
      });
    },
  };
}
