import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Temporary workspaces for one test file, removed together.
 *
 * Every suite that touches the filesystem had its own copy of this: make a
 * temp directory, remember it, write some files into it, delete it afterwards.
 * The copies had drifted — some created parent directories and some would
 * throw on a nested path — so a test's setup depended on which file it lived
 * in. Parent directories are always created here.
 *
 * Cleanup is returned rather than registered, so the importing file decides
 * when it runs and can dispose of its own resources first.
 */
export function workspaces(prefix: string) {
  const roots: string[] = [];
  return {
    /** A new workspace holding `files`, keyed by path relative to its root. */
    async make(files: Record<string, string> = {}): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), `nekopi-${prefix}-`));
      roots.push(root);
      for (const [path, content] of Object.entries(files)) {
        const target = join(root, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
      }
      return root;
    },
    /** Track a directory this file made some other way. */
    track(root: string): string {
      roots.push(root);
      return root;
    },
    async cleanup(): Promise<void> {
      await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
    },
  };
}
