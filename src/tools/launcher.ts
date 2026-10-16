/** Locate the packaged CLI and expose it to session-spawned shells. */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";

/** How far up to look for the package root. `dist/` is one level, `src/tools/` is two. */
const MAX_DEPTH = 4;

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

/** Check both launchers and the built bundle before enabling shell mode. */
export async function launcher(from = import.meta.dirname): Promise<{ command: string; directory: string } | undefined> {
  for (let directory = resolve(from), depth = 0; depth <= MAX_DEPTH; depth++) {
    const bin = join(directory, "bin");
    const command = join(bin, "nek");
    const legacy = join(bin, "nekocli");
    if (await isFile(command) && await isFile(legacy) && await isFile(join(bin, "nekocli.mjs"))
      && await isFile(join(directory, "dist", "nekocli.js"))) {
      try {
        await Promise.all([access(command, constants.X_OK), access(legacy, constants.X_OK)]);
        return { command, directory: bin };
      } catch { return undefined; }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/**
 * Idempotent PATH update; reuse Windows' existing Path/PATH key.
 * Pi copies process.env for each Bash call, so later shells see this change.
 */
export function exposeOnPath(directory: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const key = Object.keys(env).find(name => name.toLowerCase() === "path") ?? "PATH";
  const current = env[key] ?? "";
  if (current.split(delimiter).filter(Boolean).includes(directory)) return false;
  env[key] = [directory, current].filter(Boolean).join(delimiter);
  return true;
}
