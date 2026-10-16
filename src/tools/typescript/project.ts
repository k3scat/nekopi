import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type ts from "typescript";
import { inside } from "../workspace-path.ts";
import { ProjectRefreshLimitError } from "./session.ts";


/**
 * The one failure that means "this project has no TypeScript", as opposed to
 * "this project's TypeScript did not work".
 *
 * The caller used to swallow every error from the fallback and report the
 * first of those for both. That hid a crash on any project pinning TypeScript
 * below 5.9 for a whole measured batch, so the two are named apart here.
 */
export class NoWorkspaceCompilerError extends Error {}

export async function resolveCompiler(root: string, target: string, options: { serverPath?: string; allowHarnessFallback?: boolean }, harnessUrl: string) {
  // Preserve the facade's resolution origin in source and bundled installations.
  const requireFromHarness = createRequire(harnessUrl);
  let serverPath = options.serverPath, versionSource = "explicit override";
  if (!serverPath) {
    // Search only workspace node_modules ancestors. Honor project dependency symlinks
    // without resolving an unrelated parent, NODE_PATH or harness installation.
    let directory = dirname(target);
    while (inside(root, directory)) {
      try {
        serverPath = await realpath(resolve(directory, "node_modules/typescript/lib/tsserver.js"));
        versionSource = "project installation";
        break;
      } catch { /* Look at the next workspace ancestor. */ }
      if (directory === root) break;
      directory = dirname(directory);
    }
    if (!serverPath && !options.allowHarnessFallback) throw new NoWorkspaceCompilerError("No workspace TypeScript installation found for this file; code intelligence does not install or use a harness compiler.");
    if (!serverPath) { serverPath = requireFromHarness.resolve("typescript/lib/tsserver.js"); versionSource = "harness fallback"; }
  }
  serverPath = await realpath(serverPath);
  const pkg: unknown = JSON.parse(await readFile(resolve(dirname(serverPath), "../package.json"), "utf8"));
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) throw new Error("Invalid tsserver response object.");
  const packageInfo = pkg as Record<string, unknown>;
  const version = typeof packageInfo.version === "string" ? /^([1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(packageInfo.version) : null;
  // The requests used here are the long-stable tsserver commands, so the range
  // tracks what projects actually install. Capping below 6 meant a project on
  // the current compiler reported no workspace compiler at all, which reads as
  // a tool the agent declined rather than one that was never offered.
  const major = version ? Number(version[1]) : 0;
  const compatibleVersion = version && (major === 5 || major === 6 || major === 4 && Number(version[2]) >= 9);
  if (packageInfo.name !== "typescript" || !compatibleVersion
    || versionSource === "harness fallback" && packageInfo.version !== "5.9.3") throw new Error(`Unsupported TypeScript server: requires stable >=4.9.0 <7.0.0.${options.allowHarnessFallback ? " Harness fallback must be 5.9.3." : ""}`);
  const compiler = requireFromHarness(resolve(dirname(serverPath), "typescript.js")) as typeof ts;
  return { serverPath, version: packageInfo.version, versionSource, compiler };
}

/** Official tsserver has no disable-all-plugins switch. Inspect effective config
 * with its own compiler before opening a project. Persistent callers also collect
 * the configured source inventory to detect additions and removals. */
export async function checkProjectPlugins(root: string, target: string, compiler: typeof ts, signal: AbortSignal, discoverFiles = false) {
  let directory = dirname(target);
  const ancestorConfigs: string[] = [];
  while (inside(root, directory)) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      try { const candidate = resolve(directory, name); await access(candidate); ancestorConfigs.push(candidate); } catch { /* Look at the next conventional config. */ }
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
  const visited = new Set<string>();
  let configReads = 0, configBytes = 0;
  const config = new Map<string, string>(), files = new Set<string>();
  const configRead = (path: string) => {
    signal.throwIfAborted();
    if (++configReads > 256) throw new Error("Plugin preflight configuration read limit exceeded.");
    let size: number;
    try { size = statSync(path).size; } catch { return undefined; }
    configBytes += size;
    if (size > 1024 * 1024 || configBytes > 4 * 1024 * 1024) throw new Error("Plugin preflight configuration byte limit exceeded.");
    const text = compiler.sys.readFile(path);
    config.set(path, text ?? "missing");
    return text;
  };
  async function checkPlugins(configPath: string): Promise<void> {
    signal.throwIfAborted();
    if (!inside(root, resolve(configPath))) throw new Error("Project configuration escapes the workspace.");
    let actual: string;
    try { actual = await realpath(configPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      config.set(configPath, "missing"); return;
    }
    if (!inside(root, actual)) throw new Error("Project configuration escapes the workspace.");
    if (visited.has(actual)) return;
    visited.add(actual);
    if (visited.size > 128) throw new Error("Plugin preflight is limited to 128 referenced project configurations.");
    const loaded = compiler.readConfigFile(actual, configRead);
    const parsed = compiler.parseJsonConfigFileContent(loaded.config ?? {}, { ...compiler.sys, readFile: configRead, readDirectory: (...args) => {
      if (!discoverFiles) return [];
      signal.throwIfAborted();
      const found = compiler.sys.readDirectory(...args);
      if (found.length > 50_000) throw new ProjectRefreshLimitError("Project discovery is limited to 50000 source files.");
      return found;
    } }, dirname(actual), undefined, actual);
    if (discoverFiles) for (const file of parsed.fileNames) files.add(file);
    if (files.size > 50_000) throw new ProjectRefreshLimitError("Project discovery is limited to 50000 source files.");
    if (Array.isArray(parsed.options.plugins) && parsed.options.plugins.length) throw new Error("Configured TypeScript plugins are unsupported; automatic plugin execution is disabled by preflight.");
    for (const reference of parsed.projectReferences ?? []) {
      const path = reference.path.endsWith(".json") ? reference.path : resolve(reference.path, "tsconfig.json");
      await checkPlugins(path);
    }
  }
  for (const config of ancestorConfigs) await checkPlugins(config);
  return { project: ancestorConfigs[0] ?? root, config: createHash("sha256").update(JSON.stringify([...config].sort())).digest("hex"), files: [...new Set([...files, ...config.keys()])] };
}
