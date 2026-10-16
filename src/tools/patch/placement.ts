/**
 * Place context-only hunks on full-line boundaries in source order.
 * A unique or explicitly positioned anchor disambiguates repeated text;
 * report every placement so an unintended match remains visible.
 */

/** How far from a stated line number an occurrence may sit and still be meant. */
export const ANCHOR_TOLERANCE = 3;
/** Candidate lines named in one failure, enough to choose from without a dump. */
const MAX_SHOWN = 6;

export interface PlacementHunk {
  oldText: string;
  newText: string;
  /** A line number the model wrote in the hunk header, if it wrote one. */
  atLine?: number;
}

export interface Placed { start: number; end: number; line: number; newText: string }

export interface Unplaced {
  index: number;
  reason: "missing" | "ambiguous" | "empty" | "crowded";
  /** Total occurrences found, which can exceed the lines shown. */
  count: number;
  lines: number[];
  /** For a hunk whose text is absent, where its leading lines still match. */
  near?: { line: number; matched: number; of: number };
}

export interface Placement { placed?: Placed[]; unplaced: Unplaced[] }

/** The 1-based line a byte offset falls on. */
export function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let at = 0; at < offset; at++) if (source.charCodeAt(at) === 10) line++;
  return line;
}

/**
 * Where a hunk's text sits in the file, preferring whole lines.
 *
 * A diff hunk is a run of whole lines, so a match that starts or ends inside
 * one is not what it means. Requiring that alone would regress a hunk whose
 * leading whitespace the model dropped, which happens, so a substring match is
 * still accepted for a hunk that aligns to no line at all.
 */
export function occurrencesOf(source: string, needle: string): number[] {
  if (!needle) return [];
  const aligned: number[] = [], loose: number[] = [];
  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
    loose.push(at);
    const after = at + needle.length;
    if ((at === 0 || source.charCodeAt(at - 1) === 10)
      && (after === source.length || source.charCodeAt(after) === 10)) aligned.push(at);
  }
  return aligned.length ? aligned : loose;
}

/**
 * Where a hunk's leading lines stop matching the file.
 *
 * A multi-line hunk usually fails on one of its lines rather than all of them,
 * so the longest leading run that occurs exactly once names the place to look,
 * and the line that differs is the one after it. Without this the model is
 * told only that its text is absent, and a measured run spent a turn rereading
 * a file to find a missing ` = null` at the end of one line.
 */
function nearMiss(source: string, oldText: string): Unplaced["near"] | undefined {
  const lines = oldText.split("\n");
  if (lines.length < 2) return undefined;
  for (let run = lines.length - 1; run >= 1; run--) {
    const lead = lines.slice(0, run).join("\n");
    if (!lead.trim()) continue;
    const found = occurrencesOf(source, lead);
    if (found.length === 1) return { line: lineAt(source, found[0]!), matched: run, of: lines.length };
  }
  return undefined;
}

const unplaceable = (source: string, hunks: readonly PlacementHunk[], index: number,
  candidates: number[], reason: Unplaced["reason"]): Unplaced => {
  if (!hunks[index]!.oldText) return { index, reason: "empty", count: 0, lines: [] };
  if (!candidates.length) {
    const near = nearMiss(source, hunks[index]!.oldText);
    return { index, reason: "missing", count: 0, lines: [], ...(near ? { near } : {}) };
  }
  return { index, reason, count: candidates.length,
    lines: candidates.slice(0, MAX_SHOWN).map(at => lineAt(source, at)) };
};

/**
 * Place every hunk of one file, or report each one that cannot be placed.
 *
 * A hunk that matches once, or whose stated line picks out one occurrence, is
 * certain. The runs of hunks between the certain ones are filled in order:
 * forwards from the certain hunk above, backwards from the certain hunk below
 * the ones that precede the first of them. A run with no certain hunk anywhere
 * in the file is reported rather than guessed at.
 */
export function placeHunks(source: string, hunks: readonly PlacementHunk[]): Placement {
  const all = hunks.map(hunk => occurrencesOf(source, hunk.oldText));
  const chosen: Array<number | undefined> = hunks.map(() => undefined);
  const end = (index: number, at: number) => at + hunks[index]!.oldText.length;

  hunks.forEach((hunk, index) => {
    if (hunk.atLine === undefined) return;
    // Nearest to the stated line, and only when one occurrence is strictly
    // nearest. Two occurrences the same distance away say the number was not
    // enough to choose, and guessing between them is what this avoids.
    const near = all[index]!.map(at => ({ at, away: Math.abs(lineAt(source, at) - hunk.atLine!) }))
      .filter(one => one.away <= ANCHOR_TOLERANCE)
      .sort((left, right) => left.away - right.away);
    if (near.length === 1 || (near.length > 1 && near[0]!.away < near[1]!.away)) chosen[index] = near[0]!.at;
  });
  hunks.forEach((_hunk, index) => {
    if (chosen[index] === undefined && all[index]!.length === 1) chosen[index] = all[index]![0];
  });

  // Exact or numbered matches do not depend on hunk order. Models sometimes
  // list two disjoint edits in reverse order; sort those certain locations
  // before splicing, while still refusing edits that claim the same bytes.
  if (hunks.length && chosen.every(at => at !== undefined)) {
    const located = hunks.map((hunk, index) => ({
      index, start: chosen[index]!, end: end(index, chosen[index]!),
      line: lineAt(source, chosen[index]!), newText: hunk.newText,
    })).sort((left, right) => left.start - right.start);
    for (let index = 1; index < located.length; index++) {
      if (located[index]!.start < located[index - 1]!.end) {
        const one = located[index]!;
        return { unplaced: [{ index: one.index, reason: "crowded", count: 1, lines: [one.line] }] };
      }
    }
    return { placed: located.map(({ index: _index, ...one }) => one), unplaced: [] };
  }

  const failed = new Map<number, Unplaced>();
  if (!chosen.some(at => at !== undefined)) {
    // Nothing in the file is certain, so there is no anchor to read the order
    // against. Report the first hunk that needs one.
    const index = chosen.findIndex((at, where) => at === undefined && !!hunks[where]!.oldText);
    const first = index === -1 ? 0 : index;
    return { unplaced: [unplaceable(source, hunks, first, all[first]!, "ambiguous")] };
  }

  // Forwards from each certain hunk, then backwards from the first one.
  for (let index = 0; index < hunks.length; index++) {
    if (chosen[index] !== undefined) continue;
    let lower = 0, hasAnchorAbove = false;
    for (let above = index - 1; above >= 0; above--) {
      const at = chosen[above];
      if (at !== undefined) { lower = end(above, at); hasAnchorAbove = true; break; }
    }
    if (!hasAnchorAbove) continue; // Handled by the backward pass.
    let upper = source.length;
    for (let below = index + 1; below < hunks.length; below++) {
      const at = chosen[below];
      if (at !== undefined) { upper = at; break; }
    }
    const feasible = all[index]!.filter(at => at >= lower && end(index, at) <= upper);
    if (!feasible.length) {
      failed.set(index, unplaceable(source, hunks, index, all[index]!, "crowded"));
      continue;
    }
    chosen[index] = feasible[0];
  }
  for (let index = hunks.length - 1; index >= 0; index--) {
    if (chosen[index] !== undefined || failed.has(index)) continue;
    let upper = source.length;
    for (let below = index + 1; below < hunks.length; below++) {
      const at = chosen[below];
      if (at !== undefined) { upper = at; break; }
    }
    const feasible = all[index]!.filter(at => end(index, at) <= upper);
    if (!feasible.length) {
      failed.set(index, unplaceable(source, hunks, index, all[index]!, "crowded"));
      continue;
    }
    chosen[index] = feasible[feasible.length - 1];
  }

  if (failed.size) {
    return { unplaced: [...failed.keys()].sort((left, right) => left - right).map(index => failed.get(index)!) };
  }
  const placed = hunks.map((hunk, index) => ({
    start: chosen[index]!, end: end(index, chosen[index]!),
    line: lineAt(source, chosen[index]!), newText: hunk.newText,
  }));
  // A model that supplies its own line numbers can ask for an order the file
  // cannot have, and splicing that would corrupt the file rather than fail.
  for (let index = 1; index < placed.length; index++) {
    if (placed[index]!.start < placed[index - 1]!.end) {
      return { unplaced: [{ index, reason: "crowded", count: 1, lines: [placed[index]!.line] }] };
    }
  }
  return { placed, unplaced: [] };
}

/** Apply placements to the source. Non-overlapping and in order by construction. */
export function splice(source: string, placed: readonly Placed[]): string {
  let out = "", at = 0;
  for (const one of placed) { out += source.slice(at, one.start) + one.newText; at = one.end; }
  return out + source.slice(at);
}

/** A hunk's text in the endings a file that does not use LF needs. */
const asCrlf = (text: string): string => text.replace(/\r?\n/gu, "\r\n");

/**
 * Place hunks whose line endings are not necessarily the file's.
 *
 * The envelope parser normalizes its own text to LF, because a model writes
 * the dialect either way, while the file is read exactly as it is. On a CRLF
 * file that left a multi-line hunk unable to match at all: every joining
 * newline was wrong. A single line hunk still matched, but only through the
 * substring fallback, so it never got the whole-line check.
 *
 * Converting is a second pass rather than a normalization of the file. An LF
 * file is untouched, a mixed file keeps whichever pass reads it better, and a
 * CRLF file keeps its own endings through the splice because the replacement
 * text is converted with the text being matched.
 */
export function placeAnyEnding(source: string, hunks: readonly PlacementHunk[]): Placement {
  const asWritten = placeHunks(source, hunks);
  if (!asWritten.unplaced.length || !source.includes("\r\n")) return asWritten;
  const converted = placeHunks(source, hunks.map(hunk =>
    ({ ...hunk, oldText: asCrlf(hunk.oldText), newText: asCrlf(hunk.newText) })));
  return converted.unplaced.length < asWritten.unplaced.length ? converted : asWritten;
}

/** One line per unplaceable hunk, naming what it could have meant. */
export function describe(path: string, unplaced: readonly Unplaced[]): string[] {
  return unplaced.map(one => {
    const where = `${path} hunk ${one.index + 1}`;
    if (one.reason === "empty") {
      return `${where}: it has no context to match. Give it a line of surrounding context,`
        + ` or a line number in the hunk header, as "@@ 120".`;
    }
    if (one.reason === "missing") {
      const near = one.near
        ? ` Its first ${one.near.matched} of ${one.near.of} lines match at line ${one.near.line},`
          + ` so the difference is at or after line ${one.near.line + one.near.matched}.`
        : "";
      return `${where}: its text is not in the file.${near}`;
    }
    if (one.reason === "crowded") {
      return `${where}: no occurrence of its text fits between the hunks around it,`
        + ` which apply in source order. Check the order of the hunks, or pin this one`
        + ` with a line number in its header, as "@@ ${one.lines[0] ?? 120}".`;
    }
    const more = one.count > one.lines.length ? ` (${one.lines.length} of ${one.count} shown)` : "";
    return `${where}: its text appears ${one.count} times, at line ${one.lines.join(", ")}${more},`
      + ` and no other hunk in this file is unique enough to say which is meant.`
      + ` Pin it with a line number in its header, as "@@ ${one.lines[0]}".`;
  });
}
