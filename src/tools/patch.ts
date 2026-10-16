/** Unified diffs and patch envelopes, with preflight checks before writes. */
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import { describe as describeUnplaced, placeAnyEnding, splice } from "./patch/placement.ts";
import { introducedSyntaxErrors } from "./syntax/regression.ts";
import { inside, resolveInside } from "./workspace-path.ts";

interface PatchResult { text: string; failed?: boolean }

/** Explain the two raw diff syntax mistakes seen in saved failed calls. */
function rawPatchFailure(diff: string, message: string): string {
  if (!/No valid patches in input|corrupt patch at line/u.test(message)
    || !/^--- .+/mu.test(diff) || !/^\+\+\+ .+/mu.test(diff)) return message;
  const notes: string[] = [];
  if (/^@@[ \t\r]*$/mu.test(diff)) {
    notes.push("patch: A unified diff needs a numbered header such as @@ -1,1 +1,1 @@."
      + " For bare @@, use a complete *** Begin Patch envelope.");
  }
  if (/^\*\*\* End Patch[ \t\r]*$/mu.test(diff)) {
    notes.push("patch: Remove *** End Patch from a unified diff; it belongs only in a complete"
      + " *** Begin Patch envelope.");
  }
  return notes.length ? `${message}\n${notes.join("\n")}` : message;
}

/** Apply unified diffs directly; envelopes are validated and converted first. */
export async function applyPatch(cwd: string, diff: string, check = false): Promise<PatchResult> {
  if (!diff.trim()) throw new Error("patch reads a unified diff on stdin");
  const envelope = envelopeFiles(diff);
  if (envelope) return applyEnvelope(cwd, envelope, check);
  const directory = await mkdtemp(join(tmpdir(), "nekocli-patch-"));
  const scratch = join(directory, "input.diff");
  try {
    await writeFile(scratch, diff.endsWith("\n") ? diff : `${diff}\n`, "utf8");

    const run = (extra: string[]) => new Promise<[string, string, number]>(done => {
      execFile("git", ["apply", "--verbose", ...extra, scratch], { cwd, maxBuffer: 8 * 1024 * 1024 },
        (error, out, err) => done([out, err, error ? Number((error as { code?: number }).code ?? 1) : 0]));
    });
    // Git writes its verbose report to stderr.
    const [firstOut, firstErr, firstCode] = await run(check ? ["--check"] : []);
    if (firstCode === 0) {
      return { text: check ? `Would apply:\n${changed(firstOut + firstErr)}` : changed(firstOut + firstErr) };
    }
    if (check) return { text: rawPatchFailure(diff, firstErr.trim() || firstOut.trim() || "would not apply"),
      failed: true };
    // Preflight --3way: Git may report conflicts even when --check exits zero.
    // Keep --recount last; relaxed hunk boundaries can misread multi-file diffs.
    const [mergeOut, mergeErr, mergeCode] = await run(["--3way", "--check"]);
    const mergeConflicts = /\bwith conflicts\b/iu.test(mergeOut + mergeErr);
    if (mergeCode === 0 && !mergeConflicts) {
      const [out, error, code] = await run(["--3way"]);
      if (code === 0) return { text: `${changed(out + error)}\n(applied with a three-way merge; context had moved)` };
    }
    const [out, error, code] = await run(["--recount"]);
    if (code === 0) return { text: `${changed(out + error)}\n(applied after recounting the hunk headers)` };
    // The initial error retains the failed context; retries often report only index/count issues.
    return { text: rawPatchFailure(diff, firstErr.trim() || firstOut.trim() || `git apply exited ${firstCode}`),
      failed: true };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

interface EnvelopeFile { path: string; action: "update" | "add" | "delete";
  hunks: Array<{ oldText: string; newText: string; atLine?: number }> }

interface FileChange { before: string; after: string }

/** Parse envelope hunks; return undefined for ordinary unified diffs. */
export function envelopeFiles(text: string): EnvelopeFile[] | undefined {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  if (!lines.some(line => line.trim() === "*** Begin Patch")) return undefined;
  const files: EnvelopeFile[] = [];
  let file: EnvelopeFile | undefined, old: string[] | undefined, fresh: string[] | undefined;
  let anchor: number | undefined, started = false, ended = false;
  const invalid = (line: string, number: number): never => {
    throw new Error(`invalid patch envelope at line ${number}: ${JSON.stringify(line.slice(0, 120))}`);
  };
  const closeHunk = () => {
    if (file && old !== undefined && fresh !== undefined && (old.length || fresh.length)) {
      file.hunks.push({ oldText: old.join("\n"), newText: fresh.join("\n"),
        ...(anchor === undefined ? {} : { atLine: anchor }) });
    }
    old = undefined; fresh = undefined; anchor = undefined;
  };
  for (const [index, line] of lines.entries()) {
    if (!started) {
      if (!line) continue;
      if (line.trim() !== "*** Begin Patch") return invalid(line, index + 1);
      started = true;
      continue;
    }
    if (ended) {
      if (line.trim() === "*** Begin Patch") {
        file = undefined;
        ended = false;
        continue;
      }
      if (line) return invalid(line, index + 1);
      continue;
    }
    if (line.trim() === "*** End Patch") {
      closeHunk();
      ended = true;
      continue;
    }
    const header = /^\*\*\* (Update|Add|Delete) File: (.+?)\s*$/u.exec(line);
    if (header) {
      closeHunk();
      file = { path: header[2]!, action: header[1]!.toLowerCase() as EnvelopeFile["action"], hunks: [] };
      files.push(file);
      // An added file has no hunk marker of its own; its `+` lines follow.
      if (file.action !== "update") { old = []; fresh = []; }
      continue;
    }
    if (!file || line.startsWith("***")) return invalid(line, index + 1);
    if (line.startsWith("@@")) {
      if (file.action !== "update") return invalid(line, index + 1);
      closeHunk();
      // `@@ 246`, and the `-246` of a real unified header, both say where the
      // hunk starts. Anything else after `@@` is a function name, as git
      // writes it, and carries no line number.
      const stated = /^@@\s*-?(\d+)/u.exec(line);
      anchor = stated ? Number(stated[1]) : undefined;
      old = []; fresh = []; continue;
    }
    if (old === undefined || fresh === undefined || file.action === "delete") return invalid(line, index + 1);
    if (line.startsWith("-")) {
      if (file.action === "add") return invalid(line, index + 1);
      old.push(line.slice(1));
    }
    else if (line.startsWith("+")) fresh.push(line.slice(1));
    else if (line.startsWith(" ") && file.action === "update") {
      old.push(line.slice(1)); fresh.push(line.slice(1));
    } else return invalid(line, index + 1);
  }
  if (!ended || !files.length || files.some(file => file.action === "add" && !file.hunks.length)) {
    throw new Error("invalid patch envelope: expected file changes and *** End Patch");
  }
  return files;
}

/** Resolve every hunk before constructing the combined Git patch. */
async function checkEnvelope(cwd: string, files: EnvelopeFile[]):
Promise<{ notes: string[]; failures: string[]; writes: Map<string, FileChange> }> {
  const notes: string[] = [], failures: string[] = [];
  const writes = new Map<string, FileChange>();
  const root = await realpath(resolve(cwd));
  const seen = new Set<string>();
  for (const file of files) {
    const target = resolve(root, file.path);
    if (isAbsolute(file.path) || !inside(root, target)) {
      failures.push(`${file.path}: path must stay inside the workspace`); continue;
    }
    if (seen.has(target)) { failures.push(`${file.path}: file appears more than once`); continue; }
    seen.add(target);
    if (file.action === "add") {
      if (await lstat(target).catch(() => undefined)) {
        failures.push(`${file.path}: file already exists`); continue;
      }
      let parent = dirname(target);
      while (!(await lstat(parent).catch(() => undefined))) parent = dirname(parent);
      const realParent = await realpath(parent);
      if (!inside(root, realParent)) {
        failures.push(`${file.path}: path must stay inside the workspace`); continue;
      }
      const contents = file.hunks.map(hunk => hunk.newText).join("\n");
      writes.set(file.path, { before: "", after: contents.endsWith("\n") ? contents : `${contents}\n` });
      notes.push(`add ${file.path}`);
      continue;
    }
    const existing = await resolveInside(root, file.path);
    if (!existing || !(await stat(existing.absolute).catch(() => undefined))?.isFile()) {
      failures.push(`${file.path}: no regular file inside the workspace`); continue;
    }
    const source = await readFile(existing.absolute, "utf8");
    if (file.action === "delete") {
      writes.set(file.path, { before: source, after: "" });
      notes.push(`delete ${file.path}`);
      continue;
    }
    if (!file.hunks.length) { failures.push(`${file.path} has no hunks`); continue; }
    const { placed, unplaced } = placeAnyEnding(source, file.hunks);
    if (!placed) { failures.push(...describeUnplaced(file.path, unplaced)); continue; }
    const lines = placed.map(one => one.line);
    writes.set(file.path, { before: source, after: splice(source, placed) });
    notes.push(`${file.path}: ${placed.length} hunk(s) placed at line ${lines.join(", ")}`);
  }
  return { notes, failures, writes };
}

async function applyEnvelope(cwd: string, files: EnvelopeFile[], check = false): Promise<PatchResult> {
  const { notes, failures, writes } = await checkEnvelope(cwd, files);
  if (failures.length) {
    const count = failures.length === 1 ? "1 hunk" : `${failures.length} hunks`;
    return { text: `Nothing was applied. ${count} could not be placed:\n${failures.join("\n")}`, failed: true };
  }
  // Git checks every generated file patch before writing any of them. The
  // same check covers both --check and apply, including adds and deletes.
  const diff = files.map(file => {
    const planned = writes.get(file.path)!;
    // A content-only diff has no hunks for an empty file. Git needs an explicit
    // deletion header so this still participates in its atomic apply/check.
    if (file.action === "delete" && !planned.before) {
      return `diff --git ${JSON.stringify(`a/${file.path}`)} ${JSON.stringify(`b/${file.path}`)}\ndeleted file mode 100644\n`;
    }
    return createTwoFilesPatch(file.action === "add" ? "/dev/null" : `a/${file.path}`,
      file.action === "delete" ? "/dev/null" : `b/${file.path}`, planned.before, planned.after);
  }).join("");
  const applied = await applyPatch(cwd, diff, check);
  if (applied.failed) return applied;
  const warnings: string[] = [];
  if (!check) {
    for (const file of files.slice(0, 8)) {
      if (file.action === "delete") continue;
      const target = await resolveInside(cwd, file.path).catch(() => undefined);
      if (!target) continue;
      const after = await readFile(target.absolute, "utf8").catch(() => undefined);
      if (after === undefined) continue;
      const issue = await introducedSyntaxErrors(file.path, writes.get(file.path)!.before, after);
      if (issue) warnings.push(`${file.path}${issue.firstLine ? `:${issue.firstLine}` : ""}:`
        + ` ${issue.count} new parser error(s). Run the language checker before finishing.`);
    }
  }
  return { text: `${check ? "Would apply" : `Patched ${files.length} file(s)`}:\n${notes.join("\n")}`
    + (warnings.length ? `\nSyntax check: ${warnings.join("\n")}` : "") };
}

/** `git apply --verbose` narrates every step; only the files it touched matter. */
function changed(out: string): string {
  const applied = [...out.matchAll(/^Applied patch (.+?) cleanly\.$/gmu)].map(match => match[1]!);
  if (applied.length) return `Patched ${applied.length} file(s):\n${applied.join("\n")}`;
  // `--check` applies nothing, so it narrates only what it inspected.
  const checked = [...out.matchAll(/^Checking patch (.+?)\.\.\.$/gmu)].map(match => match[1]!);
  if (checked.length) return `${checked.length} file(s):\n${checked.join("\n")}`;
  return out.trim() || "Patched.";
}
