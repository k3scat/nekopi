import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";

type Runner = "cargo" | "pytest" | "node" | "bun" | "jest" | "go" | "vitest" | "script";
interface Counts { executed: number; failed: number; skipped: number; filtered: number }
interface ReportedVerification extends Counts {
  runner: Runner;
  status: "no_tests_reported" | "tests_reported" | "tests_failed" | "collection_blocked";
  summaries: number;
  /**
   * Whether the whole command's exit status is this runner's.
   *
   * Recorded because a chain's status can belong to a later segment, and a
   * reviewer reading a saved result needs to know which it was.
   */
  ownsExitStatus: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Listing and compile-only flags verify nothing, whichever segment carries one. */
const LISTING = /(?:^|\s)--(?:collect-only|co|list|listTests|test-list-tests|no-run)(?:\s|=|$)/u;

/**
 * A command's segments, or nothing when its structure cannot be read.
 *
 * Splits on `&&`, `||` and `;` outside quotes. It MUST refuse a pipeline, a
 * background `&`, a redirection, a heredoc, a subshell, a command
 * substitution and an unbalanced quote: each one either hides the output a
 * summary is parsed from, or decides the exit status somewhere this cannot
 * see. `$VAR` is kept, because an expansion cannot introduce an operator.
 *
 * A `\"` inside double quotes ends the quote one character early here, which
 * is wrong. It is left wrong because the result is a segment that no runner
 * pattern matches, so the command reports nothing rather than reporting
 * something false, and no scored stream has contained one.
 *
 * Chained commands are the point. `NEKOCLI_GUIDANCE` tells the model to chain
 * an edit with its test, and a blanket character guard refused every such
 * call. Across the three 2026-10-13 full draws, 111 of the 229 readable calls
 * that run a test runner are chains, so most test runs went unread by the one
 * mechanism that reports a test which verified nothing.
 */
function segments(command: string): string[] | undefined {
  const parts: string[] = [];
  let current = "", quote: string | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote) {
      if (character === quote) quote = undefined;
      current += character;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; current += character; continue; }
    if (character === "\\" && index + 1 < command.length) { current += command.slice(index, index + 2); index += 1; continue; }
    // Two-character operators are tested first, so `&&` is not read as `&`.
    if (command.startsWith("&&", index) || command.startsWith("||", index)) { parts.push(current); current = ""; index += 1; continue; }
    if (character === ";") { parts.push(current); current = ""; continue; }
    if (character === "$" && command[index + 1] === "(") return;
    if (character === "\n" || character === "\r" || character === "&" || "|<>`()".includes(character)) return;
    current += character;
  }
  if (quote) return;
  parts.push(current);
  const trimmed = parts.map(part => part.trim()).filter(Boolean);
  return trimmed.length ? trimmed : undefined;
}

/** One invocation, with its leading environment assignments removed. */
function runner(segment: string): Runner | undefined {
  const invocation = segment.replace(/^env\s+/, "").replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^'\\]*'|"[^"\\]*"|[^\s'"\\]+)\s+)*/, "",
  );
  if (/^cargo(?:\s+\+\S+)?\s+test(?:\s|$)/u.test(invocation)) return "cargo";
  if (/^(?:(?:uv\s+run\s+)?(?:python[\d.]*\s+-m\s+)?pytest)(?:\s|$)/u.test(invocation)) return "pytest";
  if (/^go(?:\s+-\S+)*\s+test(?:\s|$)/u.test(invocation)) return "go";
  if (/^(?:npx\s+|pnpm\s+(?:exec\s+|dlx\s+)?|yarn\s+(?:exec\s+|dlx\s+)?|bunx\s+)?vitest(?:\s|$)/u.test(invocation)) return "vitest";
  if (/^node\s+--test(?:\s|=|$)/u.test(invocation)) return "node";
  if (/^bun\s+test(?:\s|$)/u.test(invocation)) return "bun";
  if (/^(?:npx\s+)?jest(?:\s|$)/u.test(invocation)) return "jest";
  // A single named Yarn workspace delegates directly to its test script.
  if (/^yarn\s+workspace\s+(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*\s+(?:run\s+)?test(?::[A-Za-z0-9:_-]+)?(?:\s|$)/u.test(invocation)) return "script";
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:[\s:]|$)/u.test(invocation)) return "script";
}

/** The runner a command chain invokes, and whether the shell status is its own. */
function invocation(command: string): { family: Runner; ownsExitStatus: boolean } | undefined {
  const parts = segments(command);
  if (!parts) return;
  const found = parts.flatMap((part, index) => {
    const family = runner(part);
    return family ? [{ family, index }] : [];
  });
  if (!found.length) return;
  // A listing flag anywhere in the test work means no behaviour was verified.
  if (found.some(({ index }) => LISTING.test(parts[index]!))) return;
  // Two runners print two summary dialects into one output, and which summary
  // belongs to which is not recoverable from the text. So neither is claimed.
  if (new Set(found.map(({ family }) => family)).size > 1) return;
  const last = found[found.length - 1]!;
  // Only a final segment owns the status. Anywhere else a later segment or a
  // short circuit decides it. A summary that parsed at all proves the runner
  // ran, so a final runner's status did reach the shell.
  return { family: last.family, ownsExitStatus: last.index === parts.length - 1 };
}

/** Observations of completed runner summaries, not proof of execution or repair acceptance. */
export function reportedVerification(command: string, output: string): ReportedVerification | undefined {
  const found = invocation(command);
  if (!found) return;
  const family = found.family;
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "").replace(/\r\n?/gu, "\n");
  const summaries: Counts[] = [];
  const add = (executed: number, failed: number, skipped = 0, filtered = 0) => {
    summaries.push({ executed, failed, skipped, filtered });
  };
  if (family === "cargo") {
    for (const match of text.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/gm)) {
      const [, passed, failed, ignored, measured, filtered] = match;
      add(Number(passed) + Number(failed) + Number(measured), Number(failed), Number(ignored), Number(filtered));
    }
  }
  if (family === "pytest") {
    for (const match of text.matchAll(/^[ \t=]*((?:\d+ (?:passed|failed|errors?|skipped|deselected|xfailed|xpassed|warnings?)(?:, )?)+) in \d+(?:\.\d+)?s[ \t=]*$/gm)) {
      let executed = 0, failed = 0, skipped = 0, filtered = 0;
      for (const item of match[1]!.matchAll(/(\d+) ([a-z]+)/g)) {
        const count = Number(item[1]), kind = item[2];
        if (["passed", "failed", "error", "errors", "xfailed", "xpassed"].includes(kind!)) executed += count;
        if (["failed", "error", "errors"].includes(kind!)) failed += count;
        if (kind === "skipped") skipped += count;
        if (kind === "deselected") filtered += count;
      }
      if (/\b(?:passed|failed|errors?|skipped|deselected|xfailed|xpassed)\b/u.test(match[1]!)) add(executed, failed, skipped, filtered);
    }
    if (!summaries.length && /^[ \t=]*no tests ran in \d+(?:\.\d+)?s[ \t=]*$/m.test(text)) add(0, 0);
    if (/^[! \t]*Interrupted: \d+ errors? during collection[! \t]*$/m.test(text)) {
      return { runner: family, status: "collection_blocked", summaries: 0,
        ownsExitStatus: found.ownsExitStatus, executed: 0, failed: 0, skipped: 0, filtered: 0 };
    }
  }
  /**
   * Go reports no counts without `-v`, so a summary is only claimed where the
   * evidence is positive: the runner saying it ran nothing, a package with no
   * test files, or per-test lines to count. An `ok` line alone proves tests
   * passed but not how many, and reporting that as zero would be a false alarm
   * on every ordinary run.
   *
   * It matters because `go test -run <names>` is how 50 of this suite's tasks
   * are scored, and a name that matches nothing prints a warning and exits 0.
   */
  if (family === "go" || family === "script") {
    const ran = [...text.matchAll(/^(?:    )?--- (PASS|FAIL|SKIP): /gmu)];
    if (ran.length) {
      add(ran.filter(m => m[1] !== "SKIP").length, ran.filter(m => m[1] === "FAIL").length,
        ran.filter(m => m[1] === "SKIP").length);
    } else if (/^testing: warning: no tests to run$/mu.test(text)
      || /\[no tests to run\]\s*$/mu.test(text)) {
      add(0, 0);
    } else if (/^\?\s+\S+\s+\[no test files\]\s*$/mu.test(text)
      && !/^(?:ok|FAIL)\s/mu.test(text)) {
      add(0, 0);
    }
  }
  if (family === "vitest" || family === "script") {
    for (const match of text.matchAll(/^[ \t]*Tests[ \t]+([^\n]*?)\((\d+)\)[ \t]*$/gmu)) {
      let executed = 0, failed = 0, skipped = 0;
      for (const item of match[1]!.matchAll(/(\d+) (passed|failed|skipped|todo)/gu)) {
        const count = Number(item[1]);
        if (item[2] === "passed" || item[2] === "failed") executed += count;
        if (item[2] === "failed") failed += count;
        if (item[2] === "skipped" || item[2] === "todo") skipped += count;
      }
      if (Number(match[2]) !== executed + skipped) return;
      add(executed, failed, skipped);
    }
    if (!summaries.length && /^[ \t]*No test files found/mu.test(text)) add(0, 0);
  }
  if (family === "node" || family === "script") {
    for (const match of text.matchAll(/^# tests (\d+)\n# suites \d+\n# pass (\d+)\n# fail (\d+)\n# cancelled (\d+)\n# skipped (\d+)\n# todo (\d+)(?:\n|$)/gm)) {
      const [, total, passed, failed, cancelled, skipped, todo] = match;
      if (Number(total) !== Number(passed) + Number(failed) + Number(cancelled) + Number(skipped) + Number(todo)) return;
      add(Number(passed) + Number(failed) + Number(cancelled), Number(failed) + Number(cancelled), Number(skipped) + Number(todo));
    }
  }
  if (family === "bun" || family === "script") {
    for (const match of text.matchAll(/^[ \t]*(\d+) pass\n(?:[ \t]*(\d+) skip\n)?(?:[ \t]*(\d+) todo\n)?[ \t]*(\d+) fail\n(?:[^\n]*\n){0,3}Ran (\d+) tests? across \d+ files?/gm)) {
      const passed = Number(match[1]), skipped = Number(match[2] ?? 0) + Number(match[3] ?? 0), failed = Number(match[4]);
      if (Number(match[5]) !== passed + failed + skipped) return;
      add(passed + failed, failed, skipped);
    }
    if (!summaries.length && /^error: No tests found!?[ \t]*$/m.test(text)) add(0, 0);
  }
  if (family === "jest" || family === "script") {
    for (const match of text.matchAll(/^Tests:[ \t]+([^\n]+)$/gm)) {
      let executed = 0, failed = 0, skipped = 0;
      for (const item of match[1]!.matchAll(/(\d+) (passed|failed|skipped|todo)/g)) {
        const count = Number(item[1]);
        if (item[2] === "passed" || item[2] === "failed") executed += count;
        if (item[2] === "failed") failed += count;
        if (item[2] === "skipped" || item[2] === "todo") skipped += count;
      }
      const total = match[1]!.match(/\b(\d+) total\b/u);
      if (!total || Number(total[1]) !== executed + skipped) return;
      add(executed, failed, skipped);
    }
    if (!summaries.length && /^No tests found, exiting with code [01][ \t]*$/m.test(text)) add(0, 0);
  }
  if (!summaries.length) return;
  const counts = summaries.reduce((total, item) => ({ executed: total.executed + item.executed,
    failed: total.failed + item.failed, skipped: total.skipped + item.skipped, filtered: total.filtered + item.filtered }),
  { executed: 0, failed: 0, skipped: 0, filtered: 0 });
  if (!Object.values(counts).every(count => Number.isSafeInteger(count) && count >= 0)) return;
  return { runner: family, summaries: summaries.length, ownsExitStatus: found.ownsExitStatus, ...counts,
    status: counts.failed ? "tests_failed" : counts.executed ? "tests_reported" : "no_tests_reported" };
}

function zeroTestFeedback(verification: ReportedVerification): string {
  const prefix = "Verification: recognized test summaries report 0 executed cases. ";
  if (verification.runner === "cargo" || verification.runner === "pytest") {
    if (verification.skipped > 0 && verification.filtered === 0) {
      return prefix + "Only skipped cases were reported. Check the skip or ignore conditions before claiming coverage.";
    }
    if (verification.runner === "cargo") {
      return prefix + "Keep the package, target and feature options; remove test-name, --exact and --skip filters; "
        + "then list available names with cargo test ... -- --list. Listing names does not verify behavior.";
    }
    return prefix + "Keep the pytest invocation environment and test paths; inspect collected names with --collect-only -q, "
      + "without -k/-m filters. If needed, broaden an exact node ID to its test file. Collection does not verify behavior.";
  }
  if (verification.runner === "go") {
    return prefix + "Keep the packages and build tags; remove the -run or -tags filter, "
      + "then list names with go test -list '.*' ./... . A name that matches nothing still exits 0.";
  }
  if (verification.runner === "vitest") {
    return prefix + "Keep the project and config options; remove -t and the file filter, "
      + "then list what is collected with vitest list. No collected file still exits 0 on some configs.";
  }
  return prefix + "Check the test names or filter before claiming coverage.";
}

/** Annotate complete native output without changing shell status or the programmatic result. */
export function verificationFeedback(event: ToolResultEvent): ToolResultEventResult | undefined {
  const result = event.structuredContent;
  if (event.toolName !== "bash" || typeof event.input.command !== "string" || !object(result)
    || typeof result.output !== "string" || result.truncated !== false
    || !Number.isSafeInteger(result.exit_code) || Buffer.byteLength(result.output) > 1_048_576
    || event.details !== undefined && !object(event.details)) return;
  const verification = reportedVerification(event.input.command, result.output);
  if (!verification) return;
  const note = verification.status === "no_tests_reported"
    ? zeroTestFeedback(verification)
    : verification.status === "collection_blocked"
      ? "Verification: test collection was interrupted. Resolve the collection error before using this run as behavioral verification."
      : verification.status === "tests_failed" && result.exit_code === 0 && verification.ownsExitStatus
        ? "Verification: test summaries report failures despite shell exit 0. Check the test script and its exit handling."
        : undefined;
  return {
    ...(note ? { content: [...event.content, { type: "text" as const, text: note }], structuredContent: event.structuredContent } : {}),
    details: { ...event.details, nekopiVerification: verification },
  };
}
