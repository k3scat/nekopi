import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";

export class ProjectRefreshLimitError extends Error {}

const protocolLimit = 8 * 1024 * 1024;
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid tsserver response object.");
  return value as ObjectValue;
}

/** One ordered protocol stream. The caller owns per-query cancellation and disposal. */
class TsserverSession {
  private child: ReturnType<typeof spawn>;
  private exited: Promise<void>;
  private sequence = 0;
  private pending?: { seq: number; resolve: (body: unknown) => void; reject: (error: Error) => void };
  private failure?: Error;
  private bytes = Buffer.alloc(0);
  private received = 0;
  private configDiagnostics = new Map<string, unknown[]>();
  private files: string[] = [];
  private diskSignature?: string;
  private openFile?: string;
  private querySignature?: string;
  private queryFiles: string[] = [];
  private watchers = new Map<number, { path: string; recursive: boolean }>();
  private queryDirectories: string[] = [];
  readonly key: string;

  constructor(root: string, serverPath: string, nodeExecutable: string, project: string, clientWatches: boolean) {
    this.key = JSON.stringify([root, serverPath, nodeExecutable, project, clientWatches]);
    this.child = spawn(nodeExecutable, [serverPath, "--disableAutomaticTypingAcquisition", "--useInferredProjectPerProjectRoot", "--noGetErrOnBackgroundUpdate",
      ...(clientWatches ? ["--canUseWatchEvents"] : [])],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "", TSS_LOG: "", TSS_TRACE: "" } });
    this.exited = new Promise(resolve => {
      this.child.once("error", error => { this.fail(error); resolve(); });
      this.child.once("close", () => { this.fail(new Error("tsserver exited before its response.")); resolve(); });
    });
    this.child.stdin!.on("error", error => this.fail(error));
    this.child.stderr!.resume();
    this.child.stdout!.on("data", chunk => {
      this.received += chunk.length;
      if (this.received > protocolLimit) return this.fail(new Error("tsserver protocol output exceeded 8 MiB."));
      this.bytes = Buffer.concat([this.bytes, chunk]);
      try {
        while (true) {
          const headerEnd = this.bytes.indexOf("\r\n\r\n");
          if (headerEnd < 0) { if (this.bytes.length > 1_024) throw new Error("Invalid tsserver protocol header."); break; }
          const length = /^Content-Length: (\d+)$/i.exec(this.bytes.subarray(0, headerEnd).toString("ascii"))?.[1];
          if (!length || Number(length) > protocolLimit) throw new Error("Invalid tsserver protocol length.");
          const end = headerEnd + 4 + Number(length);
          if (this.bytes.length < end) break;
          const content = this.bytes.subarray(headerEnd + 4, end);
          if (!isUtf8(content)) throw new Error("Invalid tsserver protocol encoding.");
          const message = object(JSON.parse(content.toString("utf8")));
          this.bytes = this.bytes.subarray(end);
          if (message.type === "event" && ["createFileWatcher", "createDirectoryWatcher", "closeFileWatcher"].includes(String(message.event))) {
            const body = object(message.body);
            if (!Number.isSafeInteger(body.id)) throw new Error("Invalid tsserver watcher identifier.");
            if (message.event === "closeFileWatcher") this.watchers.delete(body.id as number);
            else {
              if (typeof body.path !== "string") throw new Error("Invalid tsserver watch path.");
              if (this.watchers.size >= 50_000) throw new ProjectRefreshLimitError("Project watch list limit exceeded.");
              this.watchers.set(body.id as number, { path: body.path, recursive: message.event === "createDirectoryWatcher" && body.recursive === true });
            }
          }
          if (message.type === "event" && message.event === "configFileDiag") {
            const body = object(message.body);
            if (typeof body.configFile !== "string" || !Array.isArray(body.diagnostics)) throw new Error("Invalid project configuration event.");
            this.configDiagnostics.set(body.configFile, body.diagnostics);
          }
          if (message.type === "response" && this.pending?.seq === message.request_seq) {
            const waiter = this.pending!; this.pending = undefined;
            if (message.success === true) waiter.resolve(message.body);
            else waiter.reject(new Error("tsserver rejected the request."));
          }
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error("Invalid tsserver protocol.")); }
    });
  }

  get pid() { return this.child.pid; }
  assertHealthy() { if (this.failure) throw this.failure; }
  begin() { this.assertHealthy(); this.received = this.bytes.length; }
  diagnostics() { return [...this.configDiagnostics.values()].flat(); }
  private fail(error: Error) {
    this.failure ??= error;
    this.pending?.reject(error); this.pending = undefined;
    this.child.kill("SIGKILL");
  }
  async dispose() { this.fail(new Error("code_intel server closed.")); await this.exited; }
  notify(command: string, args: ObjectValue) {
    this.assertHealthy();
    this.child.stdin!.write(JSON.stringify({ seq: ++this.sequence, type: "request", command, arguments: args }) + "\n");
  }
  request(command: string, args: ObjectValue) {
    this.assertHealthy();
    if (this.pending) throw new Error("Concurrent tsserver protocol request.");
    return new Promise<unknown>((resolve, reject) => {
      this.pending = { seq: this.sequence + 1, resolve, reject };
      this.notify(command, args);
    });
  }

  async refresh(root: string, target: string, text: string, snapshot: { config: string; files: string[] }, signal: AbortSignal) {
    this.queryFiles = [...new Set([...snapshot.files, ...this.files, ...[...this.watchers.values()].map(watcher => watcher.path)])].sort();
    this.queryDirectories = [...new Set([...this.watchers.values()].flatMap(watcher =>
      basename(watcher.path) === "package.json" && /[\\/]node_modules[\\/]/.test(watcher.path) ? [dirname(watcher.path)] : watcher.recursive ? [watcher.path] : []))].sort();
    const signature = await this.signature(snapshot, signal);
    if (this.diskSignature !== undefined && signature !== this.diskSignature) this.notify("reloadProjects", {});
    if (this.openFile && this.openFile !== target) this.notify("close", { file: this.openFile });
    // Explicit content refreshes open files; reloadProjects refreshes imported CLOSED files.
    this.notify("open", { file: target, fileContent: text, projectRootPath: root });
    this.openFile = target;
    this.querySignature = signature;
  }
  async remember(snapshot: { config: string; files: string[] }, files: unknown, signal: AbortSignal) {
    if (await this.signature(snapshot, signal) !== this.querySignature) throw new Error("Project source changed during the query; retry on current disk state.");
    if (files !== undefined) {
      if (!Array.isArray(files) || files.some(file => typeof file !== "string")) throw new Error("Invalid project source list.");
      if (files.length > 50_000) throw new ProjectRefreshLimitError("Project source list limit exceeded.");
      this.files = files as string[];
    }
    this.diskSignature = this.querySignature;
  }
  private async signature(snapshot: { config: string; files: string[] }, signal: AbortSignal) {
    const files = this.queryFiles;
    if (files.length > 50_000) throw new ProjectRefreshLimitError("Project refresh is limited to 50000 source files.");
    const values: string[] = [];
    for (let start = 0; start < files.length; start += 64) {
      signal.throwIfAborted();
      values.push(...await Promise.all(files.slice(start, start + 64).map(async path => {
        try { const info = await stat(path, { bigint: true }); return `${path}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return `${path}:missing`; }
      })));
    }
    return snapshot.config + JSON.stringify(values) + await directoryTopology(this.queryDirectories, signal);
  }
}

/** Recursive server watches must observe additions below existing directories, including failed imports.
 * Only directory entries are read; source contents remain under the existing verification limits. */
async function directoryTopology(roots: string[], signal: AbortSignal) {
  const hash = createHash("sha256"), visited = new Set<string>(), pending = [...roots];
  let entries = 0;
  while (pending.length) {
    signal.throwIfAborted();
    const path = pending.pop()!;
    let actual: string;
    try { actual = await realpath(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update(JSON.stringify([path, "missing"])); continue;
    }
    hash.update(JSON.stringify([path, actual]));
    if (visited.has(actual)) continue;
    visited.add(actual);
    if (visited.size > 10_000) throw new ProjectRefreshLimitError("Project refresh directory limit exceeded.");
    const children = (await readdir(actual, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    entries += children.length;
    if (entries > 100_000) throw new ProjectRefreshLimitError("Project refresh directory entry limit exceeded.");
    const packageEntries = basename(actual) === "node_modules" || basename(dirname(actual)) === "node_modules" && basename(actual).startsWith("@");
    for (const child of children) {
      signal.throwIfAborted();
      const nested = join(actual, child.name);
      hash.update(JSON.stringify([child.name, child.isDirectory(), child.isSymbolicLink()]));
      // Broad dependency roots need package names and symlink targets. Descend only into
      // packages whose manifests the server watches, rather than every installed dependency.
      if (child.isDirectory() && (!packageEntries || child.name.startsWith("@"))) pending.push(nested);
      else if (child.isSymbolicLink()) {
        try {
          const target = await realpath(nested);
          hash.update(target);
          if (!packageEntries && (await stat(target)).isDirectory()) pending.push(nested);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; hash.update("missing"); }
      }
    }
  }
  return hash.digest("hex");
}

/** Serializes callers and keeps cancellation scoped to the active call. */
export class TsserverOwner {
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private controllers = new Set<AbortController>();
  private server?: TsserverSession;
  private servers = new Map<string, TsserverSession>();

  async run<T>(signal: AbortSignal | undefined, timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error("code_intel is disposed.");
    signal?.throwIfAborted();
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort(signal?.reason ?? new Error("code_intel canceled."));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("code_intel timed out.")), timeoutMs);
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    let waitingAbort: (() => void) | undefined;
    try {
      await Promise.race([previous, new Promise<never>((_, reject) => {
        waitingAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", waitingAbort, { once: true });
      })]);
      controller.signal.throwIfAborted();
      controller.signal.removeEventListener("abort", waitingAbort!);
      const stop = () => { void this.server?.dispose(); };
      controller.signal.addEventListener("abort", stop, { once: true });
      try {
        const result = await operation(controller.signal);
        controller.signal.throwIfAborted();
        return result;
      }
      catch (error) { await this.reset(); controller.signal.throwIfAborted(); throw error; }
      finally { controller.signal.removeEventListener("abort", stop); }
    } finally {
      // A canceled waiter must not let a later caller overtake the active operation.
      void previous.finally(release);
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (waitingAbort) controller.signal.removeEventListener("abort", waitingAbort);
      this.controllers.delete(controller);
    }
  }
  async get(root: string, serverPath: string, nodeExecutable: string, project: string, persistent: boolean, signal: AbortSignal, onSpawn?: (pid: number) => void) {
    const key = JSON.stringify([root, serverPath, nodeExecutable, project, persistent]);
    this.server = this.servers.get(key);
    const reused = this.server !== undefined;
    if (!this.server) {
      // Bound live compiler processes while allowing common multi-package workspaces to reuse them.
      if (this.servers.size >= 4) {
        const [oldestKey, oldest] = this.servers.entries().next().value!;
        this.servers.delete(oldestKey); await oldest.dispose();
      }
      signal.throwIfAborted();
      this.server = new TsserverSession(root, serverPath, nodeExecutable, project, persistent);
    }
    this.servers.delete(key); this.servers.set(key, this.server);
    if (!reused && this.server.pid) onSpawn?.(this.server.pid);
    signal.throwIfAborted();
    this.server.begin();
    if (!reused) await this.server.request("configure", { preferences: { disableLineTextInReferences: false }, hostInfo: "nekopi" });
    return this.server;
  }
  async reset() { const server = this.server; this.server = undefined; if (server) this.servers.delete(server.key); await server?.dispose(); }
  async dispose() {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort(new Error("code_intel is disposed."));
    await Promise.all([...this.servers.values()].map(server => server.dispose()));
    this.servers.clear(); this.server = undefined;
    await this.tail;
  }
}
