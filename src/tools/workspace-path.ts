import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Whether `path` stays within `root`. Both are resolved paths. */
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

interface WorkspaceFile {
  /** The workspace root, with symlinks resolved. */
  root: string;
  /** The requested file, with symlinks resolved. */
  absolute: string;
  /** The path to show the model, relative to the root. */
  display: string;
}

/**
 * Resolve a workspace-relative path, or refuse it.
 *
 * Two checks, and the order is the point. The requested path is rejected
 * before the filesystem is touched, so an absolute path or a `..` escape
 * never becomes a syscall. The resolved path is rejected after, because a
 * symlink that lives inside the workspace can still point out of it.
 *
 * Refusal is `undefined` rather than an exception, so each caller words its
 * own message or stays silent; the rule itself lives here, once, instead of
 * in every tool that accepts a path.
 */
export async function resolveInside(cwd: string, requested: string): Promise<WorkspaceFile | undefined> {
  try {
    const root = await realpath(resolve(cwd));
    if (isAbsolute(requested) || !inside(root, resolve(root, requested))) return undefined;
    const absolute = await realpath(resolve(root, requested));
    if (!inside(root, absolute)) return undefined;
    return { root, absolute, display: relative(root, absolute) };
  } catch {
    return undefined;
  }
}

/**
 * Resolve a path for a file that does not exist yet, or refuse it.
 *
 * `resolveInside` resolves the target itself, which a file being created has
 * no entry for. The containment check is therefore on the nearest existing
 * ancestor: an absolute path or a `..` escape is refused before any syscall,
 * and a symlinked parent is refused after resolving it.
 */
export async function resolveNewInside(cwd: string, requested: string):
Promise<{ root: string; absolute: string; display: string } | undefined> {
  try {
    const root = await realpath(resolve(cwd));
    const absolute = resolve(root, requested);
    if (isAbsolute(requested) || !inside(root, absolute)) return undefined;
    if (await lstat(absolute).catch(() => undefined)) return undefined;
    let existing = dirname(absolute);
    while (!(await lstat(existing).catch(() => undefined))) existing = dirname(existing);
    if (!inside(root, await realpath(existing))) return undefined;
    return { root, absolute, display: relative(root, absolute) };
  } catch {
    return undefined;
  }
}
