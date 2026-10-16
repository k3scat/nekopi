import { createFindToolDefinition, defineTool, getAgentDir, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { findFiles } from "./find/core.ts";

/** Use grep's file scan, excluding .git before it can consume the result limit. */
export function createFindTool(cwd: string, options: { executable?: string } = {}): ToolDefinition {
  const native = createFindToolDefinition(cwd);
  return defineTool({ ...native,
    async execute(_id, input: { pattern: string; path?: string; limit?: number }, signal, _onUpdate, ctx) {
      return findFiles((ctx as { cwd?: string } | undefined)?.cwd ?? cwd, input, options, signal, getAgentDir);
    },
  } as ToolDefinition);
}
