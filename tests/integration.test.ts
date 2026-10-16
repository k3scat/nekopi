import { describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
  type JsonObject,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { createSdkFixture } from "./helpers/model-server.ts";

// The default shape sends one tool and reaches the rest through `nekocli`.
// `lsp` is not in either list: the semantic layer stayed and the tool went,
// after two batches chose it 0.01 to 0.03 times per run.
const DEFAULT_TOOLS = ["bash"];
const SIX_TOOLS = ["bash", "edit", "find", "grep", "read", "write"];

function call(name: string, args: JsonObject) {
  return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

function resultText(message: ToolResultMessage): string {
  return message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}

describe("Pi SDK integration", () => {
  test("search can locate a filename before searching its contents", async () => {
    const fixture = await createSdkFixture({ useDefaultSystemPrompt: true, sixTools: true });
    try {
      await mkdir(join(fixture.cwd, "lib", "settings"), { recursive: true });
      await mkdir(join(fixture.cwd, "ignored"));
      await writeFile(join(fixture.cwd, ".gitignore"), "ignored/\n");
      await writeFile(join(fixture.cwd, "ignored", "manager.py"), "ignored source\n");
      await writeFile(join(fixture.cwd, "lib", "settings", "manager.py"), "def ensure_type(value):\n    return value\n");
      fixture.setResponses([
        context => {
          const find = getCurrentTools(context.messages).find(tool => tool.name === "find");
          expect(find?.parameters).toMatchObject({ required: ["pattern"] });
          expect(fixture.session.systemPrompt).toContain("Find files by glob pattern");
          return call("find", { pattern: "manager.py" });
        },
        context => {
          const result = context.messages.find(message => message.role === "toolResult" && message.toolName === "find");
          if (result?.role !== "toolResult") throw new Error("Missing file discovery result.");
          expect(result.isError).toBe(false);
          const path = resultText(result);
          expect(path).toBe("lib/settings/manager.py");
          return call("grep", { pattern: "ensure_type", path, literal: true, context: 1 });
        },
        context => {
          const result = context.messages.find(message => message.role === "toolResult" && message.toolName === "grep");
          if (result?.role !== "toolResult") throw new Error("Missing discovered source result.");
          expect(result.isError).not.toBe(true);
          expect(result.details).toMatchObject({ scanComplete: true, omittedSpans: 0 });
          expect(resultText(result)).toContain("lib/settings/manager.py\n[def ensure_type]\n  1: def ensure_type(value):");
          expect(resultText(result)).toContain("  2-     return value");
          return fauxAssistantMessage("Located the file and inspected its implementation.");
        },
      ]);
      await fixture.session.prompt("Locate manager.py by name and inspect ensure_type.");
      expect(fixture.requests).toHaveLength(3);
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  });

  test("source batches preserve separate results, hooks and attachments", async () => {
    const attachment = { type: "image" as const, data: "fixture", mimeType: "image/png" };
    const fixture = await createSdkFixture({
      useDefaultSystemPrompt: true,
      sixTools: true,
      extensions: [pi => { pi.on("tool_result", event => {
        if (event.toolName === "read") return { content: [...event.content, attachment] };
      }); }],
    });
    try {
      await writeFile(join(fixture.cwd, "repeated.ts"), "requested_symbol();\n".repeat(150));
      await writeFile(join(fixture.cwd, "caller.ts"), "requested_symbol(value);\n");
      fixture.setResponses([
        context => {
          expect(getCurrentTools(context.messages).map(tool => tool.name).sort()).toEqual(SIX_TOOLS);
          return fauxAssistantMessage([
            fauxToolCall("grep", { pattern: "requested_symbol", outputMode: "files" }),
            fauxToolCall("grep", { pattern: "requested_symbol", path: "caller.ts", outputMode: "content" }),
            fauxToolCall("read", { path: "caller.ts" }),
            fauxToolCall("read", { path: "missing.ts" }),
          ], { stopReason: "toolUse" });
        },
        context => {
          const results = context.messages.filter(message => message.role === "toolResult");
          expect(results.map(result => result.toolName)).toEqual(["grep", "grep", "read", "read"]);
          expect(results.map(result => result.isError)).toEqual([false, false, false, true]);
          expect(results[0]!.details).toMatchObject({ scanComplete: true });
          expect((results[0]!.details as { files: string[] }).files.toSorted()).toEqual(["caller.ts", "repeated.ts"]);
          expect(results[1]!.details).toMatchObject({ scanComplete: true, omittedSpans: 0 });
          expect(resultText(results[1]!)).toContain("caller.ts\n  1: requested_symbol(value);");
          expect(resultText(results[2]!)).toContain("requested_symbol(value);");
          expect(results[2]!.content).toContainEqual(attachment);
          expect(resultText(results[3]!)).toContain("ENOENT");
          expect(results.every(result => !result.nestedCalls)).toBe(true);
          return fauxAssistantMessage("Results preserved; missing file reported separately.");
        },
      ]);
      await fixture.session.prompt("Find matching files and independently inspect known sources.");
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  });

  test("the six tool shape exposes search, and the semantic layer is no tool of the model's", async () => {
    const fixture = await createSdkFixture({ useDefaultSystemPrompt: true, sixTools: true });
    try {
      expect(fixture.session.getActiveToolNames().sort()).toEqual(SIX_TOOLS);
      expect(fixture.session.getToolDefinition("lsp")).toBeUndefined();
      expect(fixture.session.getToolDefinition("code_intel")).toBeUndefined();
      fixture.setResponses([context => {
        expect(getCurrentTools(context.messages).map(tool => tool.name).sort()).toEqual(SIX_TOOLS);
        return fauxAssistantMessage("Ready.");
      }]);
      await fixture.session.prompt("Report readiness.");
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  });

  for (const trusted of [false, true]) {
    test(`optional tools follow project trust and preserve native tool hooks (${trusted})`, async () => {
      const fixture = await createSdkFixture({ trusted, sixTools: true,
        globalConfig: { languageServers: { enabled: true } },
        projectConfig: { languageServers: { enabled: false } },
        extensions: [pi => { pi.on("tool_call", event => {
          if (event.toolName === "read") return { block: true, reason: "Fixture read restriction." };
        }); }],
      });
      try {
        // Search always registers, trusted or not, and nothing here is gated on
        // a language server any more.
        expect(fixture.session.getActiveToolNames()).toContain("grep");
        expect(fixture.session.getActiveToolNames()).not.toContain("lsp");
        await writeFile(join(fixture.cwd, "source.txt"), "required source\n");
        fixture.setResponses([
          fauxAssistantMessage([
            fauxToolCall("read", { path: "source.txt" }),
            fauxToolCall("grep", { pattern: "required", path: "source.txt" }),
          ], { stopReason: "toolUse" }),
          context => {
            const results = context.messages.filter(message => message.role === "toolResult");
            expect(results.map(result => result.toolName)).toEqual(["read", "grep"]);
            expect(results[0]!.isError).toBe(true);
            expect(resultText(results[0]!)).toContain("Fixture read restriction.");
            expect(results[1]!.isError).toBe(false);
            expect(resultText(results[1]!)).toContain("required source");
            return fauxAssistantMessage("Search preserved; read restriction respected.");
          },
        ]);
        await fixture.session.prompt("Inspect the known source file.");
        expect(fixture.errors).toEqual([]);
      } finally { await fixture.cleanup(); }
    });
  }

  test("configured optional tools respect the host's explicit tool allowlist", async () => {
    const fixture = await createSdkFixture({ tools: ["read", "bash"], sixTools: true });
    try {
      expect(fixture.session.getActiveToolNames().sort()).toEqual(["bash", "read"]);
      expect(fixture.session.getCallableToolNames().sort()).toEqual(["bash", "read"]);
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  });

  test("the semantic layer is never a tool, however it is configured", async () => {
    const fixture = await createSdkFixture({ useDefaultSystemPrompt: true, sixTools: true });
    try {
      // Two batches and 450 runs chose it 0.01 to 0.03 times per run for about
      // 324 tokens on every request, which is 0.37 of a turn per run at the
      // 12,800 tokens a turn costs. The layer stayed; the tool went.
      expect(fixture.session.getToolDefinition("lsp")).toBeUndefined();
      expect(fixture.session.systemPrompt).not.toContain("You have an editor's navigation");
      for (const enabled of [true, false]) {
        // The reload reads this file, so it carries the shape as well; without
        // it the reload would land in the default shape and the assertion below
        // would be about a different product.
        await writeFile(join(fixture.agentDir, "nekopi.json"),
          JSON.stringify({ languageServers: { enabled }, nekocli: { enabled: false } }));
        await fixture.session.reload();
        expect(fixture.session.getActiveToolNames().sort()).toEqual(SIX_TOOLS);
        expect(fixture.session.getToolDefinition("lsp")).toBeUndefined();
      }
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  });

  test("reload preserves disabled optional tools", async () => {
    const fixture = await createSdkFixture({ sixTools: true,
      globalConfig: { languageServers: { enabled: false } } });
    try {
      const native = ["bash", "edit", "read", "write"];
      fixture.session.setActiveToolsByName(native);
      await fixture.session.reload();
      // Search was already registered and stays deselected across a reload.
      expect(fixture.session.getActiveToolNames().sort()).toEqual(native);
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  });

  test("retains Pi tools and registers the harness through public extension APIs", async () => {
    const fixture = await createSdkFixture({ sixTools: true, globalConfig: { telemetry: { enabled: true } } });
    try {
      expect(fixture.session.getActiveToolNames().sort()).toEqual(SIX_TOOLS);
      expect(fixture.session.extensionRunner.getRegisteredCommands().some((command) => command.name === "nekopi")).toBe(true);
      await writeFile(join(fixture.cwd, "input.txt"), "fixture source\n");
      fixture.setResponses([
        call("read", { path: "input.txt" }),
        fauxAssistantMessage("Read completed."),
      ]);
      await fixture.session.prompt("Read input.txt.");
      const result = fixture.session.messages.find((message) => message.role === "toolResult");
      expect(result?.role).toBe("toolResult");
      if (result?.role !== "toolResult") throw new Error("Missing read result.");
      expect(resultText(result)).toContain("fixture source");
      const directory = join(fixture.agentDir, "nekopi", "telemetry");
      const logFiles = await readdir(directory);
      expect(logFiles).toHaveLength(1);
      const logFile = logFiles[0];
      if (!logFile) throw new Error("Missing telemetry file.");
      const log = await readFile(join(directory, logFile), "utf8");
      const records = log.trim().split("\n").map((line) => JSON.parse(line));
      expect(records.filter((record) => record.type === "tool").map((record) => record.tool)).toEqual(["read"]);
      expect(records.filter((record) => record.type === "usage")).toHaveLength(2);
      expect(log).not.toContain("fixture source");
      expect(log).not.toContain("input.txt");
      expect(log).not.toContain("Read completed.");
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test("telemetry stays off until it is configured", async () => {
    const fixture = await createSdkFixture();
    try {
      await writeFile(join(fixture.cwd, "input.txt"), "fixture source\n");
      fixture.setResponses([call("read", { path: "input.txt" }), fauxAssistantMessage("Read completed.")]);
      await fixture.session.prompt("Read input.txt.");
      await expect(readdir(join(fixture.agentDir, "nekopi", "telemetry"))).rejects.toThrow();
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  });

  test("loads the package manifest through Pi's extension loader", async () => {
    const fixture = await createSdkFixture({ loadPackage: true });
    try {
      expect(fixture.loadDiagnostics).toEqual({ errors: [], warnings: [] });
      expect(fixture.session.getActiveToolNames().sort()).toEqual(DEFAULT_TOOLS);
      fixture.setResponses([fauxAssistantMessage("Ready.")]);
      await fixture.session.prompt("Report readiness.");
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});
