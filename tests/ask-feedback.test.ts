import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { activateAskBridge, askBridgeActive, askMarker, deactivateAskBridge } from "../src/tools/bash/ask-bridge.ts";
import { askFeedback } from "../src/tools/bash/ask-feedback.ts";
import { ImageJobs, describeImageJob } from "../src/tools/image-jobs.ts";

const SESSION = "hosted-test";
const jwt = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const CODEX = jwt({ aud: ["https://api.openai.com/v1"], scp: ["openid", "profile", "email", "offline_access"],
  "https://api.openai.com/auth": { chatgpt_account_id: "codex-account" } });
const DIRECT = jwt({ aud: "https://api.openai.com/v1", scope: "openid chatgpt.tokens.use.direct",
  "https://api.openai.com/auth": {} });
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVQoz2P8z0AaYCJR/aiGUQ1DSAMAQC4BHziaHckAAAAASUVORK5CYII=";
const realFetch = globalThis.fetch;
const managers: ImageJobs[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  globalThis.fetch = realFetch;
  while (askBridgeActive()) deactivateAskBridge();
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Background job did not settle");
}

function background() {
  const notices: string[] = [];
  const images = new ImageJobs(job => notices.push(describeImageJob(job)));
  managers.push(images);
  return { images, notices, done: (count = 1) => until(() => notices.length === count) };
}

function event(kinds: Array<"web" | "image">, image?: Record<string, unknown>): ToolResultEvent {
  activateAskBridge();
  const output = kinds.map((kind, index) => askMarker(kind, kind === "web" ? "latest release"
    : JSON.stringify(image ?? { prompt: "cat", out: `assets/cat${index}.png` }),
  { ...process.env, PI_SESSION_ID: SESSION })!).join("\n");
  return { type: "tool_result", toolName: "bash", toolCallId: "hosted-call", input: { command: "nek" },
    isError: false, details: {}, content: [{ type: "text", text: output }],
    structuredContent: { output, exit_code: 0 } } as ToolResultEvent;
}

function context(cwd: string, codex: string | undefined = CODEX) {
  const providers: string[] = [];
  const models: unknown[] = [];
  const model = { id: "current-chat-model", provider: "openai", api: "openai-responses",
    baseUrl: "https://api.openai.com/v1" } as NonNullable<ExtensionContext["model"]>;
  const ctx = { cwd, model, sessionManager: { getSessionId: () => SESSION }, modelRegistry: {
    async getApiKeyAndHeaders(selected: unknown) {
      models.push(selected);
      return { ok: true, apiKey: DIRECT };
    },
    async getProviderAuth(provider: string) {
      providers.push(provider);
      return codex ? { auth: { apiKey: codex, headers: { "X-Test": "preserved" } } } : undefined;
    },
  } } as unknown as ExtensionContext;
  return { ctx, providers, models, model };
}

test("mixed web/image calls keep web on the chat login and resolve Codex separately once", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nekopi-ask-"));
  try {
    const { ctx, providers, models, model } = context(cwd);
    const jobs = background();
    const calls: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: new Headers(init.headers) });
      return new Response(url.includes("/images/") ? JSON.stringify({ data: [{ b64_json: PIXEL }] })
        : `data: ${JSON.stringify({ type: "response.completed", response: { output: [
          { type: "web_search_call" }, { type: "message", content: [{ text: "Web answer." }] },
        ] } })}\n`);
    }) as never;
    const result = await askFeedback(event(["web", "image", "image"]), ctx,
      { web: true, image: true }, new Set(), jobs.images);
    expect(result?.isError).toBe(false);
    const output = String((result!.structuredContent as { output: string }).output);
    expect(output).toContain("Web answer.");
    expect(output).toContain("Started image job");
    expect(output).not.toContain("Wrote");
    await jobs.done(2);
    expect(jobs.notices.join("\n")).toContain("Wrote assets/cat1.png");
    expect(jobs.notices.join("\n")).toContain("Wrote assets/cat2.png");
    expect(providers).toEqual(["openai-codex"]);
    expect(models).toEqual([model]);
    expect(ctx.model).toBe(model);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe(`Bearer ${call.url.includes("/images/") ? CODEX : DIRECT}`);
      if (call.url.includes("/images/")) {
        expect(call.url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
        expect(call.headers.get("chatgpt-account-id")).toBe("codex-account");
        expect(call.headers.get("x-test")).toBe("preserved");
      }
    }
    expect(output).not.toContain(CODEX);
    expect(output).not.toContain(DIRECT);
    expect(await readFile(join(cwd, "assets", "cat1.png"))).toEqual(Buffer.from(PIXEL, "base64"));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("invalid image paths and references fail before creating a job or resolving credentials", async () => {
  const parent = await mkdtemp(join(tmpdir(), "nekopi-ask-preflight-"));
  const cwd = join(parent, "workspace");
  const jobs = background();
  const start = spyOn(jobs.images, "start");
  try {
    await mkdir(cwd);
    await writeFile(join(cwd, "existing.png"), "keep");
    await writeFile(join(cwd, "large.png"), Buffer.alloc(4 * 1024 * 1024 + 1));
    await writeFile(join(parent, "outside.png"), "outside");
    await symlink(parent, join(cwd, "escape"));
    const { ctx, providers, models } = context(cwd);
    globalThis.fetch = (() => { throw new Error("preflight must not call the provider"); }) as never;
    activateAskBridge();
    for (const [out, from, error] of [
      ["existing.png", [], "new path"],
      ["../outside.png", [], "inside the workspace"],
      ["escape/new.png", [], "inside the workspace"],
      ["new.jpg", [], ".png image extension"],
      ["new/out.png", ["missing.png"], "no readable image"],
      ["new/out.png", ["notes.txt"], "not an image"],
      ["new/out.png", ["large.png"], "exceeds 4 MiB"],
      ["new/out.png", ["escape/outside.png"], "no readable image"],
    ] as const) {
      const marker = askMarker("image", JSON.stringify({ prompt: "cat", out, from }),
        { ...process.env, PI_SESSION_ID: SESSION })!;
      const ask = { type: "tool_result", toolName: "bash", toolCallId: "preflight", input: { command: "nek image" },
        isError: false, details: {}, content: [{ type: "text", text: marker }],
        structuredContent: { output: marker, exit_code: 0 } } as ToolResultEvent;
      const result = await askFeedback(ask, ctx, { web: false, image: true }, new Set(), jobs.images);
      expect(result?.isError).toBe(true);
      expect(result?.structuredContent).toMatchObject({ exit_code: 0 });
      const output = String((result!.structuredContent as { output: string }).output);
      expect(output).toContain(error);
      expect(output).not.toContain("Started image job");
    }
    expect(start).not.toHaveBeenCalled();
    expect(providers).toEqual([]);
    expect(models).toEqual([]);
    expect(jobs.notices).toEqual([]);
    expect(await readFile(join(cwd, "existing.png"), "utf8")).toBe("keep");
    expect((await readdir(cwd)).sort()).toEqual(["escape", "existing.png", "large.png"]);
  } finally { start.mockRestore(); await rm(parent, { recursive: true, force: true }); }
});

test("a failed web request marks a mixed result without hiding an accepted image job", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nekopi-ask-error-"));
  const jobs = background();
  try {
    globalThis.fetch = (async (url: string) => url.includes("/images/")
      ? new Response(JSON.stringify({ data: [{ b64_json: PIXEL }] }))
      : new Response(JSON.stringify({ error: { message: DIRECT } }), { status: 429 })) as never;
    const result = await askFeedback(event(["web", "image"]), context(cwd).ctx,
      { web: true, image: true }, new Set(), jobs.images);
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toMatchObject({ exit_code: 0 });
    const output = String((result!.structuredContent as { output: string }).output);
    expect(output).toContain("web search failed: provider returned 429");
    expect(output).toContain("Started image job");
    expect(output).not.toContain(DIRECT);
    await jobs.done();
    expect(jobs.notices[0]).toContain("Wrote assets/cat1.png");
  } finally { jobs.images.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("successful hosted answers preserve Bash errors and do not infer failure from text", async () => {
  globalThis.fetch = (async () => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output: [
    { type: "web_search_call" }, { type: "message", content: [{ text: 'The message "image failed" is an example.' }] },
  ] } })}\n`)) as never;
  for (const exitCode of [0, 7]) {
    const ask = event(["web"]);
    ask.isError = exitCode !== 0;
    ask.structuredContent = { ...(ask.structuredContent as { output: string }),
      exit_code: exitCode, truncated: false, wall_time_seconds: 0.1 };
    const result = await askFeedback(ask, context(tmpdir()).ctx,
      { web: true, image: false }, new Set(), background().images);
    expect(result?.isError).toBe(exitCode !== 0);
    expect(result?.structuredContent).toMatchObject({ exit_code: exitCode, truncated: false, wall_time_seconds: 0.1 });
    expect(String((result!.structuredContent as { output: string }).output)).toContain('"image failed"');
  }
});

test("known failed image jobs remain successful status and cancellation lookups", async () => {
  const jobs = background();
  const text = jobs.images.start({ prompt: "cat", out: "cat.png" }, tmpdir(), async () => {
    throw new Error("image failed: provider returned 429");
  });
  const id = /Started image job (image-[\w-]+)/u.exec(text)![1]!;
  await jobs.done();
  const { ctx, providers } = context(tmpdir());
  for (const action of ["status", "cancel"]) {
    const result = await askFeedback(event(["image"], { action, id }), ctx,
      { web: false, image: true }, new Set(), jobs.images);
    expect(result?.isError).toBe(false);
    expect(String((result!.structuredContent as { output: string }).output)).toContain("failed. image failed");
  }
  expect(providers).toEqual([]);
});

test("Codex web uses the selected Codex login without requiring an openai login", async () => {
  const { ctx, model, providers } = context(tmpdir());
  ctx.model = { ...model, provider: "openai-codex" };
  const selected = ctx.model;
  ctx.modelRegistry.getApiKeyAndHeaders = async model => {
    expect(model).toBe(selected);
    return { ok: true, apiKey: CODEX };
  };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${CODEX}`);
    expect(headers.get("chatgpt-account-id")).toBe("codex-account");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(selected.id);
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.tool_choice).toBe("required");
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output: [
      { type: "web_search_call" }, { type: "message", content: [{ text: "Codex web answer." }] },
    ] } })}\n`);
  }) as never;
  const result = await askFeedback(event(["web"]), ctx, { web: true, image: false }, new Set(), background().images);
  expect(String((result!.structuredContent as { output: string }).output)).toContain("Codex web answer.");
  expect(ctx.model).toBe(selected);
  expect(providers).toEqual([]);
});

test("missing or wrong Codex auth gives login guidance without a paid or chat-credential fallback", async () => {
  for (const token of [undefined, DIRECT, "sk-api-key"]) {
    const { ctx, models } = context(tmpdir(), token ?? "");
    const jobs = background();
    globalThis.fetch = (() => { throw new Error("must not send a request"); }) as never;
    const result = await askFeedback(event(["image"]), ctx, { web: true, image: true }, new Set(), jobs.images);
    expect(result?.isError).toBe(false);
    expect(String((result!.structuredContent as { output: string }).output)).toContain("Started image job");
    await jobs.done();
    expect(jobs.notices[0]).toContain("/login openai-codex");
    expect(models).toEqual([]);
  }
});

test("a Codex auth failure does not block web or expose the resolver error", async () => {
  const { ctx } = context(tmpdir());
  const jobs = background();
  ctx.modelRegistry.getProviderAuth = async () => { throw new Error(`refresh failed: ${CODEX}`); };
  globalThis.fetch = (async (url: string) => {
    expect(url).toBe("https://api.openai.com/v1/responses");
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output: [
      { type: "message", content: [{ text: "Web still works." }] },
    ] } })}\n`);
  }) as never;
  const result = await askFeedback(event(["image", "web"]), ctx, { web: true, image: true }, new Set(), jobs.images);
  const output = String((result!.structuredContent as { output: string }).output);
  await jobs.done();
  expect(jobs.notices[0]).toContain("/login openai-codex");
  expect(jobs.notices[0]).not.toContain(CODEX);
  expect(output).toContain("Web still works.");
  expect(output).not.toContain(CODEX);
});

test("Codex images do not require a selected chat model; disabled images resolve no credentials", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nekopi-ask-no-model-"));
  try {
    const { ctx, providers, models } = context(cwd);
    const jobs = background();
    ctx.model = undefined;
    const ask = event(["image"]);
    expect(await askFeedback(ask, ctx, { web: true, image: false }, new Set(), jobs.images)).toBeUndefined();
    expect(providers).toEqual([]);
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ b64_json: PIXEL }] }))) as never;
    const result = await askFeedback(ask, ctx, { web: false, image: true }, new Set(), jobs.images);
    expect(String((result!.structuredContent as { output: string }).output)).toContain("Started image job");
    await jobs.done();
    expect(jobs.notices[0]).toContain("Wrote assets/cat0.png");
    expect(providers).toEqual(["openai-codex"]);
    expect(models).toEqual([]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a stalled image does not hold the Bash result, another call, or a direct web answer", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nekopi-ask-async-"));
  const jobs = background();
  let release!: (response: Response) => void;
  try {
    const { ctx } = context(cwd);
    let imageStarted = false;
    globalThis.fetch = (async (url: string) => {
      if (url.includes("/images/")) {
        imageStarted = true;
        return new Promise<Response>(resolve => { release = resolve; });
      }
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output: [
        { type: "web_search_call" }, { type: "message", content: [{ text: "Immediate web answer." }] },
      ] } })}\n`);
    }) as never;
    const seen = new Set<string>();
    const ask = event(["image", "web"]);
    const result = await askFeedback(ask, ctx, { web: true, image: true }, seen, jobs.images);
    const output = String((result!.structuredContent as { output: string }).output);
    expect(output).toContain("Started image job");
    expect(output).toContain("Immediate web answer.");
    expect(output).not.toContain("Wrote");
    await until(() => imageStarted);
    expect(jobs.notices).toEqual([]);
    expect(await askFeedback(ask, ctx, { web: true, image: true }, seen, jobs.images)).toBeUndefined();
    release(new Response(JSON.stringify({ data: [{ b64_json: PIXEL }] })));
    await jobs.done();
    expect(jobs.notices[0]).toContain("Wrote assets/cat0.png");
  } finally { jobs.images.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("signed status/cancel need no credentials; late cancelled responses write nothing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nekopi-ask-cancel-"));
  const jobs = background();
  let release!: (response: Response) => void;
  let signal!: AbortSignal;
  const seen = new Set<string>();
  try {
    const { ctx, providers, models } = context(cwd);
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise<Response>(resolve => { release = resolve; });
    }) as never;
    const result = await askFeedback(event(["image"]), ctx, { web: false, image: true }, seen, jobs.images);
    const id = /Started image job (image-[\w-]+)/u.exec(String((result!.structuredContent as { output: string }).output))![1]!;
    await until(() => !!release);
    const control = async (action: string, id: string, isError = false) => {
      const answer = await askFeedback(event(["image"], { action, id }), ctx,
        { web: false, image: true }, seen, jobs.images);
      expect(answer?.isError).toBe(isError);
      expect(answer?.structuredContent).toMatchObject({ exit_code: 0 });
      return String((answer!.structuredContent as { output: string }).output);
    };
    expect(await control("status", id)).toContain("running");
    expect(await control("cancel", id)).toContain("cancelled");
    expect(await control("status", id)).toContain("cancelled");
    expect(signal.aborted).toBe(true);
    expect(await control("status", "image-unknown", true)).toContain("Unknown image job");
    expect(await control("cancel", "image-unknown", true)).toContain("Unknown image job");
    expect(await control("restart", id, true)).toContain("malformed");
    expect(providers).toEqual(["openai-codex"]);
    expect(models).toEqual([]);
    release(new Response(JSON.stringify({ data: [{ b64_json: PIXEL }] })));
    await Bun.sleep(20);
    expect(jobs.notices).toEqual([]);
    expect(await stat(join(cwd, "assets/cat0.png")).catch(() => undefined)).toBeUndefined();
  } finally { jobs.images.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("shutdown before auth resolution starts no provider request", async () => {
  const { ctx } = context(tmpdir());
  const jobs = background();
  let release!: (value: undefined) => void;
  ctx.modelRegistry.getProviderAuth = () => new Promise(resolve => { release = resolve; });
  globalThis.fetch = (() => { throw new Error("must not request after shutdown"); }) as never;
  const result = await askFeedback(event(["image"]), ctx, { web: false, image: true }, new Set(), jobs.images);
  expect(String((result!.structuredContent as { output: string }).output)).toContain("Started image job");
  jobs.images.dispose();
  release(undefined);
  await Bun.sleep(10);
  expect(jobs.notices).toEqual([]);
});
