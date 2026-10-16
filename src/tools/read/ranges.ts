import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type createReadToolDefinition, type ReadToolOptions } from "@earendil-works/pi-coding-agent";
import { readSnapshot } from "./snapshot.ts";
import { formatRanges, type SourceRange, type RangeOutputLimits } from "./range-output.ts";

export { sourceRanges } from "./range-output.ts";
export type { SourceRange, RangeOutputLimits, RangeReadDetails } from "./range-output.ts";

/** One native read supplies every range. Whole source lines retain their original coordinates. */
export async function readRanges(cwd: string, options: ReadToolOptions,
  args: Parameters<ReturnType<typeof createReadToolDefinition>["execute"]>,
  requested: SourceRange[], limits: RangeOutputLimits = {}) {
  const { captured } = await readSnapshot(cwd, options, [args[0], { path: args[1].path, offset: 1, limit: 1 }, args[2], args[3], args[4]], true);
  if (!captured) throw new Error("Native read returned no text snapshot.");
  return formatRanges(captured, requested, { ...limits,
    maxBytes: limits.maxBytes ?? DEFAULT_MAX_BYTES, maxLines: limits.maxLines ?? DEFAULT_MAX_LINES });
}
