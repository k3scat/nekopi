import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection,
} from "vscode-jsonrpc/node";
import type { InitializeResult, ServerCapabilities } from "vscode-languageserver-protocol";

const DEFAULT_TIMEOUT_MS = 20_000;
/** A server is given longer to start, because indexing happens during initialize. */
const START_TIMEOUT_MS = 60_000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export class LspUnavailableError extends Error {}

/**
 * The server's own state changed while it was answering.
 *
 * `ContentModified` is the protocol's way of saying "ask again", and
 * rust-analyzer sends it throughout its first indexing pass. Treated as a dead
 * server it made every Rust query report an unavailable language server for the
 * first few seconds of a session, which reads in a result table exactly like a
 * language nekopi cannot navigate at all.
 */
export class LspBusyError extends LspUnavailableError {}

/** `ContentModified`, which the specification defines as retryable. */
const CONTENT_MODIFIED = -32_801;

export function fileUri(path: string): string {
  return pathToFileURL(path).toString();
}

function firstLine(text: string): string {
  const line = text.split("\n").find(candidate => candidate.trim().length) ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}\u2026` : line.trim();
}

interface OpenDocument { version: number; text: string }

/**
 * One language server process.
 *
 * The client owns the process, the document synchronization and the request
 * deadline. A crash marks the client dead rather than throwing from an unrelated
 * call, so the caller can start a replacement.
 */
export class LspClient {
  private child?: ChildProcessWithoutNullStreams;
  private connection?: MessageConnection;
  private capabilities: ServerCapabilities = {};
  private readonly documents = new Map<string, OpenDocument>();
  private failure?: string;
  /**
   * Whether this server has answered anything yet.
   *
   * A language server indexes the project after `initialized` and answers an
   * early query with an empty result rather than blocking. An empty result from
   * a cold server is therefore not evidence of absence, so the caller retries
   * briefly until the first real answer arrives.
   */
  private answered = false;
  private diagnostics = new Map<string, unknown[]>();
  /**
   * Work the server has told us it is doing.
   *
   * A server that is still loading answers a query with an empty result rather
   * than blocking, and the only honest way to tell that apart from "there are
   * no results" is to ask the server. Work-done progress is how it says so, so
   * the tokens in flight are tracked and the caller waits while any are.
   */
  private readonly working = new Set<string>();
  /** Bounded stderr tail. A failing server explains itself here, not in its protocol. */
  private stderrTail = Buffer.alloc(0);
  private exited?: Promise<string>;

  constructor(
    private readonly options: {
      command: string;
      args: readonly string[];
      root: string;
      language: string;
      initialization?: Record<string, unknown>;
      timeoutMs?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) {}

  get serverCapabilities(): ServerCapabilities { return this.capabilities; }
  get warm(): boolean { return this.answered; }
  /** Whether the server reports work in progress, such as a first index pass. */
  get busy(): boolean { return this.working.size > 0; }
  markWarm(): void { this.answered = true; }
  /** The server's own last words, for `/nekopi lsp`. Never shown to the model. */
  get stderr(): string { return this.stderrTail.toString("utf8").trim(); }
  get alive(): boolean { return Boolean(this.connection) && this.failure === undefined; }
  get deadReason(): string | undefined { return this.failure; }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.connection) return;
    const child = spawn(this.options.command, [...this.options.args], {
      cwd: this.options.root, stdio: ["pipe", "pipe", "pipe"],
      env: this.options.env ?? process.env,
    });
    this.child = child;
    // A binary can exist, be executable and still not be a language server: a
    // rustup or asdf shim for an uninstalled component prints to stderr and
    // exits. Watch for that instead of waiting out the start deadline.
    this.exited = new Promise<string>(resolveExit => {
      child.on("error", error => {
        this.failure ??= `server process error: ${error.message}`;
        resolveExit(this.failure);
      });
      child.on("exit", (code, signal) => {
        const detail = this.stderr;
        this.failure ??= `server exited ${signal ? `on ${signal}` : `with code ${code}`}${detail ? `: ${firstLine(detail)}` : ""}`;
        resolveExit(this.failure);
      });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = Buffer.concat([this.stderrTail, chunk]).subarray(-4096);
    });
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    connection.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics: unknown[] }) => {
      if (params && typeof params.uri === "string" && Array.isArray(params.diagnostics)) {
        this.diagnostics.set(params.uri, params.diagnostics);
      }
    });
    connection.onNotification("$/progress", (params: { token?: unknown; value?: { kind?: unknown } }) => {
      const token = typeof params?.token === "string" || typeof params?.token === "number"
        ? String(params.token) : undefined;
      if (!token) return;
      if (params.value?.kind === "begin") this.working.add(token);
      else if (params.value?.kind === "end") this.working.delete(token);
    });
    // A server may ask the client for configuration or registration. Answer
    // predictably instead of letting a request hang.
    connection.onRequest("workspace/configuration", (params: { items?: unknown[] }) =>
      (params?.items ?? []).map(() => ({})));
    connection.onRequest("client/registerCapability", () => null);
    connection.onRequest("client/unregisterCapability", () => null);
    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.onRequest("workspace/applyEdit", () => ({ applied: false }));
    connection.onError(([error]: [Error, unknown, unknown]) => { this.failure ??= `connection error: ${error.message}`; });
    connection.onClose(() => { this.failure ??= "server closed the connection"; });
    connection.listen();
    this.connection = connection;
    try {
      const result = await this.raceExit(this.request<InitializeResult>("initialize", {
        processId: process.pid,
        rootUri: fileUri(this.options.root),
        workspaceFolders: [{ uri: fileUri(this.options.root), name: "workspace" }],
        capabilities: clientCapabilities(),
        ...(this.options.initialization ? { initializationOptions: this.options.initialization } : {}),
      }, signal, START_TIMEOUT_MS));
      this.capabilities = result.capabilities ?? {};
      await connection.sendNotification("initialized", {});
    } catch (error) {
      // The server's own stderr diagnoses a failed start far better than the
      // protocol does, and it arrives whichever handler noticed first.
      const detail = this.stderr;
      await this.dispose();
      const reason = error instanceof Error ? error.message : String(error);
      throw new LspUnavailableError(`${this.options.language} server failed to start: ${reason}${
        detail ? ` (${firstLine(detail)})` : ""}`);
    }
  }

  /** Fail as soon as the process dies, rather than at the request deadline. */
  private async raceExit<T>(pending: Promise<T>): Promise<T> {
    if (!this.exited) return pending;
    return Promise.race([pending, this.exited.then((reason): never => { throw new LspUnavailableError(reason); })]);
  }

  async request<T>(method: string, params: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    const connection = this.connection;
    if (!connection) throw new LspUnavailableError("The language server is not running.");
    if (this.failure) throw new LspUnavailableError(this.failure);
    signal?.throwIfAborted();
    const deadline = timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        // A server's error response is a server problem, not a task failure.
        // Converting it here keeps the rule that a sick server degrades to one
        // line and a fallback instead of failing the agent's task.
        connection.sendRequest<T>(method, params).catch((error: unknown) => {
          if (error instanceof DOMException || error instanceof LspUnavailableError) throw error;
          if ((error as { code?: unknown })?.code === CONTENT_MODIFIED) {
            throw new LspBusyError(`${method} was answered while the server's state changed`);
          }
          const message = error instanceof Error ? error.message : String(error);
          throw new LspUnavailableError(`${method} failed: ${message}`);
        }),
        new Promise<never>((_resolve, reject) => {
          // A stuck server is a server availability problem, so the caller can
          // report one line and let the agent continue instead of failing.
          timer = setTimeout(() => reject(new LspUnavailableError(`${method} exceeded ${deadline} ms`)), deadline);
          signal?.addEventListener("abort", () => reject(new DOMException("Query aborted.", "AbortError")), { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Every request after start also fails fast when the process dies. */
  async call<T>(method: string, params: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    return this.raceExit(this.request<T>(method, params, signal, timeoutMs));
  }

  /** Open or refresh a document so the server answers against current disk state. */
  async sync(path: string, languageId: string): Promise<string> {
    const connection = this.connection;
    if (!connection) throw new LspUnavailableError("The language server is not running.");
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) {
      throw new Error(`${path} exceeds the ${MAX_SOURCE_BYTES / 1024 / 1024} MiB source limit.`);
    }
    const uri = fileUri(path);
    const open = this.documents.get(uri);
    if (!open) {
      this.documents.set(uri, { version: 1, text });
      // Any cached publish describes an older state of this document.
      this.diagnostics.delete(uri);
      await connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
    } else if (open.text !== text) {
      const version = open.version + 1;
      this.documents.set(uri, { version, text });
      this.diagnostics.delete(uri);
      await connection.sendNotification("textDocument/didChange", {
        textDocument: { uri, version }, contentChanges: [{ text }],
      });
    }
    return text;
  }

  /** Diagnostics the server pushed for a document, if any arrived. */
  pushedDiagnostics(path: string): unknown[] | undefined {
    return this.diagnostics.get(fileUri(path));
  }

  clearDiagnostics(path: string): void {
    this.diagnostics.delete(fileUri(path));
  }

  async dispose(): Promise<void> {
    const connection = this.connection, child = this.child;
    this.connection = undefined;
    this.child = undefined;
    this.documents.clear();
    this.diagnostics.clear();
    if (connection) {
      try {
        // A well-behaved server exits on shutdown; do not wait long for one that does not.
        await Promise.race([connection.sendRequest("shutdown"), new Promise(resolve => setTimeout(resolve, 2_000))]);
        await connection.sendNotification("exit");
      } catch { /* the process is going away regardless */ }
      try { connection.dispose(); } catch { /* already disposed */ }
    }
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      await new Promise<void>(resolve => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
      });
      clearTimeout(killer);
    }
  }
}

/**
 * The capabilities nekopi actually uses.
 *
 * Declaring only what we consume keeps servers from enabling features whose
 * notifications we would ignore.
 */
function clientCapabilities() {
  return {
    general: { positionEncodings: ["utf-16"] },
    // Asked for so the server reports its loading passes. Without this
    // capability a server sends no progress at all, and a query during an
    // index pass is indistinguishable from one with no answer.
    window: { workDoneProgress: true },
    workspace: {
      workspaceFolders: true,
      configuration: true,
      symbol: { symbolKind: { valueSet: Array.from({ length: 26 }, (_value, index) => index + 1) } },
      applyEdit: false,
    },
    textDocument: {
      synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
      definition: { linkSupport: true },
      typeDefinition: { linkSupport: true },
      implementation: { linkSupport: true },
      references: {},
      documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      hover: { contentFormat: ["plaintext", "markdown"] },
      rename: { prepareSupport: true },
      publishDiagnostics: { relatedInformation: false },
      diagnostic: { dynamicRegistration: false },
    },
  };
}
