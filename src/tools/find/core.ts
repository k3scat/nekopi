import { resolve } from "node:path";
import { resolveRipgrep } from "../search/ripgrep.ts";
import { searchFiles } from "../search/files.ts";

const MAX_OUTPUT_BYTES = 16 * 1024, MAX_STREAM_BYTES = 8 * 1024 * 1024;

export async function findFiles(cwd: string, input: { pattern: string; path?: string; limit?: number },
  options: { executable?: string } = {}, signal?: AbortSignal, agentDir?: () => string) {
  if (!input || typeof input.pattern !== "string" || !input.pattern) {
    throw new Error("find needs a glob pattern.");
  }
  if (input.limit !== undefined
    && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000)) {
    throw new Error("limit takes 1 to 1000.");
  }
  signal?.throwIfAborted();
  const executable = options.executable ?? await resolveRipgrep(agentDir?.(), undefined, cwd);
  signal?.throwIfAborted();
  // Honor ignore files outside Git repositories. Broad inclusion globs can
  // re-include ignored directories, so omit them for match-everything patterns.
  const everything = ["*", "**", "**/*"].includes(input.pattern);
  // A basename-style glob should also find files under matching directories.
  const alsoByPath = !everything && !input.pattern.includes("/");
  const args = ["--files", "--null", "--no-config", "--hidden", "--color=never",
    "--no-require-git", ...(everything ? [] : ["--glob", input.pattern]),
    ...(alsoByPath ? ["--glob", `**/${input.pattern}/**`] : []),
    "--glob", "!.git", "--", resolve(cwd, input.path ?? ".")];
  return searchFiles(cwd, executable, args, input.limit ?? 100,
    { maxStreamBytes: MAX_STREAM_BYTES, maxOutputBytes: MAX_OUTPUT_BYTES }, signal);
}
