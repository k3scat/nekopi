import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postHosted, type HostedTarget } from "../src/tools/hosted.ts";
import { generateImage } from "../src/tools/image.ts";
import { searchWeb } from "../src/tools/web.ts";

const target: HostedTarget = { url: "https://example.invalid/responses", codex: false, model: "fixture" };
const auth = { apiKey: "fixture-secret" };
const realFetch = globalThis.fetch;
let keepAlive: ReturnType<typeof setInterval>;
// AbortSignal.timeout uses unreferenced timers; mocked fetches have no live sockets.
beforeEach(() => { keepAlive = setInterval(() => {}, 10); });
afterEach(() => { clearInterval(keepAlive); globalThis.fetch = realFetch; });

test("web and image defaults and overrides reach the HTTP deadline", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nekopi-hosted-timeout-"));
  const timeout = spyOn(AbortSignal, "timeout");
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVQoz2P8z0AaYCJR/aiGUQ1DSAMAQC4BHziaHckAAAAASUVORK5CYII=";
  try {
    globalThis.fetch = (async () => new Response(`data: ${JSON.stringify({ type: "response.completed",
      response: { output: [{ type: "web_search_call" }, { type: "message", content: [{ text: "Found." }] }] } })}\n`)) as never;
    await searchWeb("query", target, auth);
    expect(timeout).toHaveBeenLastCalledWith(300_000);
    await searchWeb("query", target, auth, undefined, 420);
    expect(timeout).toHaveBeenLastCalledWith(420_000);
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ b64_json: pixel }] }))) as never;
    await generateImage({ prompt: "cat", out: "default.png" }, cwd, target, auth);
    expect(timeout).toHaveBeenLastCalledWith(180_000);
    await generateImage({ prompt: "cat", out: "custom.png" }, cwd, target, auth, undefined, 600);
    expect(timeout).toHaveBeenLastCalledWith(600_000);
  } finally { timeout.mockRestore(); await rm(cwd, { recursive: true, force: true }); }
});

test("a request timeout reports the tool and total limit without retrying", async () => {
  let calls = 0;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls++;
    const signal = init.signal!;
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as never;
  await expect(postHosted("web search", target, auth, {}, 20))
    .rejects.toThrow("web search failed: request timed out after 0.02 seconds (total HTTP request limit).");
  expect(calls).toBe(1);
});

test("the total deadline still aborts a response body after headers and first data", async () => {
  globalThis.fetch = (async (_url: string, init: RequestInit) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: partial\n"));
      init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
    },
  }))) as never;
  await expect(postHosted("image", target, auth, {}, 20))
    .rejects.toThrow("image failed: request timed out after 0.02 seconds (total HTTP request limit).");
});

test("caller cancellation is preserved rather than reported as a timeout", async () => {
  const controller = new AbortController();
  const reason = new Error("Cancelled by caller");
  globalThis.fetch = (async (_url: string, init: RequestInit) => new Response(new ReadableStream({
    start(body) {
      init.signal!.addEventListener("abort", () => body.error(init.signal!.reason), { once: true });
      queueMicrotask(() => controller.abort(reason));
    },
  }))) as never;
  await expect(postHosted("image", target, auth, {}, 1000, controller.signal)).rejects.toBe(reason);
});

test("an image request timeout writes no output file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nekopi-image-timeout-"));
  const realTimeout = AbortSignal.timeout;
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(20));
  globalThis.fetch = (async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })) as never;
  try {
    await expect(generateImage({ prompt: "cat", out: "cat.png" }, cwd, target, auth, undefined, 600))
      .rejects.toThrow("image failed: request timed out after 600 seconds");
    expect(timeout).toHaveBeenCalledWith(600_000);
    expect(await stat(join(cwd, "cat.png")).catch(() => undefined)).toBeUndefined();
  } finally { timeout.mockRestore(); await rm(cwd, { recursive: true, force: true }); }
});

test("provider errors retain their status and are not retried", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ secret: auth.apiKey }), { status: 504 });
  }) as never;
  await expect(postHosted("web search", target, auth, {}, 1000))
    .rejects.toThrow("web search failed: provider returned 504.");
  expect(calls).toBe(1);
});
