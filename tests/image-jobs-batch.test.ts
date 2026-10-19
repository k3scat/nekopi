import { afterEach, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createSdkFixture } from "./helpers/model-server.ts";

const CODEX = `x.${Buffer.from(JSON.stringify({ scope: "openid profile",
  "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.y`;
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVQoz2P8z0AaYCJR/aiGUQ1DSAMAQC4BHziaHckAAAAASUVORK5CYII=";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Image batch did not settle");
}

for (const mode of ["sequential shell", "parallel shell with wait", "separate Bash calls"] as const) {
  test(`real SDK returns four image IDs and independent completion/failure notifications: ${mode}`, async () => {
    const f = await createSdkFixture({ globalConfig: { image: { enabled: true } }, extensions: [pi => {
      pi.on("session_start", (_event, ctx) => {
        ctx.modelRegistry.getProviderAuth = async () => ({ auth: { apiKey: CODEX } });
      });
    }] });
    const pending = new Map<string, (response: Response) => void>();
    try {
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        const { prompt } = JSON.parse(String(init.body)) as { prompt: string };
        return new Promise<Response>(resolve => { pending.set(prompt, resolve); });
      }) as never;
      const commands = Array.from({ length: 4 }, (_, i) => `nek image 'cat-${i}' --out assets/cat-${i}.png`);
      const calls = mode === "separate Bash calls" ? commands.map(command => fauxToolCall("bash", { command }))
        : [fauxToolCall("bash", { command: mode === "parallel shell with wait"
          ? commands.join(" & ") + " & wait" : commands.join("; ") })];
      f.setResponses([fauxAssistantMessage(calls, { stopReason: "toolUse" }),
        fauxAssistantMessage("Continuing work while the four image jobs run.")]);
      await f.session.prompt("Submit four image jobs.");
      await until(() => pending.size === 4);
      const submitted = JSON.stringify(f.session.messages.filter(message => message.role === "toolResult"));
      const ids = [...submitted.matchAll(/Started image job (image-[\w-]+)/gu)].map(match => match[1]!);
      expect(new Set(ids).size).toBe(4);
      expect(submitted).not.toContain("[nekopi:ask:");
      expect(f.session.messages.filter(message => message.role === "custom" && message.customType === "nekopi:image-job"))
        .toHaveLength(0);
      for (let i = 0; i < 4; i++) {
        expect(await stat(join(f.cwd, `assets/cat-${i}.png`)).catch(() => undefined)).toBeUndefined();
      }

      const status = async () => {
        f.setResponses([fauxAssistantMessage(fauxToolCall("bash", {
          command: ids.map(id => `nek image --status ${id}`).join("; "),
        }), { stopReason: "toolUse" }), fauxAssistantMessage("Checked all four image jobs.")]);
        await f.session.prompt("Check all image statuses.");
        return JSON.stringify(f.session.messages.filter(message => message.role === "toolResult").at(-1));
      };
      expect([...(await status()).matchAll(/: running\./gu)]).toHaveLength(4);

      for (const index of [3, 1, 0, 2]) {
        const requestsBefore = f.requests.length;
        f.setResponses([fauxAssistantMessage("Received one image job result.")]);
        pending.get(`cat-${index}`)!(new Response(JSON.stringify(index % 2 === 0
          ? { data: [{ b64_json: PIXEL }] } : { error: { message: "fixture failure" } }),
        { status: index % 2 === 0 ? 200 : 429 }));
        await until(() => f.requests.length === requestsBefore + 1 && !f.session.isStreaming);
      }

      const notices = f.session.messages.filter(message => message.role === "custom" && message.customType === "nekopi:image-job");
      expect(notices).toHaveLength(4);
      for (const id of ids) expect(notices.filter(message => JSON.stringify(message).includes(id))).toHaveLength(1);
      const terminal = await status();
      expect([...terminal.matchAll(/: completed\./gu)]).toHaveLength(2);
      expect([...terminal.matchAll(/: failed\./gu)]).toHaveLength(2);
      for (let i = 0; i < 4; i++) {
        const file = join(f.cwd, `assets/cat-${i}.png`);
        if (i % 2 === 0) expect(await readFile(file)).toEqual(Buffer.from(PIXEL, "base64"));
        else expect(await stat(file).catch(() => undefined)).toBeUndefined();
      }
      expect(f.errors).toEqual([]);
    } finally { await f.cleanup(); }
  });
}
