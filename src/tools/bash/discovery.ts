import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";

const MAX_NAMES = 24, MAX_NOTE_BYTES = 512;

/** On relevant failures, suggest only scripts, configs or executables that exist. */
type Want = { kind: "script"; named?: string } | { kind: "tsconfig"; named?: string }
  | { kind: "command"; named: string };

/** Bash quotes a command's non-ASCII bytes as octal when its locale cannot print them. */
function bashOctalName(name: string): string {
  const quoted = /^\$'((?:\\[0-3][0-7]{2})+)'$/u.exec(name);
  const encoded = quoted?.[1];
  if (!encoded) return name;
  const bytes = Buffer.from(encoded.slice(1).split("\\")
    .map(octal => Number.parseInt(octal, 8)));
  const decoded = bytes.toString("utf8");
  return Buffer.from(decoded, "utf8").equals(bytes) ? decoded : name;
}

/** Only the shapes a runner actually prints, so an unrelated failure stays quiet. */
export function wanted(output: string): Want | undefined {
  const script = /ERR_PNPM_NO_SCRIPT\s+Missing script:\s*"?([^"\n]+)"?/u.exec(output)
    ?? /Missing script:\s*"([^"\n]+)"/u.exec(output)
    ?? /npm error Missing script:\s*"([^"\n]+)"/u.exec(output);
  if (script) return { kind: "script", ...(script[1] ? { named: script[1].trim() } : {}) };
  if (/\bERR_PNPM_RECURSIVE_RUN_NO_SCRIPT\b/u.test(output)) return { kind: "script" };
  const tsconfig = /error TS5058: The specified path does not exist: '([^']+)'/u.exec(output);
  if (tsconfig) return { kind: "tsconfig", ...(tsconfig[1] ? { named: tsconfig[1] } : {}) };
  // The shell's own words, from bash, sh, dash and zsh. Only the name is taken.
  // Shells differ: bash says "<shell>: line N: <name>: command not found", sh
  // and dash say "<shell>: N: <name>: not found". The leading segments are
  // bounded rather than open ended so the pattern cannot backtrack badly.
  const missing = /(?:^|\n)(?:[^\n:]{0,64}:[ \t]*){0,4}?([^\s:]{1,64}):[ \t]*(?:command not found|not found)(?:\s|$)/u.exec(output);
  if (missing?.[1]) return { kind: "command", named: bashOctalName(missing[1]) };
  return undefined;
}

/**
 * Cyrillic letters read as the Latin ones they stand in for.
 *
 * A measured run typed `\u043d\u0435\u043aocli` and lost seven calls to seven identical
 * "command not found" lines, because nothing in the output distinguishes those
 * three characters from the ones it meant. An edit distance cannot see it
 * either: the two strings differ in three of seven characters.
 *
 * The readings are transliterations rather than shapes, which is what the
 * observed substitution was: Cyrillic `\u043d` is drawn like `H` but stands in for
 * `n`. Where a letter could be read either way the table is not trying to be
 * right in general, because the fold is only ever compared against two known
 * command names and anything else returns no advice. A wrong reading therefore
 * costs a missing note, never a wrong one.
 */
const LATINISED: Record<string, string> = {
  "\u0430": "a", "\u0432": "v", "\u0435": "e", "\u0438": "i", "\u0439": "i", "\u043a": "k", "\u043b": "l", "\u043c": "m",
  "\u043d": "n", "\u043e": "o", "\u043f": "p", "\u0440": "r", "\u0441": "c", "\u0442": "t", "\u0443": "u", "\u0445": "h",
  "\u0446": "c", "\u0456": "i", "\u0458": "j",
};

/** The name as its letters stand in, so a substituted spelling resolves. */
export function folded(name: string): string {
  return [...name.normalize("NFKC").toLowerCase()].map(character => LATINISED[character] ?? character).join("");
}

async function scriptNames(cwd: string): Promise<string[]> {
  try {
    const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as
      { scripts?: Record<string, unknown> };
    return Object.keys(manifest.scripts ?? {});
  } catch { return []; }
}

async function tsconfigNames(cwd: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 2 || found.length >= MAX_NAMES) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= MAX_NAMES) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isFile() && /^tsconfig(\..+)?\.json$/u.test(entry.name)) found.push(path);
      else if (entry.isDirectory()) await walk(join(directory, entry.name), path, depth + 1);
    }
  };
  await walk(cwd, "", 0);
  return found;
}

async function hasWorkspacePython(cwd: string): Promise<boolean> {
  const path = join(cwd, ".venv/bin/python");
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch { return false; }
}

/** The note, or nothing. Names are listed as they are, never guessed at. */
export async function discoveryNote(cwd: string, output: string): Promise<string | undefined> {
  const want = wanted(output);
  if (!want) return undefined;
  // These are the commands nekopi promises exist, so a shell that cannot
  // find one is answered by name. Folding catches the lookalike; the
  // comparison is against what the glyphs spell, never a near miss, because
  // naming a command the user did not type is a guess.
  if (want.kind === "command") {
    if ((want.named === "python" || want.named === "pytest")
      && /(?:^|\n)(?:\/bin\/)?bash: line \d+: (?:python|pytest): command not found(?:\r?\n|$)/u.test(output)
      && await hasWorkspacePython(cwd)) {
      return "Executable Python found at ./.venv/bin/python. Try a focused test with "
        + "./.venv/bin/python -m pytest -q path/to/test_file.py::test_name.";
    }
    const asked = folded(want.named);
    if (asked !== "nek" && asked !== "nekocli" && asked !== "nekopi") return undefined;
    if (want.named.toLowerCase() === asked) return undefined;
    return `The command is ${JSON.stringify(asked)}. ${JSON.stringify(want.named)} as typed`
      + " spells it with a letter from another alphabet.";
  }
  const names = want.kind === "script" ? await scriptNames(cwd) : await tsconfigNames(cwd);
  if (!names.length) return undefined;
  const subject = want.kind === "script" ? "package.json scripts" : "TypeScript configs in this tree";
  const shown = names.slice(0, MAX_NAMES);
  const note = `This project's ${subject}: ${shown.join(", ")}`
    + `${names.length > shown.length ? `, and ${names.length - shown.length} more` : ""}.`;
  return Buffer.byteLength(note) > MAX_NOTE_BYTES ? undefined : note;
}

/** Appended to a failed native bash result, and to nothing else. */
export async function discoveryFeedback(event: ToolResultEvent, cwd: string):
Promise<ToolResultEventResult | undefined> {
  const result = event.structuredContent;
  if (event.toolName !== "bash" || typeof result !== "object" || result === null) return undefined;
  const { output, exit_code: code } = result as { output?: unknown; exit_code?: unknown };
  if (typeof output !== "string" || !Number.isSafeInteger(code) || code === 0) return undefined;
  const note = await discoveryNote(cwd, output);
  if (!note) return undefined;
  return { content: [...event.content, { type: "text" as const, text: note }],
    structuredContent: event.structuredContent };
}
