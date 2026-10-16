import { expect, test } from "bun:test";
import { fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { COMPLETION_GUIDELINES, PI_ENVIRONMENT_RULE, piDocsSection } from "../src/prompt.ts";
import { createSdkFixture } from "./helpers/model-server.ts";

test("completion rules reach the provider once across requests and reload while host context and tools remain", async () => {
  const prompts: string[] = [];
  let settled = 0;
  const fixture = await createSdkFixture({ loadPackage: true, useDefaultSystemPrompt: true, tools: ["read", "write"],
    sixTools: true,
    globalConfig: { languageServers: { enabled: false } },
    extensions: [pi => {
      pi.on("before_agent_start", event => {
        event.systemPromptOptions.promptGuidelines.push("Preserve the host output format.");
        event.systemPromptOptions.contextFiles.push({ path: "AGENTS.md", content: "Project contract: preserve the exported API." });
      });
      pi.on("agent_settled", () => { settled++; });
    }],
  });
  try {
    fixture.setResponses([0, 1, 2].map(() => context => {
      const prompt = getCurrentSystemPrompt(context.messages);
      prompts.push(prompt);
      expect(prompt).toContain("You are an expert coding assistant operating inside pi");
      expect(prompt).toContain("Preserve the host output format.");
      expect(prompt).toContain("Project contract: preserve the exported API.");
      expect(prompt).toContain("Use write only for new files or complete rewrites.");
      for (const rule of COMPLETION_GUIDELINES) expect(prompt.split(rule)).toHaveLength(2);
      expect(getCurrentTools(context.messages).map(tool => tool.name).sort()).toEqual(["read", "write"]);
      return fauxAssistantMessage("Partial work remains.");
    }));
    await fixture.session.prompt("Implement the complete public contract.");
    expect(fixture.requests).toHaveLength(1);
    expect(settled).toBe(1);
    await fixture.session.prompt("Stop editing and report the current partial result.");
    expect(fixture.requests).toHaveLength(2);
    expect(settled).toBe(2);
    await fixture.session.reload();
    await fixture.session.prompt("Explain the remaining work without making changes.");
    expect(fixture.requests).toHaveLength(3);
    expect(settled).toBe(3);
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toBe(prompts[0]!);
    expect(prompts[2]).toBe(prompts[0]!);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});

test("a configured custom system prompt retains Pi's original custom prompt behavior", async () => {
  const fixture = await createSdkFixture();
  try {
    fixture.setResponses([context => {
      const prompt = getCurrentSystemPrompt(context.messages);
      expect(prompt).toContain("You are an offline integration test assistant.");
      for (const rule of COMPLETION_GUIDELINES) expect(prompt).not.toContain(rule);
      return fauxAssistantMessage("Custom prompt retained.");
    }]);
    await fixture.session.prompt("Explain the project.");
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});

test("later custom and forced prompt replacements keep precedence over completion guidance", async () => {
  for (const replacement of ["custom", "forced"] as const) {
    const text = "Use the host's exact response contract.";
    const fixture = await createSdkFixture({ useDefaultSystemPrompt: true, extensions: [pi => {
      pi.on("before_agent_start", event => {
        if (replacement === "custom") event.systemPromptOptions.customPrompt = text;
        else return { systemPrompt: text };
      });
    }] });
    try {
      fixture.setResponses([context => {
        const prompt = getCurrentSystemPrompt(context.messages);
        expect(prompt).toContain(text);
        if (replacement === "forced") expect(prompt).toBe(text);
        for (const rule of COMPLETION_GUIDELINES) expect(prompt).not.toContain(rule);
        return fauxAssistantMessage("Host response.");
      }]);
      await fixture.session.prompt("Use the host contract.");
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  }
});

test("SDK hosts can disable completion guidance without replacing Pi's default prompt", async () => {
  const fixture = await createSdkFixture({ useDefaultSystemPrompt: true, completionGuidance: false });
  try {
    fixture.setResponses([context => {
      const prompt = getCurrentSystemPrompt(context.messages);
      expect(prompt).toContain("You are an expert coding assistant operating inside pi");
      for (const rule of COMPLETION_GUIDELINES) expect(prompt).not.toContain(rule);
      return fauxAssistantMessage("Default prompt retained.");
    }]);
    await fixture.session.prompt("Inspect the current state.");
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});

test("Pi's own documentation and environment trivia are cut to one line", async () => {
  const fixture = await createSdkFixture({ useDefaultSystemPrompt: true, tools: ["read", "bash"],
    globalConfig: { languageServers: { enabled: false } } });
  try {
    fixture.setResponses([context => {
      const prompt = getCurrentSystemPrompt(context.messages);
      expect(prompt).toContain(piDocsSection(getPackageDir()));
      // The file-by-file map of Pi's documentation is what the one line replaces.
      expect(prompt).not.toContain("docs/prompt-templates.md");
      expect(prompt).not.toContain(PI_ENVIRONMENT_RULE);
      // The section is still there, so a user asking about Pi is not left guessing.
      expect(prompt).toContain("<docs>");
      return fauxAssistantMessage("Ready.");
    }]);
    await fixture.session.prompt("Report readiness.");
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});
