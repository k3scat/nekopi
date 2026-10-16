import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createSdkFixture } from "../helpers/model-server.ts";

function userTool(name: string) {
  return defineTool({ name, label: name, description: `User ${name} override.`, defaultActive: false,
    parameters: Type.Object({ pattern: Type.String() }),
    execute: async () => ({ content: [{ type: "text", text: `User ${name} ran.` }], details: {} }),
  });
}

for (const timing of ["load", "session_start"] as const) {
  test(`user source definitions and selection registered at ${timing} are preserved`, async () => {
    const fixture = await createSdkFixture({
      extensions: [pi => {
        const register = () => { for (const name of ["read", "grep", "find"]) pi.registerTool(userTool(name)); };
        if (timing === "load") register();
        else pi.on("session_start", register);
      }],
    });
    try {
      for (const name of ["read", "grep", "find"]) {
        expect(fixture.session.getToolDefinition(name)?.description).toBe(`User ${name} override.`);
        if (name === "read") expect(fixture.session.getActiveToolNames()).toContain(name);
        else expect(fixture.session.getActiveToolNames()).not.toContain(name);
      }
      fixture.session.setActiveToolsByName(["bash"]);
      await fixture.session.reload();
      for (const name of ["read", "grep", "find"]) {
        expect(fixture.session.getToolDefinition(name)?.description).toBe(`User ${name} override.`);
        expect(fixture.session.getActiveToolNames()).not.toContain(name);
      }
      fixture.session.setActiveToolsByName(["read", "grep", "find"]);
      fixture.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { pattern: "file" }), fauxToolCall("grep", { pattern: "symbol" }), fauxToolCall("find", { pattern: "*.ts" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("User source tools completed."),
      ]);
      await fixture.session.prompt("Use the selected source tools.");
      const results = fixture.session.messages.filter(message => message.role === "toolResult");
      expect(results.map(result => result.isError)).toEqual([false, false, false]);
      expect(JSON.stringify(results)).toContain("User read ran.");
      expect(JSON.stringify(results)).toContain("User grep ran.");
      expect(JSON.stringify(results)).toContain("User find ran.");
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  });
}

test("SDK source definitions and selection are preserved", async () => {
  const fixture = await createSdkFixture({ customTools: [userTool("read"), userTool("grep"), userTool("find")] });
  try {
    for (const name of ["read", "grep", "find"]) {
      expect(fixture.session.getToolDefinition(name)?.description).toBe(`User ${name} override.`);
      if (name === "read") expect(fixture.session.getActiveToolNames()).toContain(name);
      else expect(fixture.session.getActiveToolNames()).not.toContain(name);
    }
    fixture.session.setActiveToolsByName(["bash"]);
    await fixture.session.reload();
    for (const name of ["read", "grep", "find"]) {
      expect(fixture.session.getAllTools().find(tool => tool.name === name)?.sourceInfo.source).toBe("sdk");
      expect(fixture.session.getActiveToolNames()).not.toContain(name);
    }
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});

test("the parent read accepts numbered citations and reload keeps a disabled read disabled", async () => {
  // About the registered `read` replacement and its selection across a reload,
  // which is the six tool shape. The same code answers `nekocli read`.
  const fixture = await createSdkFixture({ sixTools: true });
  try {
    expect(fixture.session.getToolDefinition("read")!.parameters).toHaveProperty("properties.lineNumbers");
    fixture.session.setActiveToolsByName(["bash"]);
    expect(fixture.session.getActiveToolNames()).not.toContain("read");
    await fixture.session.reload();
    expect(fixture.session.getActiveToolNames()).not.toContain("read");
    await writeFile(join(fixture.cwd, "source.txt"), "first\nsecond\nthird\n");
    fixture.session.setActiveToolsByName(["read"]);
    fixture.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "source.txt", offset: 2, limit: 1, lineNumbers: true }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Citation obtained."),
    ]);
    await fixture.session.prompt("Read the requested source line with its citation.");
    const result = fixture.session.messages.find(message => message.role === "toolResult");
    expect(result?.isError).toBe(false);
    expect(result?.content).toEqual([{ type: "text", text: 'File "source.txt"\nSource lines 2-2.\n2: second\n\n[2 more lines in file. Use offset=3 to continue.]' }]);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});
