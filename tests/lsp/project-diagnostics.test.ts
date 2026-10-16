import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createSdkFixture } from "../helpers/model-server.ts";

test("diagnostics can be enabled and disabled on reload without activating mutations", async () => {
  // Diagnostics attach to the `edit` and `write` tools, so this is the six tool
  // shape. In the default shape the setting has no consumer, which
  // `tests/shape.test.ts` asserts is reported rather than ignored.
  const fixture = await createSdkFixture({ sixTools: true });
  try {
    fixture.session.setActiveToolsByName(["read"]);
    await writeFile(join(fixture.agentDir, "nekopi.json"), JSON.stringify({ diagnostics: { enabled: true }, nekocli: { enabled: false } }));
    await fixture.session.reload();
    expect(fixture.session.getActiveToolNames()).toEqual(["read"]);
    for (const name of ["edit", "write"]) expect(fixture.session.getToolDefinition(name)?.description).toContain("Reports any diagnostic this change introduced");
    await writeFile(join(fixture.agentDir, "nekopi.json"), JSON.stringify({ diagnostics: { enabled: false }, nekocli: { enabled: false } }));
    await fixture.session.reload();
    expect(fixture.session.getActiveToolNames()).toEqual(["read"]);
    for (const name of ["edit", "write"]) expect(fixture.session.getToolDefinition(name)?.description).not.toContain("appends bounded diagnostics");
    expect(fixture.session.getAllTools().find(tool => tool.name === "write")?.sourceInfo.source).toBe("builtin");
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});

for (const source of ["extension", "sdk"] as const) {
  test(`diagnostics preserve ${source} mutation overrides`, async () => {
    const tools = ["edit", "write"].map(name => defineTool({ name, label: name, description: `Custom ${name}.`,
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: `Custom ${name} ran.` }], details: {} }),
    }));
    const fixture = await createSdkFixture({ globalConfig: { diagnostics: { enabled: true } },
      ...(source === "sdk" ? { customTools: tools } : { extensions: [pi => {
        pi.on("session_start", () => { for (const tool of tools) pi.registerTool(tool); });
      }] }),
    });
    try {
      for (const name of ["edit", "write"]) expect(fixture.session.getToolDefinition(name)?.description).toBe(`Custom ${name}.`);
      fixture.setResponses([
        fauxAssistantMessage([fauxToolCall("edit", { path: "source.ts" }), fauxToolCall("write", { path: "source.ts" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("Custom tools completed."),
      ]);
      await fixture.session.prompt("Use the custom mutation tools.");
      const results = fixture.session.messages.filter(message => message.role === "toolResult");
      expect(results.map(result => result.isError)).toEqual([false, false]);
      expect(JSON.stringify(results)).toContain("Custom edit ran.");
      expect(JSON.stringify(results)).toContain("Custom write ran.");
      expect(JSON.stringify(results)).not.toContain("Post-edit diagnostics");
      await fixture.session.reload();
      for (const name of ["edit", "write"]) expect(fixture.session.getToolDefinition(name)?.description).toBe(`Custom ${name}.`);
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  });
}
