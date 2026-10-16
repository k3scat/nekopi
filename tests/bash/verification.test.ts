import { expect, test } from "bun:test";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { reportedVerification, verificationFeedback } from "../../src/tools/bash/verification.ts";

const cargo = (passed = 0, failed = 0, ignored = 0, filtered = 292) =>
  `test result: ${failed ? "FAILED" : "ok"}. ${passed} passed; ${failed} failed; ${ignored} ignored; 0 measured; ${filtered} filtered out; finished in 0.00s\n`;
const tap = "# tests 3\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 1\n";
function event(output: string, exitCode = 0): ToolResultEvent {
  return { type: "tool_result", toolCallId: "local-test", toolName: "bash", input: { command: "cargo test wrong_filter" },
    content: [{ type: "text", text: output }], details: { fullOutputPath: "/private/native-output" }, isError: exitCode !== 0,
    structuredContent: { output, exit_code: exitCode, truncated: false, wall_time_seconds: 0.1 } };
}

test("Rust wrong filters report no execution, while empty doc tests do not hide executed tests", () => {
  expect(reportedVerification("cargo test -p ty_python_semantic --test mdtest generics::pep695", cargo()))
    .toEqual({ runner: "cargo", status: "no_tests_reported", summaries: 1, ownsExitStatus: true, executed: 0, failed: 0, skipped: 0, filtered: 292 });
  expect(reportedVerification("cargo +stable test", cargo(6, 0, 2, 0) + cargo(0, 0, 0, 0)))
    .toMatchObject({ status: "tests_reported", summaries: 2, executed: 6, skipped: 2, filtered: 0 });
  expect(reportedVerification("cargo test", cargo(2, 1))).toMatchObject({ status: "tests_failed", executed: 3, failed: 1 });
});

test("pytest separates outcomes, deselection and explicit collection interruption", () => {
  expect(reportedVerification("uv run python -m pytest -q", "=== 2 passed, 1 skipped, 3 deselected, 1 xfailed, 2 warnings in 0.10s ===\n"))
    .toMatchObject({ status: "tests_reported", executed: 3, failed: 0, skipped: 1, filtered: 3 });
  expect(reportedVerification("pytest", "1 failed, 1 error in 0.20s\n"))
    .toMatchObject({ status: "tests_failed", executed: 2, failed: 2 });
  expect(reportedVerification("pytest", "no tests ran in 0.01s\n"))
    .toMatchObject({ status: "no_tests_reported", executed: 0 });
  expect(reportedVerification("pytest", "!!! Interrupted: 1 error during collection !!!\n=== 1 error in 0.12s ===\n"))
    .toMatchObject({ status: "collection_blocked", executed: 0, summaries: 0 });
  expect(reportedVerification("pytest", "2 warnings in 0.01s\n")).toBeUndefined();
  expect(reportedVerification("pytest", "test says: Interrupted: 1 error during collection\n")).toBeUndefined();
});

test("Node requires a complete consistent TAP footer", () => {
  expect(reportedVerification("node --test --test-reporter=tap", tap))
    .toMatchObject({ runner: "node", status: "tests_reported", executed: 1, skipped: 2 });
  expect(reportedVerification("npm test", tap.replace("# pass 1", "# pass 0").replace("# fail 0", "# fail 1")))
    .toMatchObject({ runner: "script", status: "tests_failed", executed: 1, failed: 1 });
  expect(reportedVerification("node --test", "# tests 0\n")).toBeUndefined();
  expect(reportedVerification("node --test", tap.replace("# tests 3", "# tests 0"))).toBeUndefined();
});

test("Bun counts skip and todo without treating them as executed", () => {
  expect(reportedVerification("bun test", " 1 pass\n 1 skip\n 1 todo\n 0 fail\nRan 3 tests across 1 file. [7.00ms]\n"))
    .toMatchObject({ status: "tests_reported", executed: 1, skipped: 2 });
  expect(reportedVerification("bun test", " 0 pass\n 2 skip\n 0 fail\nRan 2 tests across 1 file.\n"))
    .toMatchObject({ status: "no_tests_reported", executed: 0, skipped: 2 });
  expect(reportedVerification("bun test", "0 pass\n0 fail\nRan 3 tests across 1 file.\n")).toBeUndefined();
  expect(reportedVerification("bun test", "error: No tests found!\n")).toMatchObject({ status: "no_tests_reported" });
});

test("Jest uses Tests counts rather than suite counts and rejects incomplete totals", () => {
  expect(reportedVerification("npx jest", "Test Suites: 1 passed, 1 total\nTests: 2 passed, 1 skipped, 3 total\n"))
    .toMatchObject({ status: "tests_reported", executed: 2, skipped: 1 });
  expect(reportedVerification("pnpm test:unit", "Tests: 1 failed, 2 passed, 3 total\n"))
    .toMatchObject({ status: "tests_failed", executed: 3, failed: 1 });
  expect(reportedVerification("jest", "Tests: 3 total\n")).toBeUndefined();
  expect(reportedVerification("jest", "Test Suites: 0 passed, 0 total\n")).toBeUndefined();
  expect(reportedVerification("yarn test", "No tests found, exiting with code 0\n"))
    .toMatchObject({ status: "no_tests_reported" });
});

test("direct Yarn workspace test scripts recognize the saved public Proton Jest summary", () => {
  const savedSummary = `PASS src/app/store/_links/useLink.test.ts (64.696 s)
Test Suites: 1 passed, 1 total
Tests:       12 passed, 12 total
Snapshots:   0 total
Time:        65.794 s
Ran all test suites matching /src\\/app\\/store\\/_links\\/useLink.test.ts/i.
`;
  for (const command of ["yarn workspace proton-drive test src/app/store/_links/useLink.test.ts",
    "yarn workspace proton-drive run test src/app/store/_links/useLink.test.ts",
    "yarn workspace @proton/drive test:unit src/app/store/_links/useLink.test.ts",
    "env CI=1 yarn workspace @proton/drive run test:unit:ci"]) {
    expect(reportedVerification(command, savedSummary))
      .toEqual({ runner: "script", status: "tests_reported", summaries: 1, ownsExitStatus: true, executed: 12, failed: 0, skipped: 0, filtered: 0 });
  }
  const original = event(savedSummary);
  original.input.command = "yarn workspace proton-drive test src/app/store/_links/useLink.test.ts";
  expect(verificationFeedback(original)).toMatchObject({ details: { nekopiVerification: { executed: 12 } } });
  expect(verificationFeedback(original)).not.toHaveProperty("content");
});

test("Yarn workspace zero-test summaries retain feedback without accepting lists or shell wrappers", () => {
  const summary = "No tests found, exiting with code 0\n";
  const command = "yarn workspace proton-drive run test missing_test";
  expect(reportedVerification(command, summary)).toMatchObject({ runner: "script", status: "no_tests_reported", executed: 0 });
  const original = event(summary);
  original.input.command = command;
  expect(verificationFeedback(original)?.content?.[1]).toMatchObject({ text: expect.stringContaining("0 executed cases") });
  expect(original.input.command).toBe(command);
  for (const unsupported of ["yarn workspace proton-drive run lint", "yarn workspace proton-drive testing",
    "yarn workspace proton-drive exec jest", "yarn workspaces foreach --all run test", "npm --workspace proton-drive test",
    "yarn workspace --top-level test", "yarn workspace proton-drive test --listTests",
    "yarn workspace proton-drive run test --listTests=true", "yarn workspace proton-drive test -- --list",
    "yarn workspace proton-drive test --collect-only", "yarn workspace proton-drive test --no-run",
    "yarn workspace proton-drive test | tail",
    "yarn workspace proton-drive test > result.log", "bash -c 'yarn workspace proton-drive test'"])
    expect(reportedVerification(unsupported, summary)).toBeUndefined();
  // A trailing segment is read, and it takes the exit status with it.
  expect(reportedVerification("yarn workspace proton-drive run test missing_test && true", summary))
    .toMatchObject({ runner: "script", status: "no_tests_reported", ownsExitStatus: false });
});

test("simple environment assignments and ANSI output retain reported counts", () => {
  expect(reportedVerification('env CI=1 LABEL="unit tests" cargo test', `\x1b[32m${cargo()}\x1b[0m`))
    .toMatchObject({ status: "no_tests_reported" });
});

test("lists, compile-only commands, shell scripts and log readers remain unknown", () => {
  for (const command of ["cargo test -- --list", "cargo test --no-run", "pytest --collect-only", "pytest --co",
    "jest --listTests", "node --test --test-list-tests", "cat test.log", "bash run-tests.sh",
    "cargo test | tail", "cargo test > result.log", "cargo test $(echo filter)",
    // A listing flag is refused wherever in the chain it sits.
    "cd repo && cargo test --no-run", "cargo test -- --list && git diff"])
    expect(reportedVerification(command, cargo())).toBeUndefined();
  expect(reportedVerification("cargo test", "running 0 tests\n")).toBeUndefined();
  expect(reportedVerification("cargo test", "SSL certificate problem\n")).toBeUndefined();
});

test("zero-test feedback preserves original content, details, structured output and error status", () => {
  const original = event(cargo(), 5);
  const result = verificationFeedback(original)!;
  expect<unknown>(result.content?.[0]).toBe(original.content[0]);
  expect(result.content?.[1]).toMatchObject({ type: "text", text: expect.stringContaining("0 executed cases") });
  expect<unknown>(result.structuredContent).toBe(original.structuredContent);
  expect(result.details).toMatchObject({ fullOutputPath: "/private/native-output", nekopiVerification: { status: "no_tests_reported" } });
  expect(result).not.toHaveProperty("isError");
  expect(original.content).toHaveLength(1);
  expect(original.isError).toBe(true);
});

test("zero-test recovery uses runner discovery without rewriting the Bash command", () => {
  const original = event(cargo());
  original.input.command = "cargo test -p semantic --test mdtest --features typing guessed_name -- --exact";
  const result = verificationFeedback(original)!;
  const note = result.content?.[1];
  const text = note?.type === "text" ? note.text : "";
  expect(text).toContain("cargo test ... -- --list");
  expect(text).toContain("remove test-name, --exact and --skip filters");
  expect(original.input.command).toBe("cargo test -p semantic --test mdtest --features typing guessed_name -- --exact");
  expect(result).not.toHaveProperty("input");
  expect(result.details).toMatchObject({ nekopiVerification: { filtered: 292, executed: 0 } });

  const pytest = event("=== 2 deselected in 0.01s ===\n");
  pytest.input.command = "uv run python -m pytest tests/test_api.py -k missing";
  const pytestNote = verificationFeedback(pytest)?.content?.[1];
  const pytestText = pytestNote?.type === "text" ? pytestNote.text : "";
  expect(pytestText).toContain("--collect-only -q");
  expect(pytestText).toContain("without -k/-m filters");
  expect(pytestText).toContain("Collection does not verify behavior");
});

test("Cargo and pytest skipped-only results guide skip checks rather than name discovery", () => {
  const rust = event(cargo(0, 0, 2, 0));
  const pytest = event("=== 2 skipped in 0.01s ===\n");
  pytest.input.command = "pytest";
  for (const original of [rust, pytest]) {
    const result = verificationFeedback(original)!;
    expect(result.content?.[1]).toMatchObject({ text: expect.stringContaining("Check the skip or ignore conditions") });
    expect(JSON.stringify(result.content)).not.toContain("--list");
    expect(JSON.stringify(result.content)).not.toContain("--collect-only");
  }
  expect(verificationFeedback(event(cargo(0, 0, 2, 3)))?.content?.[1])
    .toMatchObject({ text: expect.stringContaining("cargo test ... -- --list") });
});

test("other runners keep generic zero-test advice because skip counts can include name filtering", () => {
  const node = event(tap.replace("# pass 1", "# pass 0").replace("# skipped 1", "# skipped 2"));
  node.input.command = "node --test --test-name-pattern=missing";
  expect(verificationFeedback(node)?.content?.[1]).toEqual({ type: "text",
    text: "Verification: recognized test summaries report 0 executed cases. Check the test names or filter before claiming coverage." });
});

test("ordinary outcomes add metadata only; hidden shell failures add feedback", () => {
  expect(verificationFeedback(event(cargo(3)))).not.toHaveProperty("content");
  expect(verificationFeedback(event(cargo(0, 1), 1))).not.toHaveProperty("content");
  const masked = verificationFeedback(event(cargo(0, 1), 0))!;
  expect(masked.content?.[1]).toMatchObject({ text: expect.stringContaining("despite shell exit 0") });
  expect(masked).not.toHaveProperty("isError");
  const blocked = event("!!! Interrupted: 1 error during collection !!!\n", 2);
  blocked.input.command = "pytest";
  expect(verificationFeedback(blocked)?.content?.[1]).toMatchObject({ text: expect.stringContaining("collection was interrupted") });
});

test("incomplete or removed structured output is never replaced by visible text", () => {
  const incomplete: ToolResultEvent["structuredContent"][] = [undefined, { output: cargo(), exit_code: 0 },
    { output: cargo(), exit_code: 0, truncated: true }, { output: cargo(), exit_code: 0.5, truncated: false }];
  for (const structuredContent of incomplete)
    expect(verificationFeedback({ ...event(cargo()), structuredContent })).toBeUndefined();
  const original = event(cargo());
  original.content = [{ type: "text", text: "[visible output truncated]" }];
  expect(verificationFeedback(original)?.content?.[1]).toMatchObject({ text: expect.stringContaining("0 executed cases") });
  expect(verificationFeedback({ ...original, details: "custom details" })).toBeUndefined();
  expect(verificationFeedback({ ...original, toolName: "other" })).toBeUndefined();
});

test("Go claims a summary only where the evidence is positive", () => {
  // 50 of the suite's tasks are scored by `go test -run <names>`, and a name
  // matching nothing prints a warning and exits 0. That is the case this
  // catches, and it is why Go was worth recognizing at all.
  expect(reportedVerification("go test -run TestNope ./...",
    "testing: warning: no tests to run\nPASS\nok \tgithub.com/x/y\t0.1s\n"))
    .toMatchObject({ runner: "go", status: "no_tests_reported", executed: 0 });
  expect(reportedVerification("go test -run TestNope ./pkg",
    "ok  \tgithub.com/x/y\t0.002s [no tests to run]\n"))
    .toMatchObject({ runner: "go", status: "no_tests_reported" });
  expect(reportedVerification("go test ./pkg", "?   \tgithub.com/x/z\t[no test files]\n"))
    .toMatchObject({ runner: "go", status: "no_tests_reported" });
  // Without -v, Go prints no counts. An `ok` line proves tests passed but not
  // how many, and claiming zero there would be a false alarm on every run.
  expect(reportedVerification("go test ./pkg/...", "ok  \tgithub.com/x/y\t0.5s\n")).toBeUndefined();
  expect(reportedVerification("go test -v ./pkg",
    "=== RUN   TestA\n--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)\n    --- SKIP: TestB/sub (0.00s)\nFAIL\n"))
    .toMatchObject({ runner: "go", status: "tests_failed", executed: 2, failed: 1, skipped: 1 });
  // A shell pipeline never has its exit status inferred.
  expect(reportedVerification("go test ./... | tee out.txt", "testing: warning: no tests to run\n")).toBeUndefined();
  // Listing names is not verifying behaviour.
  expect(reportedVerification("go test -list '.*' ./...", "TestA\nTestB\nok \tx\t0.1s\n")).toBeUndefined();
});

test("vitest counts come from the Tests line and must agree with its total", () => {
  // The other 157 suite tasks run under vitest.
  expect(reportedVerification("npx vitest run packages/runtime-core",
    " Test Files  1 passed (1)\n      Tests  3 passed (3)\n"))
    .toMatchObject({ runner: "vitest", status: "tests_reported", executed: 3, failed: 0 });
  expect(reportedVerification("npx vitest run x", "      Tests  1 failed | 2 passed (3)\n"))
    .toMatchObject({ runner: "vitest", status: "tests_failed", executed: 3, failed: 1 });
  expect(reportedVerification("npx vitest run x", "      Tests  2 passed | 1 skipped (3)\n"))
    .toMatchObject({ runner: "vitest", executed: 2, skipped: 1 });
  expect(reportedVerification("npx vitest run x", "No test files found, exiting with code 1\n"))
    .toMatchObject({ runner: "vitest", status: "no_tests_reported" });
  // A total that does not add up is not a summary this can read.
  expect(reportedVerification("npx vitest run x", "      Tests  2 passed (9)\n")).toBeUndefined();
  expect(reportedVerification("bunx vitest", "      Tests  1 passed (1)\n"))
    .toMatchObject({ runner: "vitest", executed: 1 });
});

test("the zero-test note names the filter to remove for each runner", () => {
  const note = (command: string, output: string) => {
    const result = verificationFeedback({ type: "tool_result", toolCallId: "t", toolName: "bash",
      input: { command }, content: [{ type: "text", text: output }], isError: false,
      structuredContent: { output, exit_code: 0, truncated: false, wall_time_seconds: 0.1 } } as never);
    return JSON.stringify(result?.content ?? "");
  };
  expect(note("go test -run TestNope ./...", "testing: warning: no tests to run\n")).toContain("go test -list");
  expect(note("npx vitest run x", "No test files found, exiting with code 1\n")).toContain("vitest list");
});

test("chained commands are classified, and only a final runner owns the shell status", () => {
  // Every command here is taken verbatim from the 2026-10-13 full draws.
  const noTests = "testing: warning: no tests to run\nPASS\nok \tgithub.com/x/y\t0.1s\n";
  for (const command of ["git diff --check && git diff --stat && git status --short && go test ./pkg/cmd/repo/...",
    "git diff --check && git diff -- internal/text/text.go && git status --short; go test ./internal/text",
    "cd repo && cargo test"]) {
    expect(reportedVerification(command, command.includes("cargo") ? cargo() : noTests))
      .toMatchObject({ status: "no_tests_reported", ownsExitStatus: true });
  }
  // The test runs first and another command reports after it, so the status is
  // not the runner's and the masked-failure note cannot be claimed from it.
  expect(reportedVerification("pnpm vitest run packages/reactivity/__tests__/reactiveArray.spec.ts && pnpm check",
    "      Tests  1 failed | 2 passed (3)\n"))
    .toMatchObject({ runner: "vitest", status: "tests_failed", ownsExitStatus: false });
});

test("a chain's zero-test note reaches the model, and a masked failure needs the status", () => {
  const chained = event("testing: warning: no tests to run\nPASS\nok \tgithub.com/x/y\t0.1s\n");
  chained.input.command = "git diff --check && git status --short && go test -run TestNope ./pkg/cmd/repo";
  expect(verificationFeedback(chained)?.content?.[1])
    .toMatchObject({ text: expect.stringContaining("0 executed cases") });

  const owned = event(cargo(0, 1), 0);
  owned.input.command = "git diff --check && cargo test";
  expect(verificationFeedback(owned)?.content?.[1])
    .toMatchObject({ text: expect.stringContaining("despite shell exit 0") });

  // Exit 0 here is the trailing command's, so the note would be unfounded.
  const disowned = event(cargo(0, 1), 0);
  disowned.input.command = "cargo test; echo done";
  const result = verificationFeedback(disowned)!;
  expect(result).not.toHaveProperty("content");
  expect(result.details).toMatchObject({ nekopiVerification: { status: "tests_failed", ownsExitStatus: false } });
});

test("structures whose output or exit status cannot be read stay unknown", () => {
  for (const command of ["cargo test | tee out.txt", "cargo test > result.log", "cargo test 2>&1", "cargo test &",
    "(cd repo && cargo test)", "cargo test `echo filter`", "cargo test $(echo filter)",
    "cargo test 'unbalanced", "git diff && cargo test <<'EOF'\nbody\nEOF",
    // Two dialects in one output; which summary belongs to which is not recoverable.
    "cargo test && npm test"])
    expect(reportedVerification(command, cargo())).toBeUndefined();
});

test("a separator inside quotes does not split a command, and an expansion is not a substitution", () => {
  // The blanket character guard refused both of these; neither hides anything.
  expect(reportedVerification("nek grep 'a;b|c' && cargo test", cargo()))
    .toMatchObject({ runner: "cargo", status: "no_tests_reported", ownsExitStatus: true });
  expect(reportedVerification("cargo test --target-dir $CARGO_TARGET", cargo()))
    .toMatchObject({ runner: "cargo", ownsExitStatus: true });
  // A quoted alternation in a `-run` filter is how 50 of the suite's tasks are
  // scored, and the character guard refused every one of them.
  expect(reportedVerification("go test ./pkg/cmd/org/list -run 'TestListRun/default|TestListRun/nontty' -v",
    "=== RUN   TestListRun\n--- PASS: TestListRun (0.00s)\nPASS\nok \tgithub.com/x/y\t0.1s\n"))
    .toMatchObject({ runner: "go", status: "tests_reported", executed: 1, ownsExitStatus: true });
});
