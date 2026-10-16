import { expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createBashToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { createSdkFixture } from "../helpers/model-server.ts";

test("native Bash caps anomalous long timeouts", async () => {
  const seen = new Map<string, number | undefined>();
  const fixture = await createSdkFixture({ extensions: [pi => {
    pi.on("tool_result", event => {
      if (event.toolName === "bash" && typeof event.input.command === "string") {
        seen.set(event.input.command, event.input.timeout as number | undefined);
      }
    });
  }] });
  try {
    fixture.setResponses([
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "printf capped # private-token", timeout: 120000 }),
        fauxToolCall("bash", { command: "printf boundary", timeout: 10000 }),
        fauxToolCall("bash", { command: "printf observed", timeout: 1200 }),
        fauxToolCall("bash", { command: "printf retained", timeout: 120 }),
        fauxToolCall("bash", { command: "printf longer", timeout: 999 }),
        fauxToolCall("bash", { command: "printf long", timeout: 3600 }),
        fauxToolCall("bash", { command: "printf absent" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    ]);
    await fixture.session.prompt("Run three short commands.");
    expect(Object.fromEntries(seen)).toEqual({
      "printf capped # private-token": 300,
      "printf boundary": 300,
      "printf observed": 300,
      "printf retained": 120,
      "printf longer": 999,
      "printf long": 300,
      "printf absent": undefined,
    });
    const results = fixture.session.messages.filter(message => message.role === "toolResult");
    expect(results.every(message => message.isError !== true)).toBe(true);
    expect(JSON.stringify(results)).not.toContain("private-token");
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});

test("a host's Bash override keeps its requested timeout", async () => {
  let received: number | undefined;
  const tool = defineTool({ ...createBashToolDefinition("."),
    execute: async (_id, input) => {
      received = input.timeout;
      return { content: [{ type: "text" as const, text: "Custom Bash ran." }], details: undefined };
    },
  });
  const fixture = await createSdkFixture({ customTools: [tool] });
  try {
    expect(fixture.session.getAllTools().find(item => item.name === "bash")?.sourceInfo.source).toBe("sdk");
    fixture.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf custom", timeout: 120000 }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    ]);
    await fixture.session.prompt("Run the host's Bash command.");
    expect(received).toBe(120000);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});
