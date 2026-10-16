/** Source operations exposed through one shell command. */
import { constants } from "node:fs";
import { access, writeFile, mkdir, readFile, realpath, stat, lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { COMMANDS, COMMAND_NAMES, usage } from "./tools/commands.ts";
import { askMarker, MAX_ASK_BYTES } from "./tools/bash/ask-bridge.ts";
import { MAX_QUERY_BYTES } from "./tools/web.ts";
import { IMAGE_HELP, MAX_INPUTS, MAX_PROMPT_BYTES } from "./tools/image.ts";
import { applyPatch } from "./tools/patch.ts";
import { findFiles } from "./tools/find/core.ts";
import { search, SEARCH_PATH_LIMIT } from "./tools/search/core.ts";
import { declarationsOf, describeDeclarations } from "./tools/read/declarations.ts";
import { cliRangeLimits } from "./tools/read/cli-budget.ts";
import { cliText as cliReadText, readSmallText, readTextSelection } from "./tools/read/cli-text.ts";
import { imageReadMarker } from "./tools/bash/image-bridge.ts";
import { inside, resolveInside } from "./tools/workspace-path.ts";

export { envelopeFiles } from "./tools/patch.ts";

/** Long enough for a cold language server, short enough to fail a hung one. */
const TIMEOUT_MS = 120_000;

const USAGE = usage();

interface Result { text: string; failed?: boolean }

/** Parse once, preserving option values and everything after the end marker. */
function flags(argv: string[], command: string) {
  const definition = COMMANDS.find(one => one.name === command);
  const options: Array<{ flag: string; value?: string }> = [];

  // Web takes unparsed query text, not command options.
  if (definition && command !== "web") {
    let kept = 0;
    for (let index = 0; index < argv.length; index++) {
      const argument = argv[index]!;
      if (argument === "--") {
        while (++index < argv.length) argv[kept++] = argv[index]!;
        break;
      }
      if (argument === "-" || !argument.startsWith("-")) { argv[kept++] = argument; continue; }
      if (!definition.flags?.includes(argument)) {
        const hint = command === "grep" ? "Use -e PATTERN or -- for a pattern that starts with \"-\"."
          : "Use -- before paths or text that start with \"-\".";
        throw new Error(`${command}: ${command === "grep" ? "unknown option" : "unexpected argument"} ${JSON.stringify(argument)}. ${hint}`);
      }
      if (definition.valueFlags?.includes(argument)) {
        const value = argv[++index];
        if (value === undefined) throw new Error(`${argument} needs a value`);
        options.push({ flag: argument, value });
      } else options.push({ flag: argument });
    }
    argv.length = kept;
  }
  const values = (name: string, short?: string): string[] => options
    .filter(option => option.flag === `--${name}` || option.flag === short).map(option => option.value!);
  const value = (name: string): string | undefined => {
    const found = values(name);
    if (found.length > 1) throw new Error(`--${name} takes one value`);
    return found[0];
  };
  const present = (...names: string[]): boolean => names.some(name =>
    options.some(option => option.flag === (name.length === 1 ? `-${name}` : `--${name}`)));
  const count = (name: string): number | undefined => {
    const text = value(name);
    if (text === undefined) return undefined;
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`--${name} takes a whole number`);
    return parsed;
  };
  return { value, values, present, count };
}

function positionals(command: string, argv: string[], maximum: number): void {
  const unexpected = argv[maximum];
  if (unexpected !== undefined) throw new Error(`${command}: unexpected argument ${JSON.stringify(unexpected)}`);
}

/** Inclusive line spans, as `12-40` or `12-40,80-95`. */
function spans(text: string): Array<{ start: number; end: number }> {
  return text.split(",").map(part => {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/u.exec(part);
    const start = Number(match?.[1]), end = match?.[2] === undefined ? start : Number(match[2]);
    if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
      throw new Error(`--lines takes inclusive spans such as 12-40 or 12-40,80-95, not ${JSON.stringify(part)}`);
    }
    return { start, end };
  });
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? []).flatMap(block => block.type === "text" && block.text ? [block.text] : []).join("\n");
}

/** Whatever was piped in, read the same way under Bun and node. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** Preserve valid search roots while reporting missing ones. */
async function missingPaths(cwd: string, paths: readonly string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const path of paths) {
    const at = resolve(cwd, path);
    if (!(await stat(at).catch(() => undefined))) missing.push(path);
  }
  return missing;
}

/** How long a redirect on a failed call may take. */
const REDIRECT_MS = 10_000;

/** Suggest matching basenames after a path lookup fails. */
async function nearestPaths(cwd: string, path: string): Promise<string[]> {
  const name = path.split("/").filter(Boolean).pop();
  if (!name) return [];
  try {
    const found = textOf(await findFiles(cwd, { pattern: name, limit: 4 }, {}, AbortSignal.timeout(REDIRECT_MS)));
    return found.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("No "));
  } catch { return []; }
}

export async function runNekocli(argv: string[], cwd = process.cwd(),
  stdin: () => Promise<string> = readStdin): Promise<Result> {
  const named = argv[0];
  const prefixed = (text: string) =>
    !named || !COMMAND_NAMES.includes(named) || text.startsWith(`${named}: `)
      || text.startsWith(`${named} `) ? text : `${named}: ${text}`;
  try {
    const result = await dispatch(argv, cwd, stdin);
    // Returned failures need the same command prefix as thrown errors.
    return result.failed ? { ...result, text: prefixed(result.text) } : result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const renamed = prefixed(message);
    if (renamed === message) throw error;
    throw new Error(renamed, { cause: error });
  }
}

async function dispatch(argv: string[], cwd: string,
  stdin: () => Promise<string>): Promise<Result> {
  const rest = [...argv];
  const command = rest.shift();
  if (!command || command === "--help" || command === "-h" || command === "help") return { text: USAGE };
  const { value, values, present, count } = flags(rest, command);

  if (command === "grep") {
    const globs = values("glob", "-g"), context = count("context"), limit = count("limit");
    const files = present("files"), ignoreCase = present("i", "ignore-case");
    const fixed = present("F", "fixed");
    const patterns = values("regexp", "-e");
    if (patterns.length > 1) throw new Error("grep takes one pattern; combine alternatives as 'a|b'");
    const [pattern, ...paths] = patterns.length ? [patterns[0]!, ...rest] : rest;
    if (!pattern) throw new Error("grep needs a pattern. nekocli --help");
    if (context !== undefined && context > 20) throw new Error("grep: --context accepts 0-20 lines");
    if (paths.length > SEARCH_PATH_LIMIT) {
      throw new Error(`too many paths (${paths.length}; maximum ${SEARCH_PATH_LIMIT}). Search a parent directory with --glob, or split the call.`);
    }
    if (Buffer.byteLength(JSON.stringify({ pattern, paths, globs })) > 64 * 1024) {
      throw new Error("search input exceeds 64 KiB. Narrow the paths or pattern.");
    }
    const absent = await missingPaths(cwd, paths);
    const near = absent.length ? (await Promise.all(absent.slice(0, 4).map(path => nearestPaths(cwd, path)))).flat() : [];
    const missingText = absent.length ? `no such path: ${absent.slice(0, 4).join(", ")}`
      + (absent.length > 4 ? `, and ${absent.length - 4} more` : "") + "."
      + (near.length ? ` Did you mean ${[...new Set(near)].slice(0, 4).join(", ")}?` : "") : "";
    const encoded = Buffer.from(missingText);
    const missing = encoded.length > 900 ? `${encoded.subarray(0, 850).toString("utf8")}… (path list clipped)` : missingText;
    const existing = paths.filter(path => !absent.includes(path));
    if (absent.length && !existing.length) throw new Error(missing);
    // Reserve space for the incomplete-scope notice without relaxing the
    // search tool's 50 KiB output cap.
    const result = await search(cwd, {
      pattern,
      ...(existing.length ? { path: existing.length === 1 ? existing[0] : existing } : {}),
      ...(globs.length ? { glob: globs.length === 1 ? globs[0]! : globs } : {}),
      ...(context === undefined ? {} : { context }),
      ...(limit === undefined ? {} : { limit }),
      ...(files ? { outputMode: "files" as const } : {}), ...(ignoreCase ? { ignoreCase: true } : {}),
      ...(fixed ? { literal: true } : {}),
    }, absent.length ? { maxOutputBytes: 49 * 1024 } : {}, AbortSignal.timeout(TIMEOUT_MS));
    let text = textOf(result).replace(
      /(^Incomplete: [^\n]*), or use outputMode: files\.$/mu,
      "$1, or use --files.");
    if (result.isError && !fixed && result.details.errors.some(error => error.includes("regex parse error"))) {
      text += "\nUse -F or --fixed for literal text; otherwise escape regex punctuation.";
    }
    if (absent.length) {
      text = text.replace(/^No matches found\.$/mu, "No matches found in existing paths.");
      text += `\nIncomplete: ${missing}`;
    }
    // A search that could not run is not a search that found nothing, and
    // exiting 0 let a chained command run on as though it had.
    return result.isError || absent.length ? { text, failed: true } : { text };
  }

  if (command === "find") {
    const limit = count("limit");
    positionals(command, rest, 2);
    const [pattern, path] = rest;
    if (!pattern) throw new Error("find needs a glob. nekocli --help");
    const gone = await missingPaths(cwd, path ? [path] : []);
    if (gone.length) {
      const near = await nearestPaths(cwd, gone[0]!);
      throw new Error(`no such path: ${gone[0]}.`
        + (near.length ? ` Did you mean ${near.slice(0, 4).join(", ")}?` : ""));
    }
    const result = await findFiles(cwd,
      { pattern, ...(path ? { path } : {}), ...(limit === undefined ? {} : { limit }) },
      {}, AbortSignal.timeout(TIMEOUT_MS));
    return result.isError ? { text: textOf(result), failed: true } : { text: textOf(result) };
  }

  if (command === "read") {
    const lines = value("lines"), symbol = value("symbol"), limit = count("limit");
    positionals(command, rest, 1);
    const [path] = rest;
    if (lines !== undefined && symbol !== undefined) {
      throw new Error("--lines and --symbol select source differently; use one of them");
    }
    // Resolve bare names through syntax, without a language server.
    if (!path && symbol !== undefined) {
      const found = await declarationsOf(cwd, symbol, AbortSignal.timeout(TIMEOUT_MS));
      if (found.declared.length !== 1 || found.incomplete) return { text: describeDeclarations(symbol, found),
        ...(found.failed ? { failed: true } : {}) };
      const only = found.declared[0]!;
      const prefix = `${describeDeclarations(symbol, found)}\n\n`;
      const input = { path: only.path, symbol };
      const result = await readTextSelection(cwd, input, prefix)
        ?? await (await import("./tools/read.ts")).readSelection(cwd, {}, cliRangeLimits(only.path, prefix))(
          input, AbortSignal.timeout(TIMEOUT_MS), { cwd });
      return { text: await cliReadText(result, only.path, prefix) };
    }
    if (!path) throw new Error("read needs a file, or --symbol with a name. nekocli --help");
    try {
      if (lines !== undefined || symbol !== undefined) {
        const input = { path,
          ...(symbol === undefined ? {} : { symbol }), ...(lines === undefined ? {} : { ranges: spans(lines) }),
        };
        const result = await readTextSelection(cwd, input)
          ?? await (await import("./tools/read.ts")).readSelection(cwd, {}, cliRangeLimits(path))(
            input, AbortSignal.timeout(TIMEOUT_MS), { cwd });
        return { text: await cliReadText(result, path) };
      }
      if (limit === undefined) {
        const small = await readSmallText(cwd, path);
        if (small) return { text: await cliReadText(small, path) };
      }
      const { createReadBufferTool } = await import("./tools/read.ts");
      const result = await createReadBufferTool(cwd).execute("nekocli",
        { path, lineNumbers: true, ...(limit === undefined ? {} : { limit }) } as never,
        AbortSignal.timeout(TIMEOUT_MS), () => {}, { cwd } as never);
      const body = await cliReadText(result, path);
      const bridge = await imageReadMarker(result);
      return { text: [body, bridge.note, bridge.marker].filter(Boolean).join("\n") };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const miss = /No symbol "([^"]+)" in /u.exec(message);
      // A same-file suggestion does not rule out an exact declaration in
      // another file. Keep that suggestion only when a complete search finds
      // no exact declaration; a limited or failed search must say so.
      if (miss) {
        const found = await declarationsOf(cwd, miss[1]!, AbortSignal.timeout(REDIRECT_MS));
        if (found.declared.length) throw new Error(describeDeclarations(miss[1]!, found), { cause: error });
        if (found.incomplete || !message.includes("Did you mean")) {
          throw new Error(`${message}\n${describeDeclarations(miss[1]!, found)}`, { cause: error });
        }
      }
      if (!/ENOENT|no such file/u.test(message)) throw error;
      const near = await nearestPaths(cwd, path);
      if (!near.length) throw error;
      throw new Error(`${message}\nFiles with that name: ${near.join(", ")}`, { cause: error });
    }
  }

  if (command === "patch") {
    const check = present("check", "n", "dry-run");
    positionals(command, rest, 0);
    return applyPatch(cwd, await stdin(), check);
  }

  if (command === "edit") {
    positionals(command, rest, 1);
    const [path] = rest;
    if (!path) throw new Error("edit needs a file, and a JSON array on stdin. nekocli --help");
    const piped = (await stdin()).trim();

    if (!piped) throw new Error("edit reads [{\"oldText\": \"...\", \"newText\": \"...\"}] on stdin");
    let parsed: unknown;
    try { parsed = JSON.parse(piped); }
    catch { throw new Error("edit could not parse its stdin as JSON. Use patch for a unified diff"); }
    const edits = Array.isArray(parsed) ? parsed : [parsed];
    if (!await resolveInside(cwd, path)) {
      throw new Error("edit needs a workspace-relative path to a file inside the workspace");
    }
    const absolute = resolve(cwd, path);
    const { createEditRecoveryTool } = await import("./tools/edit.ts");
    const tool = createEditRecoveryTool(cwd, {
      access(actual) {
        // Native edit expands @, ~ and Unicode spaces. Never validate one path
        // and then let that expansion mutate a different file.
        if (actual !== absolute) throw new Error("edit needs a literal path inside the workspace");
        return access(actual, constants.R_OK | constants.W_OK);
      },
      readFile: path => readFile(path),
      writeFile: (path, text) => writeFile(path, text, "utf8"),
    });
    return { text: textOf(await tool.execute("nekocli", { path, edits } as never,
      AbortSignal.timeout(TIMEOUT_MS), () => {}, { cwd } as never)) };
  }

  if (command === "write") {
    positionals(command, rest, 1);
    const [path] = rest;
    if (!path) throw new Error("write needs a file, and its contents on stdin. nekocli --help");
    // `resolveInside` resolves symlinks, which a file being created does not
    // have yet, so the containment check is on the resolved parent instead.
    const root = await realpath(resolve(cwd));
    const target = resolve(root, path);
    if (isAbsolute(path) || !inside(root, target)) {
      throw new Error("write needs a workspace-relative path inside the workspace");
    }
    const contents = await stdin();
    let existing = dirname(target);
    while (!(await lstat(existing).catch(() => undefined))) existing = dirname(existing);
    if (!inside(root, await realpath(existing))) {
      throw new Error("write needs a path inside the workspace");
    }
    await mkdir(dirname(target), { recursive: true });
    const parent = await realpath(dirname(target));
    if (!inside(root, parent)) throw new Error("write needs a path inside the workspace");
    // O_NOFOLLOW also covers a symlink substituted after the parent check.
    const handle = await open(target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
    try { await handle.writeFile(contents, "utf8"); }
    finally { await handle.close(); }
    return { text: `Wrote ${relative(root, target)} (${Buffer.byteLength(contents)} bytes)` };
  }

  if (command === "web") {
    // Joined rather than taken as one positional, so an unquoted question works.
    const query = rest.join(" ").trim();
    if (!query) throw new Error("web needs a query. nekocli --help");
    if (Buffer.byteLength(query) > MAX_QUERY_BYTES) {
      throw new Error(`web query exceeds ${MAX_QUERY_BYTES} bytes. Ask one question.`);
    }
    const marker = askMarker("web", query);
    // The session answers the marker. Without one the tool is off, which is a
    // configuration fact rather than a failure of the query.
    if (!marker) return { text: "web search is off. Set web.enabled in nekopi.json and /reload.", failed: true };
    return { text: marker };
  }

  if (command === "image") {
    if (present("help", "h")) return { text: IMAGE_HELP };
    const status = value("status"), cancel = value("cancel");
    if (status !== undefined || cancel !== undefined) {
      if (status !== undefined && cancel !== undefined) throw new Error("image: use --status or --cancel, not both.");
      if (present("out", "from")) throw new Error("image: --status and --cancel do not accept --out or --from.");
      positionals("image", rest, 0);
      const id = (status ?? cancel)!;
      if (!/^image-[\w-]{1,80}$/u.test(id)) throw new Error("image: invalid job ID.");
      const marker = askMarker("image", JSON.stringify({ action: status !== undefined ? "status" : "cancel", id }));
      return marker ? { text: marker }
        : { text: "image is off. Set image.enabled in nekopi.json and /reload.", failed: true };
    }
    const out = value("out"), from = values("from");

    const prompt = rest.join(" ").trim();
    if (!prompt) throw new Error("image needs a prompt. nekocli --help");
    if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
      throw new Error(`image prompt exceeds ${MAX_PROMPT_BYTES} bytes.`);
    }
    if (!out) throw new Error("image needs --out PATH, which must be a new file inside the workspace.");
    if (from.length > MAX_INPUTS) throw new Error(`image --from accepts up to ${MAX_INPUTS} input images.`);
    const request = JSON.stringify({ prompt, out, ...(from.length ? { from } : {}) });
    if (Buffer.byteLength(request) > MAX_ASK_BYTES) {
      throw new Error(`image request exceeds ${MAX_ASK_BYTES} bytes. Use shorter paths or a shorter prompt.`);
    }
    const marker = askMarker("image", request);
    if (!marker) return { text: "image is off. Set image.enabled in nekopi.json and /reload.", failed: true };
    return { text: marker };
  }

  throw new Error(`unknown command ${JSON.stringify(command)}. Commands: ${COMMAND_NAMES.join(", ")}`);
}
