/**
 * The default tool shape, and what it does when it cannot work.
 *
 * The shape is one tool. Two things have to hold together for that to be true
 * rather than merely configured: the tools `nekocli` covers must not be sent,
 * and `nek` must resolve in the shell the model is given. A batch once
 * passed only because an untracked absolute symlink sat in `bin/`, so the
 * second half is tested here rather than assumed.
 */
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { createSdkFixture } from "./helpers/model-server.ts";
import { exposeOnPath, launcher } from "../src/tools/launcher.ts";
import { NEKOCLI_GUIDANCE } from "../src/prompt.ts";
import { COMMAND_NAMES } from "../src/tools/commands.ts";

/** A tree shaped like a built checkout, for the resolver to find or reject. */
async function checkout(options: { alias?: boolean; legacy?: boolean; entry?: boolean;
  built?: boolean; executable?: boolean; legacyExecutable?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "nekopi-shape-"));
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  if (options.alias !== false) {
    await writeFile(join(root, "bin", "nek"), "#!/bin/sh\nexit 0\n");
    await chmod(join(root, "bin", "nek"), options.executable === false ? 0o644 : 0o755);
  }
  if (options.legacy !== false) {
    await writeFile(join(root, "bin", "nekocli"), "#!/bin/sh\nexit 0\n");
    await chmod(join(root, "bin", "nekocli"), options.legacyExecutable === false ? 0o644 : 0o755);
  }
  if (options.entry !== false) await writeFile(join(root, "bin", "nekocli.mjs"), "\n");
  if (options.built !== false) await writeFile(join(root, "dist", "nekocli.js"), "\n");
  // The resolver walks up from a module, so it is handed a directory below.
  await mkdir(join(root, "src", "tools"), { recursive: true });
  return { root, from: join(root, "src", "tools") };
}

describe("the default shape", () => {
  test("sends one tool and the nekocli section", async () => {
    const fixture = await createSdkFixture({ useDefaultSystemPrompt: true });
    try {
      expect(fixture.session.getActiveToolNames()).toEqual(["bash"]);
      fixture.setResponses([context => {
        expect(getCurrentTools(context.messages).map(tool => tool.name)).toEqual(["bash"]);
        const prompt = getCurrentSystemPrompt(context.messages);
        expect(prompt).toContain(NEKOCLI_GUIDANCE);
        return fauxAssistantMessage("Ready.");
      }]);
      await fixture.session.prompt("Report readiness.");
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  });

  test("a bash call the model makes can run nek and legacy nekocli", async () => {
    // The claim the prompt makes, tested the way the model experiences it:
    // through a real bash tool call in a real session. Every other test here
    // checks a piece. This one checks that the pieces are connected, which is
    // the part that was broken while every piece worked.
    const fixture = await createSdkFixture({ useDefaultSystemPrompt: true });
    try {
      fixture.setResponses([
        fauxAssistantMessage(fauxToolCall("bash", { command: "nek --help && nekocli --help" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("It runs."),
      ]);
      await fixture.session.prompt("Check that nek is available.");
      const result = fixture.session.messages.find(message => message.role === "toolResult");
      expect(result?.role === "toolResult" && result.isError).toBe(false);
      const text = JSON.stringify(result);
      expect(text, "the model's shell could not find nek or nekocli").not.toContain("command not found");
      expect(text.split("nekocli <command>")).toHaveLength(3);
      // Every command the prompt advertises is in the help it just received,
      // read from the code rather than written out: the same list hardcoded in
      // three places all went stale when `lsp` was retired.
      for (const command of COMMAND_NAMES) {
        expect(text).toContain(`  ${command} `);
      }
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  }, 30_000);

  test("deselects a covered tool even when the host selects it", async () => {
    // The prompt says bash is the only tool. A session that also sent `read`
    // would be teaching the model to disbelieve one of the two.
    const fixture = await createSdkFixture({ tools: ["read", "bash"] });
    try {
      expect(fixture.session.getActiveToolNames()).toEqual(["bash"]);
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  });

  test("keeps a host selection that has no native bash", async () => {
    const fixture = await createSdkFixture({ useDefaultSystemPrompt: true, tools: ["read"] });
    try {
      expect(fixture.session.getActiveToolNames()).toEqual(["read"]);
      fixture.setResponses([context => {
        expect(getCurrentTools(context.messages).map(tool => tool.name)).toEqual(["read"]);
        expect(getCurrentSystemPrompt(context.messages)).not.toContain(NEKOCLI_GUIDANCE);
        return fauxAssistantMessage("Ready.");
      }]);
      await fixture.session.prompt("Report readiness.");
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  });

  test("the six tool shape is one setting away", async () => {
    const fixture = await createSdkFixture({ useDefaultSystemPrompt: true, sixTools: true });
    try {
      expect(fixture.session.getActiveToolNames().sort())
        .toEqual(["bash", "edit", "find", "grep", "read", "write"]);
      expect(fixture.session.systemPrompt).not.toContain("nekocli");
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  });

  test("puts nek where a spawned command will find it", async () => {
    // Pi builds the environment for each bash call from `process.env`, so the
    // shape needs nothing from the user's shell profile. This is the committed
    // launcher, resolved from this checkout.
    const found = await launcher();
    expect(found?.command).toEndWith(join("bin", "nek"));
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    expect(exposeOnPath("/opt/nekopi/bin", env)).toBe(true);
    expect(env.PATH).toBe(`/opt/nekopi/bin${delimiter}/usr/bin`);
    // Idempotent, because the session can reload.
    expect(exposeOnPath("/opt/nekopi/bin", env)).toBe(false);
    expect(env.PATH).toBe(`/opt/nekopi/bin${delimiter}/usr/bin`);
  });

  test("Windows spells the variable differently and must not gain a second one", () => {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Windows" };
    expect(exposeOnPath("C:\\nekopi\\bin", env)).toBe(true);
    expect(env.Path).toBe(`C:\\nekopi\\bin${delimiter}C:\\Windows`);
    expect(env.PATH).toBeUndefined();
  });

  for (const [missing, options] of [
    ["the short launcher", { alias: false }],
    ["the legacy launcher", { legacy: false }],
    ["the entry beside it", { entry: false }],
    ["the built bundle", { built: false }],
    ["the short executable bit", { executable: false }],
    ["the legacy executable bit", { legacyExecutable: false }],
  ] as const) {
    test(`reports nothing when ${missing} is absent`, async () => {
      const { root, from } = await checkout(options);
      try { expect(await launcher(from)).toBeUndefined(); }
      finally { await rm(root, { recursive: true, force: true }); }
    });
  }

  test("resolves a complete checkout from a module below it", async () => {
    const { root, from } = await checkout();
    try {
      const found = await launcher(from);
      expect(found).toEqual({ command: join(root, "bin", "nek"), directory: join(root, "bin") });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("falls back to the six tools rather than a prompt that cannot work", async () => {
    // What a clone before `bun run build` looks like. The shape must not ship
    // a prompt whose every instruction returns "command not found", which is
    // what an unreachable `nek` would have produced in the bench image.
    const fixture = await createSdkFixture({ useDefaultSystemPrompt: true, brokenLauncher: true });
    try {
      expect(fixture.session.getActiveToolNames().sort())
        .toEqual(["bash", "edit", "find", "grep", "read", "write"]);
      fixture.setResponses([context => {
        const prompt = getCurrentSystemPrompt(context.messages);
        // The claim and the tools have to agree, in both directions.
        expect(prompt).not.toContain("nekocli");
        expect(prompt).not.toContain("  nek grep");
        expect(prompt).not.toContain("bash is your only tool");
        expect(getCurrentTools(context.messages).map(tool => tool.name)).toContain("read");
        return fauxAssistantMessage("Ready.");
      }]);
      await fixture.session.prompt("Report readiness.");
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  });

  test("a diagnostics setting the shape cannot honour is not silently ignored", async () => {
    // The post-edit report attaches to the `edit` and `write` tools, so the
    // default shape has no consumer for it. Doing nothing quietly is the
    // failure mode worth preventing; the session says so instead.
    const notices: string[] = [];
    const fixture = await createSdkFixture({ globalConfig: { diagnostics: { enabled: true } },
      extensions: [pi => { pi.on("session_start", (_event, ctx) => {
        if (ctx.hasUI) notices.push("ui");
      }); }] });
    try {
      expect(fixture.session.getActiveToolNames()).toEqual(["bash"]);
      // The semantic layer is not built either, since nothing would read it.
      expect(fixture.session.getToolDefinition("lsp")).toBeUndefined();
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.cleanup(); }
  });
});
