import { afterEach, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { createSdkFixture } from "./helpers/model-server.ts";

const CODEX = `x.${Buffer.from(JSON.stringify({ scope: "openid profile",
  "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.y`;
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVQoz2P8z0AaYCJR/aiGUQ1DSAMAQC4BHziaHckAAAAASUVORK5CYII=";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Session did not receive the background result");
}

async function fixture() {
  let observed: ToolResultEvent | undefined;
  const result = await createSdkFixture({ globalConfig: { image: { enabled: true } }, extensions: [pi => {
    pi.on("tool_result", event => { observed = event; });
    pi.on("session_start", (_event, ctx) => {
      ctx.modelRegistry.getProviderAuth = async provider => {
        expect(provider).toBe("openai-codex");
        return { auth: { apiKey: CODEX } };
      };
    });
  }] });
  let release!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    signal = init.signal as AbortSignal;
    // Deliberately ignore cancellation to test the post-response write guard too.
    return new Promise<Response>(resolve => { release = resolve; });
  }) as never;
  const command = `PI_SESSION_ID=${result.session.sessionManager.getSessionId()} nek image 'an orange cat' --out assets/cat.png`;
  const submit = fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
  return { ...result, submit, started: () => !!release, signal: () => signal, observed: () => observed,
    release: (status = 200) => release(new Response(JSON.stringify(status === 200
      ? { data: [{ b64_json: PIXEL }] } : { error: { message: CODEX } }), { status })) };
}

for (const exitCode of [0, 7]) {
  test(`real SDK marks image preflight errors without changing Bash exit ${exitCode} or chaining`, async () => {
    const f = await fixture();
    try {
      const command = `PI_SESSION_ID=${f.session.sessionManager.getSessionId()} nek image 'cat' --out invalid.jpg`
        + ` && printf 'CHAIN_RAN\\n'; exit ${exitCode}`;
      f.setResponses([
        fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }),
        fauxAssistantMessage("The image input was rejected."),
      ]);
      await f.session.prompt("Test the image preflight and shell chain.");
      const result = f.session.messages.find(message => message.role === "toolResult");
      expect(result?.role === "toolResult" && result.isError).toBe(true);
      expect(f.observed()).toMatchObject({ isError: true, structuredContent: { exit_code: exitCode,
        output: expect.stringContaining("CHAIN_RAN") } });
      expect(JSON.stringify(result)).toContain("image failed: --out needs a .png");
      expect(f.started()).toBe(false);
      expect(f.session.messages.filter(message => message.role === "custom" && message.customType === "nekopi:image-job"))
        .toHaveLength(0);
      expect(f.errors).toEqual([]);
    } finally { await f.cleanup(); }
  });
}

for (const phase of ["idle", "busy"] as const) {
  test(`real SDK delivers one completion follow-up while ${phase} and allows work before completion`, async () => {
    const f = await fixture();
    let continueWork!: () => void;
    let working = false;
    try {
      f.setResponses([
        f.submit,
        async context => {
          expect(JSON.stringify(context.messages)).toContain("Started image job");
          expect(JSON.stringify(context.messages)).not.toContain("Wrote assets/cat.png");
          working = true;
          if (phase === "busy") await new Promise<void>(resolve => { continueWork = resolve; });
          return fauxAssistantMessage("I can continue coding before the image finishes.");
        },
        context => {
          expect(JSON.stringify(context.messages)).toContain("Wrote assets/cat.png");
          return fauxAssistantMessage("The image is ready.");
        },
      ]);
      const turn = f.session.prompt("Generate the image and continue working.");
      await until(() => f.started() && working);
      if (phase === "idle") await turn;
      expect(f.requests).toHaveLength(2);
      expect(await stat(join(f.cwd, "assets/cat.png")).catch(() => undefined)).toBeUndefined();
      f.release();
      if (phase === "busy") {
        // Notification must queue a follow-up rather than interrupt the current response.
        await until(async () => !!await stat(join(f.cwd, "assets/cat.png")).catch(() => undefined));
        expect(f.requests).toHaveLength(2);
        continueWork();
      }
      await turn;
      await until(() => f.requests.length === 3 && !f.session.isStreaming);
      const messages = f.session.messages.filter(message => message.role === "custom" && message.customType === "nekopi:image-job");
      expect(messages).toHaveLength(1);
      expect(await readFile(join(f.cwd, "assets/cat.png"))).toEqual(Buffer.from(PIXEL, "base64"));
      expect(f.errors).toEqual([]);
    } finally { continueWork?.(); await f.cleanup(); }
  });
}

test("real SDK wakes the idle agent on failure without exposing provider error bodies", async () => {
  const f = await fixture();
  try {
    f.setResponses([f.submit, fauxAssistantMessage("Continuing other work."), context => {
      const text = JSON.stringify(context.messages);
      expect(text).toContain("failed. image failed: provider returned 429");
      expect(text).not.toContain(CODEX);
      return fauxAssistantMessage("The image provider rejected this request.");
    }]);
    await f.session.prompt("Generate an image.");
    await until(f.started);
    f.release(429);
    await until(() => f.requests.length === 3 && !f.session.isStreaming);
    expect(await stat(join(f.cwd, "assets/cat.png")).catch(() => undefined)).toBeUndefined();
    expect(f.errors).toEqual([]);
  } finally { await f.cleanup(); }
});

for (const reason of ["reload", "new", "quit"] as const) {
  test(`real SDK ${reason} aborts jobs without a late write or cross-session notification`, async () => {
    const f = await fixture();
    try {
      f.setResponses([f.submit, fauxAssistantMessage("Working while the image runs.")]);
      await f.session.prompt("Generate an image.");
      await until(f.started);
      if (reason === "reload") await f.session.reload();
      else await f.session.extensionRunner.emit({ type: "session_shutdown", reason });
      expect(f.signal()?.aborted).toBe(true);
      f.release();
      await Bun.sleep(30);
      expect(await stat(join(f.cwd, "assets/cat.png")).catch(() => undefined)).toBeUndefined();
      expect(f.session.messages.filter(message => message.role === "custom" && message.customType === "nekopi:image-job")).toHaveLength(0);
      expect(f.requests).toHaveLength(2);
      expect(f.errors).toEqual([]);
    } finally { await f.cleanup(); }
  });
}
