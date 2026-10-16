import { resolve } from "node:path";
import { createFindToolDefinition, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveRipgrep } from "./search.ts";
import { searchFiles } from "./search/files.ts";

const MAX_OUTPUT_BYTES = 16 * 1024, MAX_STREAM_BYTES = 8 * 1024 * 1024;

/** Use grep's file scan, excluding .git before it can consume the result limit. */
export function createFindTool(cwd: string, options: { executable?: string } = {}): ToolDefinition {
  const native = createFindToolDefinition(cwd);
  return defineTool({ ...native,
    async execute(_id, input: { pattern: string; path?: string; limit?: number }, signal, _onUpdate, ctx) {
      const root = (ctx as { cwd?: string } | undefined)?.cwd ?? cwd;
      if (!input || typeof input.pattern !== "string" || !input.pattern) {
        throw new Error("find needs a glob pattern.");
      }
      if (input.limit !== undefined
        && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000)) {
        throw new Error("limit takes 1 to 1000.");
      }
      signal?.throwIfAborted();
      const executable = options.executable ?? await resolveRipgrep(undefined, undefined, root);
      signal?.throwIfAborted();
      // Honor ignore files outside Git repositories. Broad inclusion globs can
      // re-include ignored directories, so omit them for match-everything patterns.
      const everything = ["*", "**", "**/*"].includes(input.pattern);
      // A basename-style glob should also find files under matching directories.
      const alsoByPath = !everything && !input.pattern.includes("/");
      const args = ["--files", "--null", "--no-config", "--hidden", "--color=never",
        "--no-require-git", ...(everything ? [] : ["--glob", input.pattern]),
        ...(alsoByPath ? ["--glob", `**/${input.pattern}/**`] : []),
        "--glob", "!.git", "--", resolve(root, input.path ?? ".")];
      return searchFiles(root, executable, args, input.limit ?? 100,
        { maxStreamBytes: MAX_STREAM_BYTES, maxOutputBytes: MAX_OUTPUT_BYTES }, signal);
    },
  } as ToolDefinition);
}
