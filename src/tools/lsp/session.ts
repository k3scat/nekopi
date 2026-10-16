import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient, LspUnavailableError } from "./client.ts";
import { resolveServer, serverRoot, type ResolvedServer, type ServerOverrides } from "./servers.ts";

/** Servers held for the session. Switching between packages reuses one. */
const MAX_SERVERS = 4;

export interface SessionOptions {
  timeoutMs?: number;
  /** Per-language overrides from a trusted configuration layer. */
  servers?: ServerOverrides;
  /** Tests substitute a server instead of discovering an installed one. */
  resolve?: (language: string, cwd: string) => Promise<ResolvedServer | undefined>;
  onStart?: (server: ResolvedServer, root: string) => void;
}

export interface Held { client: LspClient; server: ResolvedServer; root: string }

/**
 * Owns one language server for each workspace root and language.
 *
 * A server is started on the first query that needs it and reused for the rest
 * of the session, because start cost is what made the earlier per-call compiler
 * client unusable. A dead server is replaced once, so a crash costs one query
 * rather than the session.
 */
export class LspSession {
  private readonly held = new Map<string, Held>();
  private readonly order: string[] = [];
  /** Languages already reported as having no installed server. */
  private readonly missing = new Set<string>();
  private workspaces?: string;

  constructor(private readonly options: SessionOptions = {}) {}

  /** Languages this session found no server for, for the user-facing notice. */
  get missingLanguages(): string[] { return [...this.missing]; }

  private touch(key: string): void {
    const at = this.order.indexOf(key);
    if (at >= 0) this.order.splice(at, 1);
    this.order.push(key);
  }

  private async evict(): Promise<void> {
    while (this.order.length > MAX_SERVERS) {
      const key = this.order.shift();
      if (!key) break;
      const entry = this.held.get(key);
      this.held.delete(key);
      await entry?.client.dispose();
    }
  }

  /** jdtls refuses to run without a writable workspace directory of its own. */
  private async workspaceFor(language: string): Promise<string[]> {
    if (language !== "java") return [];
    this.workspaces ??= await mkdtemp(join(tmpdir(), "nekopi-jdtls-"));
    return ["-data", this.workspaces];
  }

  /**
   * The server for a file, started if needed.
   *
   * A missing server is not an error: the caller reports one line and the agent
   * falls back to the syntax and text layers.
   */
  async acquire(language: string, cwd: string, file: string, signal?: AbortSignal): Promise<Held | undefined> {
    const resolver = this.options.resolve
      ?? ((requested: string, root: string) => resolveServer(requested, root, this.options.servers ?? {}));
    const server = await resolver(language, cwd);
    if (!server) { this.missing.add(language); return undefined; }
    const root = await serverRoot(server.recipe, cwd, file);
    const key = `${root}\u0000${language}`;
    const existing = this.held.get(key);
    if (existing && existing.client.alive) { this.touch(key); return existing; }
    if (existing) {
      // Replace a dead server once; a second failure surfaces to the caller.
      this.held.delete(key);
      await existing.client.dispose();
    }
    const client = new LspClient({
      command: server.command,
      args: [...server.args, ...(await this.workspaceFor(language))],
      root, language,
      ...(server.recipe.initialization ? { initialization: server.recipe.initialization } : {}),
      ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
    });
    await client.start(signal);
    const entry: Held = { client, server, root };
    this.held.set(key, entry);
    this.touch(key);
    await this.evict();
    this.options.onStart?.(server, root);
    return entry;
  }

  /** Run a query, replacing the server once if it died between calls. */
  async run<T>(language: string, cwd: string, file: string, signal: AbortSignal | undefined,
    query: (held: Held) => Promise<T>): Promise<T | undefined> {
    const held = await this.acquire(language, cwd, file, signal);
    if (!held) return undefined;
    try {
      return await query(held);
    } catch (error) {
      if (!(error instanceof LspUnavailableError) || held.client.alive) throw error;
      const replacement = await this.acquire(language, cwd, file, signal);
      if (!replacement) throw error;
      return query(replacement);
    }
  }

  async dispose(): Promise<void> {
    const entries = [...this.held.values()];
    this.held.clear();
    this.order.length = 0;
    this.missing.clear();
    await Promise.all(entries.map(entry => entry.client.dispose()));
  }
}
