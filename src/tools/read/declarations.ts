import { createSearchTool, type FileSearchDetails } from "../search.ts";
import { resolveInside } from "../workspace-path.ts";
import { symbolRanges } from "./symbol-range.ts";

/** Files grepped for a name, declarations reported, and how long either may take. */
const CANDIDATES = 24, SHOWN = 8, TIMEOUT_MS = 10_000;

export interface Declaration { path: string; start: number; end: number }

export interface Found {
  /** Where the name is really declared, in the order grep returned the files. */
  declared: Declaration[];
  /** Files the name appears in at all, which separates "used" from "absent". */
  seen: string[];
  /** Whether more files matched than were parsed, so `declared` may be short. */
  capped: boolean;
  /** Why the search cannot support a workspace-wide absence claim. */
  incomplete?: string;
  /** Whether the search itself failed, rather than reaching a normal limit. */
  failed?: boolean;
}

function searchFailure(error: unknown, signal?: AbortSignal): string {
  if (signal?.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    || error instanceof DOMException && error.name === "TimeoutError") return "Search timed out.";
  return `Search failed: ${error instanceof Error ? error.message : String(error)}`;
}

/** Bounded candidate search, then syntax checks to distinguish declarations from uses. */
export async function declarationsOf(cwd: string, name: string, signal?: AbortSignal): Promise<Found> {
  const empty: Found = { declared: [], seen: [], capped: false };
  if (!/^[A-Za-z_$][\w$]*$/u.test(name)) return { ...empty, incomplete: "The workspace lookup needs one identifier.", failed: true };
  let seen: string[], capped = false, incomplete: string | undefined, failed = false;
  try {
    const result = await createSearchTool(cwd).execute("nekocli",
      { pattern: `\\b${name}\\b`, outputMode: "files", limit: CANDIDATES } as never,
      signal ?? AbortSignal.timeout(TIMEOUT_MS), () => {}, { cwd } as never);
    const details = result.details as FileSearchDetails;
    seen = details.files;
    capped = details.resultOverflow || details.outputTruncated;
    failed = !!result.isError || details.errors.length > 0;
    if (failed) incomplete = `Search failed: ${details.errors[0] ?? "unknown error"}`;
    else if (!details.scanComplete || capped) incomplete = `Only ${seen.length} matching file(s) were checked; more may exist.`;
  } catch (error) {
    return { ...empty, incomplete: searchFailure(error, signal), failed: true };
  }
  const declared: Declaration[] = [];
  let unparsed = 0;
  for (const [index, path] of seen.entries()) {
    if (declared.length >= SHOWN) {
      capped = true;
      incomplete ??= `Only ${index} of ${seen.length} matching file(s) were checked; more declarations may exist.`;
      break;
    }
    const file = await resolveInside(cwd, path).catch(() => undefined);
    if (!file) { unparsed++; continue; }
    const ranges = await symbolRanges(file.absolute, file.display, name).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.startsWith(`No symbol ${JSON.stringify(name)} in `)) unparsed++;
      return [];
    });
    for (const range of ranges.slice(0, 1)) declared.push({ path, start: range.start, end: range.end });
  }
  if (unparsed) incomplete = [incomplete, `${unparsed} matching file(s) could not be parsed for declarations.`]
    .filter(Boolean).join(" ");
  return { declared, seen, capped, ...(incomplete ? { incomplete } : {}), ...(failed ? { failed } : {}) };
}

/** One line per place a name is declared, for a caller choosing between them. */
export function describeDeclarations(name: string, found: Found): string {
  const next = /^[A-Za-z_$][\w$]*$/u.test(name)
    ? ` Run nek grep -F '${name}' --files --limit 100, then nek read <file> --symbol '${name}'.`
    : " Run nek grep -F <text> --files, then nek read <file> --symbol <name>.";
  if (found.declared.length) {
    return `${name} is declared in ${found.incomplete ? "at least " : ""}${found.declared.length} place(s):\n`
      + found.declared.map(one => `  ${one.path}:${one.start}`).join("\n")
      + (found.capped ? "\n  (more files match the name than were searched)" : "")
      + (found.incomplete ? `\n  ${found.incomplete}${next}` : "");
  }
  if (found.incomplete) {
    if (found.failed) return `Could not determine where ${JSON.stringify(name)} is declared.`
      + ` ${found.incomplete}${found.seen.length ? ` ${found.seen.length} matching file(s) were checked.` : ""}${next}`;
    return `No declaration of ${JSON.stringify(name)} found in ${found.seen.length} checked file(s).`
      + ` ${found.incomplete}${next}`;
  }
  if (found.seen.length) {
    return `No declaration of ${JSON.stringify(name)} in the workspace.`
      + ` It appears in ${found.seen.slice(0, SHOWN).join(", ")}, so it is used rather than declared there.`;
  }
  return `${JSON.stringify(name)} appears nowhere in the workspace.`;
}
