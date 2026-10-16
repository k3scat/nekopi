import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { loadPersonas, personaMessages, previewPersona } from "../src/persona.ts";
import { createSdkFixture } from "./helpers/model-server.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "nekopi-persona-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project", "nested");
  await mkdir(agentDir);
  await mkdir(cwd, { recursive: true });
  return { root, agentDir, cwd };
}

test("PERSONA.md uses the nearest trusted ancestor, with a separate global fallback", async () => {
  const options = await workspace();
  await writeFile(join(options.agentDir, "PERSONA.md"), "Global character.\n");
  await writeFile(join(options.root, "PERSONA.md"), "Ancestor character.\n");
  expect(await loadPersonas({ ...options, trustedProject: true })).toEqual({ global: "Global character.", project: "Ancestor character." });
  await writeFile(join(options.cwd, "PERSONA.md"), "近くのキャラクター。\n");
  expect((await loadPersonas({ ...options, trustedProject: true })).project).toBe("近くのキャラクター。");
  await writeFile(join(options.cwd, "PERSONA.md"), " \n");
  expect((await loadPersonas({ ...options, trustedProject: true })).project).toBe("");
  await rm(join(options.cwd, "PERSONA.md"));
  await mkdir(join(options.cwd, "PERSONA.md"));
  expect(await loadPersonas({ ...options, trustedProject: false })).toEqual({ global: "Global character." });
});

test("persona reads reject oversized, invalid UTF-8 and nonregular files", async () => {
  const options = await workspace();
  const file = join(options.agentDir, "PERSONA.md");
  const load = () => loadPersonas({ ...options, trustedProject: false });
  await writeFile(file, "x".repeat(65_536));
  expect((await load()).global).toHaveLength(65_536);
  await writeFile(file, "x".repeat(65_537));
  await expect(load()).rejects.toThrow("persona exceeds 64 KiB");
  await writeFile(file, Buffer.from([0xff]));
  await expect(load()).rejects.toThrow(file);
  await rm(file);
  await mkdir(file);
  await expect(load()).rejects.toThrow("expected a regular file");
});

test.skipIf(process.platform === "win32")("a persona FIFO is rejected without blocking", async () => {
  const options = await workspace();
  const file = join(options.agentDir, "PERSONA.md");
  expect(spawnSync("mkfifo", [file]).status).toBe(0);
  await expect(loadPersonas({ ...options, trustedProject: false })).rejects.toThrow("expected a regular file");
});

test("persona projection preserves message metadata, tools and every other section", () => {
  const head = { role: "system" as const, content: "", sections: { preamble: "Default.", rules: "Rules." }, timestamp: 1 };
  const removed = { role: "system" as const, content: "", sections: { preamble: null, rules: "Updated." }, timestamp: 2 };
  const user = { role: "user" as const, content: "Hello", timestamp: 3 };
  const host = { ...head, sections: { preamble: "Host identity." } };
  expect(personaMessages([head, removed, user, host], "Character.", "Default.")).toEqual([
    { ...head, sections: { ...head.sections, preamble: "Character." } }, removed, user, host,
  ]);
  expect(head.sections.preamble).toBe("Default.");
  expect(previewPersona("Default.\n\n<tools>\nTools\n</tools>", "Character.")).toBe("Character.\n\n<tools>\nTools\n</tools>");
  expect(previewPersona("Default.", undefined)).toBe("Default.");
});

test("PERSONA.md replaces only the opening while later extension guidance and tool schemas remain", async () => {
  const fixture = await createSdkFixture({ useDefaultSystemPrompt: true, sixTools: true, tools: ["read", "write"],
    extensions: [pi => {
      pi.on("before_agent_start", event => {
        event.systemPromptOptions.promptGuidelines.push("Keep the host output format.");
        event.systemPromptOptions.contextFiles.push({ path: "AGENTS.md", content: "Preserve public interfaces." });
        event.systemPromptOptions.sections.host = "Other extension guidance.";
      });
    }] });
  try {
    fixture.setResponses([fauxAssistantMessage("Baseline.")]);
    await fixture.session.prompt("Hello.");
    const baseline = getCurrentSystemPrompt(fixture.requests[0]!.messages);
    const tools = getCurrentTools(fixture.requests[0]!.messages);
    const persona = "You are Neko, a ship engineer.\n\nSpeak with dry humor.";
    await writeFile(join(fixture.agentDir, "PERSONA.md"), persona);
    await fixture.session.reload();
    fixture.setResponses([fauxAssistantMessage("In character.")]);
    await fixture.session.prompt("Hello again.");
    const messages = fixture.requests[1]!.messages;
    expect(getCurrentSystemPrompt(messages)).toBe(previewPersona(baseline, persona));
    expect(getCurrentTools(messages)).toEqual(tools);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});

test("project personas respect revocation, reload, deletion and empty overrides", async () => {
  const fixture = await createSdkFixture({ useDefaultSystemPrompt: true, trusted: true });
  try {
    const global = join(fixture.agentDir, "PERSONA.md");
    const project = join(fixture.cwd, "PERSONA.md");
    await writeFile(global, "Global character.");
    await writeFile(project, "Project character.");
    async function query(opening: string) {
      fixture.setResponses([context => {
        expect(getCurrentSystemPrompt(context.messages).startsWith(opening)).toBe(true);
        return fauxAssistantMessage("Done.");
      }]);
      await fixture.session.prompt("Hello.");
    }
    await query("Project character.");
    fixture.session.settingsManager.setProjectTrusted(false);
    await query("Global character.");
    fixture.session.settingsManager.setProjectTrusted(true);
    await writeFile(project, "Updated character.");
    await query("Project character.");
    await fixture.session.reload();
    await query("Updated character.");
    await rm(project);
    await fixture.session.reload();
    await query("Global character.");
    await writeFile(project, "\n");
    await fixture.session.reload();
    await query("You are an expert coding assistant");
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});

test("untrusted project personas stay unread until trust and reload", async () => {
  const fixture = await createSdkFixture({ useDefaultSystemPrompt: true });
  try {
    await writeFile(join(fixture.agentDir, "PERSONA.md"), "Global character.");
    await mkdir(join(fixture.cwd, "PERSONA.md"));
    fixture.setResponses([context => {
      expect(getCurrentSystemPrompt(context.messages).startsWith("Global character.")).toBe(true);
      return fauxAssistantMessage("Done.");
    }]);
    await fixture.session.prompt("Hello.");
    await rm(join(fixture.cwd, "PERSONA.md"), { recursive: true });
    await writeFile(join(fixture.cwd, "PERSONA.md"), "Trusted character.");
    fixture.session.settingsManager.setProjectTrusted(true);
    await fixture.session.reload();
    fixture.setResponses([context => {
      expect(getCurrentSystemPrompt(context.messages).startsWith("Trusted character.")).toBe(true);
      return fauxAssistantMessage("Done.");
    }]);
    await fixture.session.prompt("Hello again.");
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});

test("full custom prompts take priority without reading even invalid persona files", async () => {
  for (const mode of ["base", "custom", "forced"] as const) {
    const fixture = await createSdkFixture({ useDefaultSystemPrompt: mode !== "base", extensions: mode === "base" ? [] : [pi => {
      pi.on("before_agent_start", event => {
        if (mode === "custom") event.systemPromptOptions.customPrompt = "Full custom identity.";
        else return { systemPrompt: "Full forced identity." };
      });
    }] });
    try {
      await mkdir(join(fixture.agentDir, "PERSONA.md"));
      fixture.setResponses([context => {
        expect(getCurrentSystemPrompt(context.messages)).toContain(mode === "base"
          ? "You are an offline integration test assistant." : mode === "custom" ? "Full custom identity." : "Full forced identity.");
        return fauxAssistantMessage("Done.");
      }]);
      await fixture.session.prompt("Hello.");
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  }
});

test("persona survives tool turns without freezing changes to declarations or tool guidance", async () => {
  const fixture = await createSdkFixture({ useDefaultSystemPrompt: true, sixTools: true,
    tools: ["read", "write", "change_tools"], extensions: [pi => {
      pi.registerTool({ name: "change_tools", label: "Change tools", description: "Change the active tool set.",
        parameters: Type.Object({}), async execute() {
          pi.setActiveTools(["write"]);
          return { content: [{ type: "text", text: "Tools changed." }], details: {} };
        } });
    }] });
  try {
    await writeFile(join(fixture.agentDir, "PERSONA.md"), "You are Neko.");
    fixture.setResponses([
      context => {
        expect(getCurrentSystemPrompt(context.messages).startsWith("You are Neko.")).toBe(true);
        expect(getCurrentTools(context.messages).map(tool => tool.name)).toContain("change_tools");
        return fauxAssistantMessage(fauxToolCall("change_tools", {}), { stopReason: "toolUse" });
      },
      context => {
        expect(getCurrentSystemPrompt(context.messages).startsWith("You are Neko.")).toBe(true);
        expect(getCurrentTools(context.messages).map(tool => tool.name)).toEqual(["write"]);
        expect(getCurrentSystemPrompt(context.messages)).not.toContain("- read:");
        return fauxAssistantMessage("Done.");
      },
    ]);
    await fixture.session.prompt("Change tools.");
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});

test("invalid active personas abort before sending a model request", async () => {
  const fixture = await createSdkFixture({ useDefaultSystemPrompt: true });
  try {
    await mkdir(join(fixture.agentDir, "PERSONA.md"));
    fixture.setResponses([]);
    await fixture.session.prompt("Hello.");
    expect(fixture.requests).toHaveLength(0);
    expect(fixture.errors.some(error => error.includes("PERSONA.md") && error.includes("regular file"))).toBe(true);
  } finally { await fixture.cleanup(); }
});

test("the existing prompt viewer shows PERSONA.md without sending a model request", async () => {
  for (const custom of [false, true]) {
    const fixture = await createSdkFixture({ useDefaultSystemPrompt: !custom });
    try {
      await writeFile(join(fixture.agentDir, "PERSONA.md"), "You are Neko.");
      const runner = fixture.session.extensionRunner;
      let shown = "";
      runner.setUIContext({ ...runner.getUIContext(), async editor(_title, text) { shown = text ?? ""; return "Ignored edits."; } }, "rpc");
      await fixture.session.prompt("/nekopi prompt");
      expect(shown.startsWith(custom ? "You are an offline integration test assistant." : "You are Neko.")).toBe(true);
      expect(fixture.requests).toHaveLength(0);
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  }
});

test("APPEND_SYSTEM.md remains an addendum when PERSONA.md replaces the opening", async () => {
  const fixture = await createSdkFixture({ useDefaultSystemPrompt: true, completionGuidance: false });
  try {
    await writeFile(join(fixture.agentDir, "PERSONA.md"), "You are Neko.");
    await writeFile(join(fixture.agentDir, "APPEND_SYSTEM.md"), "Keep this separate addendum.");
    await fixture.session.reload();
    fixture.setResponses([context => {
      const prompt = getCurrentSystemPrompt(context.messages);
      expect(prompt.startsWith("You are Neko.")).toBe(true);
      expect(prompt).toContain("<addendum>\nKeep this separate addendum.\n</addendum>");
      return fauxAssistantMessage("Done.");
    }]);
    await fixture.session.prompt("Hello.");
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});
