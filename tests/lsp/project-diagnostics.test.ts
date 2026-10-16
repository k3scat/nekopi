import { expect, test } from "bun:test";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createSdkFixture } from "../helpers/model-server.ts";

for (const trusted of [false, true]) {
  for (const backend of ["compiler", "server"]) {
    test(`automatic ${backend} execution requires project trust (${trusted})`, async () => {
      const command = "nekopi-test-trust-server";
      const fixture = await createSdkFixture({ trusted, sixTools: true,
        globalConfig: { diagnostics: { enabled: true }, languageServers: { servers: {
          typescript: { command: backend === "server" ? command : join(import.meta.dir, "missing-trust-server") },
        } } } });
      const marker = join(fixture.root, "executed");
      try {
        const body = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`;
        if (backend === "server") {
          const bin = join(fixture.cwd, "node_modules/.bin");
          await mkdir(bin, { recursive: true });
          await writeFile(join(bin, command), `#!/usr/bin/env node\n${body}\nprocess.exit(1);\n`);
          await chmod(join(bin, command), 0o755);
        } else {
          const lib = join(fixture.cwd, "node_modules/typescript/lib");
          await mkdir(lib, { recursive: true });
          await writeFile(join(lib, "../package.json"), JSON.stringify({ name: "typescript", version: "5.9.3" }));
          await writeFile(join(lib, "tsserver.js"), "// not started\n");
          await writeFile(join(lib, "typescript.js"), `${body} module.exports = {};\n`);
        }
        await writeFile(join(fixture.cwd, "tsconfig.json"), "{}");
        await writeFile(join(fixture.cwd, "source.ts"), "export const value = 1;\n");
        fixture.setResponses([
          fauxAssistantMessage(fauxToolCall("edit", { path: "source.ts", edits: [{ oldText: "value = 1", newText: "value = 2" }] }), { stopReason: "toolUse" }),
          fauxAssistantMessage("Done."),
        ]);
        await fixture.session.prompt("Change the value.");
        expect(await access(marker).then(() => true, () => false)).toBe(trusted);
        expect(await readFile(join(fixture.cwd, "source.ts"), "utf8")).toContain("value = 2");
        expect(fixture.session.messages.findLast(message => message.role === "toolResult")?.isError).toBe(false);
        if (!trusted) {
          fixture.session.settingsManager.setProjectTrusted(true);
          await fixture.session.reload();
          fixture.setResponses([
            fauxAssistantMessage(fauxToolCall("edit", { path: "source.ts", edits: [{ oldText: "value = 2", newText: "value = 3" }] }), { stopReason: "toolUse" }),
            fauxAssistantMessage("Done."),
          ]);
          await fixture.session.prompt("Change the value again.");
          expect(await access(marker).then(() => true, () => false)).toBe(true);
          expect(await readFile(join(fixture.cwd, "source.ts"), "utf8")).toContain("value = 3");
        }
        expect(fixture.errors).toEqual([]);
      } finally { await fixture.cleanup(); }
    });
  }
}

test("diagnostics can be enabled and disabled on reload without activating mutations", async () => {
  // Diagnostics attach to the `edit` and `write` tools, so this is the six tool
  // shape. In the default shape the setting has no consumer, which
  // `tests/shape.test.ts` asserts is reported rather than ignored.
  const fixture = await createSdkFixture({ sixTools: true, trusted: true });
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
    const fixture = await createSdkFixture({ trusted: true, globalConfig: { diagnostics: { enabled: true } },
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
