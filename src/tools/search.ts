import { createGrepToolDefinition, getAgentDir, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { search, SEARCH_PATH_LIMIT, type SearchOptions } from "./search/core.ts";

export { SEARCH_PATH_LIMIT } from "./search/core.ts";
export type { SearchRow, SearchDetails, SearchOptions, FileSearchDetails } from "./search/core.ts";
export { resolveRipgrep } from "./search/ripgrep.ts";
const OUTPUT_LIMIT = 50 * 1024, STREAM_LIMIT = 8 * 1024 * 1024;

/** Native Pi search fields with multiple paths, ordered globs and a files mode. */
export function createSearchTool(cwd: string, options: SearchOptions = {}) {
  const { renderCall: _renderCall, renderResult: _renderResult, ...native } = createGrepToolDefinition(cwd);
  const maxBytes = options.maxOutputBytes ?? OUTPUT_LIMIT, streamBytes = options.maxStreamBytes ?? STREAM_LIMIT;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || !Number.isSafeInteger(streamBytes) || streamBytes < 1) throw new Error("Invalid search byte limits.");
  return {
    ...native,
    parameters: Type.Object({ ...native.parameters.properties,
      path: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: SEARCH_PATH_LIMIT })], {
        description: `One path, or up to ${SEARCH_PATH_LIMIT} searched together (default: current directory). Relative to the session directory; ~ and @ are literal. Explicit files bypass ignore and glob filters.`,
      })),
      glob: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 16 })], {
        description: "One ripgrep glob, or up to 16 ordered rules. Prefix ! to exclude; later rules win. Example: ['*.{ts,tsx}', '!**/*.generated.ts'].",
      })),
      outputMode: Type.Optional(Type.Union([Type.Literal("content"), Type.Literal("files")], { description: "content returns matching lines (default); files returns unique matching paths." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum matching lines, or files in files mode (default: 100)." })),
      maxMatchesPerFile: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Content mode: cap matches per file for broad discovery, for example 1. Omitted means uncapped." })),
      context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Surrounding lines per match, content mode only (default: 0)." })),
    }),
    description: "Search file contents with ripgrep. Content mode heads each file's hits with its path, names the enclosing symbol in brackets where one is known, and returns `line: text` per match, with `-` instead of `:` for context lines. Long lines are clipped around the match and marked with an ellipsis. Files mode returns unique matching paths.",

    promptGuidelines: ["Prefer named paths and globs over a repository-wide search."],
    async execute(_id: string, args: unknown, signal?: AbortSignal, _onUpdate?: unknown, ctx?: Pick<ExtensionToolContext, "cwd">) {
      return search(ctx?.cwd ?? cwd, args, { ...options, maxOutputBytes: maxBytes, maxStreamBytes: streamBytes }, signal, getAgentDir);
    },
  };
}

export default function searchExtension(pi: ExtensionAPI): void {
  pi.registerTool(createSearchTool(process.cwd()));
}
