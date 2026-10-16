import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createEditToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createSdkFixture } from "../helpers/model-server.ts";

test("the package adds recovery to native edit without changing its model metadata", async () => {
  const fixture = await createSdkFixture({ loadPackage: true, useDefaultSystemPrompt: true, sixTools: true });
  try {
    const { execute: _nativeExecute, ...native } = createEditToolDefinition(fixture.cwd);
    const { execute: _execute, defaultActive, ...actual } = fixture.session.getToolDefinition("edit")!;
    expect<unknown>(actual).toEqual(native);
    expect(defaultActive).toBe(false);
    expect(fixture.session.getActiveToolNames().sort()).toEqual(["bash", "edit", "find", "grep", "read", "write"]);
    const file = join(fixture.cwd, "source.txt");
    const source = "first branch\nshared\nsecond branch\nshared\n";
    await writeFile(file, source);
    fixture.setResponses([
      fauxAssistantMessage(fauxToolCall("edit", {
        path: "source.txt", edits: [{ oldText: "shared", newText: "changed" }],
      }), { stopReason: "toolUse" }),
      async context => {
        const failure = context.messages.find(message => message.role === "toolResult");
        expect(failure?.role === "toolResult" && failure.isError).toBe(true);
        expect(JSON.stringify(failure)).toContain("edits[0].oldText (");
        expect(JSON.stringify(failure)).toContain("second branch");
        expect(await readFile(file, "utf8")).toBe(source);
        return fauxAssistantMessage(fauxToolCall("edit", {
          path: "source.txt", edits: [{ oldText: "first branch\nshared", newText: "first branch\nchanged" }],
        }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("The specific edit succeeded."),
    ]);
    await fixture.session.prompt("Change the shared text in the first branch.");
    expect(await readFile(file, "utf8")).toBe("first branch\nchanged\nsecond branch\nshared\n");
    expect(fixture.loadDiagnostics).toEqual({ errors: [], warnings: [] });
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});

test("the default package returns actual indentation after a not-found edit and accepts a corrected request", async () => {
  const fixture = await createSdkFixture({ loadPackage: true, sixTools: true });
  try {
    const file = join(fixture.cwd, "source.py");
    const source = "def check():\n    if ready:\n        return True\n";
    await writeFile(file, source);
    fixture.setResponses([
      fauxAssistantMessage(fauxToolCall("edit", {
        path: "source.py", edits: [{ oldText: "     if ready:\n        return True", newText: "    if ready:\n        return False" }],
      }), { stopReason: "toolUse" }),
      async context => {
        const result = context.messages.find(message => message.role === "toolResult");
        expect(result?.role === "toolResult" && result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("equal after trimming each line's edge whitespace");
        expect(JSON.stringify(result)).toContain("source.py:2");
        expect(await readFile(file, "utf8")).toBe(source);
        return fauxAssistantMessage(fauxToolCall("edit", {
          path: "source.py", edits: [{ oldText: "    if ready:\n        return True", newText: "    if ready:\n        return False" }],
        }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("The corrected edit succeeded."),
    ]);
    await fixture.session.prompt("Change the return value without changing the indentation.");
    expect(await readFile(file, "utf8")).toBe(source.replace("True", "False"));
    expect(fixture.session.getActiveToolNames().sort()).toEqual(["bash", "edit", "find", "grep", "read", "write"]);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});

test("reload keeps a disabled default edit inactive and the extension available", async () => {
  // About the registered `edit` replacement, which only the six tool shape has.
  const fixture = await createSdkFixture({ sixTools: true });
  try {
    fixture.session.setActiveToolsByName(["read"]);
    await fixture.session.reload();
    expect(fixture.session.getActiveToolNames()).toEqual(["read"]);
    expect(fixture.session.getToolDefinition("edit")?.defaultActive).toBe(false);
    expect(fixture.session.extensionRunner.getRegisteredCommands().some(command => command.name === "nekopi")).toBe(true);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});

for (const timing of ["load", "session_start"] as const) {
  test(`a user edit override registered at ${timing} keeps precedence`, async () => {
    const fixture = await createSdkFixture({ extensions: [pi => {
      const register = () => pi.registerTool({ ...createEditToolDefinition("."),
        description: "User edit override.",
        execute: async () => ({ content: [{ type: "text", text: "User edit ran." }], details: undefined }),
      });
      if (timing === "load") register();
      else pi.on("session_start", register);
    }] });
    try {
      expect(fixture.session.getToolDefinition("edit")?.description).toBe("User edit override.");
      fixture.setResponses([
        fauxAssistantMessage(fauxToolCall("edit", {
          path: "absent.txt", edits: [{ oldText: "before", newText: "after" }],
        }), { stopReason: "toolUse" }),
        fauxAssistantMessage("User edit completed."),
      ]);
      await fixture.session.prompt("Use edit.");
      const result = fixture.session.messages.find(message => message.role === "toolResult");
      expect(result?.role === "toolResult" && result.isError).toBe(false);
      expect(JSON.stringify(result)).toContain("User edit ran.");
      expect(fixture.session.extensionRunner.getRegisteredCommands().some(command => command.name === "nekopi")).toBe(true);
      await fixture.session.reload();
      expect(fixture.session.getToolDefinition("edit")?.description).toBe("User edit override.");
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  });
}

test("explicit SDK edit tools retain precedence on initialization and reload", async () => {
  const fixture = await createSdkFixture({ customTools: [defineTool({ ...createEditToolDefinition("."),
    description: "SDK edit override.",
    execute: async () => ({ content: [{ type: "text", text: "SDK edit ran." }], details: undefined }),
  })], extensions: [pi => {
    pi.on("session_start", () => pi.registerTool(createEditToolDefinition(".")));
  }] });
  try {
    expect(fixture.session.getAllTools().find(tool => tool.name === "edit")?.sourceInfo.source).toBe("sdk");
    fixture.setResponses([
      fauxAssistantMessage(fauxToolCall("edit", {
        path: "absent.txt", edits: [{ oldText: "before", newText: "after" }],
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage("SDK edit completed."),
    ]);
    await fixture.session.prompt("Use edit.");
    expect(JSON.stringify(fixture.session.messages.find(message => message.role === "toolResult")))
      .toContain("SDK edit ran.");
    await fixture.session.reload();
    expect(fixture.session.getToolDefinition("edit")?.description).toBe("SDK edit override.");
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});
