import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createFindTool } from "./tools/find.ts";
import { createSearchTool, type SearchOptions } from "./tools/search.ts";

/** Replacement tools for Pi's native search surface. */
export function createSourceTools(cwd: string, searchOptions: SearchOptions = {}): ToolDefinition[] {
  return [createSearchTool(cwd, searchOptions), createFindTool(cwd)];
}
