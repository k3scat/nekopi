import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBashToolDefinition, defineTool, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createSdkFixture } from "../helpers/model-server.ts";

test("the package annotates native Bash zero tests without replacing the tool or its structured output", async () => {
  let observed: ToolResultEvent | undefined;
  // The six tool shape, because the last assertion is that nekopi leaves a
  // host's own tool selection alone across a reload. The default shape
  // deliberately deselects the tools `nekocli` covers, which
  // `tests/shape.test.ts` asserts instead.
  const fixture = await createSdkFixture({ globalConfig: { nekocli: { enabled: false } }, extensions: [pi => {
    pi.on("tool_result", event => { observed = event; });
  }] });
  try {
    const { execute: _nativeExecute, renderCall: _nativeCall, renderResult: _nativeResult, ...native } = createBashToolDefinition(fixture.cwd);
    const { execute: _execute, renderCall: _call, renderResult: _result, ...actual } = fixture.session.getToolDefinition("bash")!;
    expect<unknown>(actual).toEqual(native);
    await writeFile(join(fixture.cwd, "unit.test.mjs"), 'import {test} from "node:test"; test.skip("actual_case", () => {});\n');
    fixture.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "node --test --test-reporter=tap unit.test.mjs" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Observed the test summary."),
    ]);
    await fixture.session.prompt("Run the local test file.");
    const result = fixture.session.messages.find(message => message.role === "toolResult");
    expect(result?.role === "toolResult" && result.isError).toBe(false);
    expect(JSON.stringify(result)).toContain("0 executed cases");
    expect(observed).toMatchObject({ details: { nekopiVerification: { status: "no_tests_reported", executed: 0 } },
      structuredContent: { truncated: false, exit_code: 0, output: expect.stringContaining("# pass 0") } });
    fixture.session.setActiveToolsByName(["read"]);
    await fixture.session.reload();
    expect(fixture.session.getActiveToolNames()).toEqual(["read"]);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});

for (const source of ["load", "session_start", "sdk"] as const) {
  test(`a ${source} Bash override retains its own result and status`, async () => {
    const tool = defineTool({ ...createBashToolDefinition("."), description: "Custom Bash.",
      execute: async () => ({ content: [{ type: "text" as const, text: "Custom result." }], details: undefined,
        structuredContent: { output: "# tests 0\n# suites 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n", exit_code: 0, truncated: false } }),
    });
    const fixture = await createSdkFixture(source === "sdk" ? { customTools: [tool] } : { extensions: [pi => {
      if (source === "load") pi.registerTool(tool);
      else pi.on("session_start", () => pi.registerTool(tool));
    }] });
    try {
      fixture.setResponses([
        fauxAssistantMessage(fauxToolCall("bash", { command: "node --test" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Observed the custom result."),
      ]);
      await fixture.session.prompt("Use Bash.");
      const result = fixture.session.messages.find(message => message.role === "toolResult");
      expect(result?.role === "toolResult" && result.isError).toBe(false);
      expect(result).toMatchObject({ content: [{ type: "text", text: "Custom result." }] });
      expect(JSON.stringify(result)).not.toContain("nekopiVerification");
      expect(fixture.session.getToolDefinition("bash")?.description).toBe("Custom Bash.");
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  });
}
