import { createReadToolDefinition, defineTool, type ReadToolOptions, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createNumberedReadToolDefinition, type NumberedReadDetails } from "./read/numbered.ts";
import { readRanges, sourceRanges, type RangeOutputLimits, type RangeReadDetails } from "./read/ranges.ts";
import { shapeOf, UNBOUNDED_LINES, type Shape } from "./read/structure.ts";
import { symbolRanges } from "./read/symbol-range.ts";
import { resolveInside } from "./workspace-path.ts";

/** Resolve a declaration name to its source range inside the workspace. */
async function resolveSymbol(cwd: string, requested: string, symbol: string) {
  const file = await resolveInside(cwd, requested);
  if (!file) throw new Error("symbol requires a workspace-relative path inside the workspace.");
  return symbolRanges(file.absolute, file.display, symbol);
}

/** A symbol map of the file, for a read that cannot show all of it. */
async function shapeFor(cwd: string, requested: string): Promise<Shape | undefined> {
  const file = await resolveInside(cwd, requested);
  return file ? shapeOf(file.absolute, file.display) : undefined;
}

/** Range/symbol selection for CLI and programmatic callers, outside the native tool schema. */
export function readSelection(cwd: string, options: ReadToolOptions = {}, limits: RangeOutputLimits = {}) {
  return async (input: { path: string; symbol?: string; ranges?: Array<{ start: number; end: number }> },
    signal?: AbortSignal, ctx?: { cwd?: string }) => {
    if (input.symbol !== undefined && input.ranges !== undefined) {
      throw new Error("symbol and ranges select source differently; use one of them.");
    }
    const ranges = input.symbol !== undefined
      ? await resolveSymbol(ctx?.cwd ?? cwd, input.path, input.symbol)
      : sourceRanges(input.ranges ?? []);
    return readRanges(cwd, options, ["read", { path: input.path }, signal, undefined, ctx as never], ranges, limits);
  };
}

/** Optional line labels and a symbol map over one native read snapshot. */
export function createReadBufferTool(cwd: string, options: ReadToolOptions = {}) {
  const native = createReadToolDefinition(cwd, options);
  const numbered = createNumberedReadToolDefinition(cwd, options);
  const parameters = Type.Object({
    ...native.parameters.properties,
    lineNumbers: Type.Optional(Type.Boolean({ description: "Return original 1-based source line labels for citations. Omitted or false keeps ordinary output." })),
  });
  const definition: ToolDefinition<typeof parameters, (NumberedReadDetails & Partial<RangeReadDetails>) | undefined> = {
    ...native, parameters,
    description: native.description,
    renderResult(result, options, theme, context) {
      // The source metadata remains native. Its old displayed count is stale if labels remove rows.
      const displayed = result.details?.numberedRead?.truncatedByNumbering
        ? { ...result, details: { ...result.details, truncation: undefined } } : result;
      // The numbered content already gives the actual range, cap and continuation.
      return native.renderResult!(displayed, options, theme, context);
    },
    async execute(id, input, signal, onUpdate, ctx) {
      if (input.lineNumbers !== undefined && typeof input.lineNumbers !== "boolean") {
        throw new Error("lineNumbers must be a boolean.");
      }
      const { path, offset, limit } = input;
      const read = input.lineNumbers ? numbered : native;
      // A range was a deliberate choice: honour it exactly and add nothing.
      if (offset !== undefined || limit !== undefined) {
        return read.execute(id, { path, offset, limit }, signal, onUpdate, ctx);
      }
      // A long ordinary read gets a prefix and map; explicit selections remain exact.
      const shape = await shapeFor(ctx?.cwd ?? cwd, path);
      const capped = shape !== undefined && shape.lines > UNBOUNDED_LINES;
      const result = await read.execute(id,
        { path, ...(capped ? { offset: 1, limit: UNBOUNDED_LINES } : {}) }, signal, onUpdate, ctx);
      // Truncation by the byte cap needs the map for the same reason a long
      // file does, so either way the read that cannot show it all carries one.
      if (!shape || !(capped || result.details?.truncation?.truncated)) return result;
      const last = result.content.at(-1);
      if (last?.type !== "text") return result;
      return { ...result,
        content: [...result.content.slice(0, -1), { ...last, text: `${last.text}\n\n${shape.text}` }] };
    },
  };
  return defineTool(definition);
}
