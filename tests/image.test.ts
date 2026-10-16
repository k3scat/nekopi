/**
 * The image tool writes a file at a path the model chose, so containment is
 * the property under test. Generation itself is one provider request; what
 * nekopi owns is the request shape, the path rule and the one line it reports.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectImage, generateImage, IMAGE_HELP, mimeFor, parseRequest,
  type ImageRequest } from "../src/tools/image.ts";
import type { HostedAuth, HostedTarget } from "../src/tools/hosted.ts";
import { runNekocli } from "../src/nekocli.ts";
import { activateAskBridge, asksIn, deactivateAskBridge } from "../src/tools/bash/ask-bridge.ts";

const TARGET: HostedTarget = { url: "https://chatgpt.com/backend-api/codex/images/generations",
  codex: true, model: "gpt-image-2" };
const AUTH: HostedAuth = { apiKey: "token" };
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVQoz2P8z0AaYCJR/aiGUQ1DSAMAQC4BHziaHckAAAAASUVORK5CYII=";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stream(events: unknown[]): string {
  return events.map(event => `data: ${JSON.stringify(event)}`).join("\n");
}

/** A provider response carrying one generated image. */
function generated(result: string): string {
  return stream([
    { type: "response.output_item.done", output_index: 0,
      item: { type: "image_generation_call", result } },
    { type: "response.completed", response: { output: [] } },
  ]);
}

function serve(body: string, ok = true): void {
  globalThis.fetch = (async () => ({ ok, status: ok ? 200 : 429, text: async () => body })) as never;
}

describe("image request", () => {
  test("image help is local, needs no prompt or login, and writes nothing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nekopi-image-help-"));
    try {
      globalThis.fetch = (() => { throw new Error("help must not call the provider"); }) as never;
      for (const flag of ["--help", "-h"]) {
        const result = await runNekocli(["image", flag], cwd,
          async () => { throw new Error("help must not read stdin"); });
        expect(result.failed).toBeUndefined();
        expect(result.text).toBe(IMAGE_HELP);
        expect(result.text).not.toContain("[nekopi:ask:");
        expect(result.text).toContain("not a required form or model schema");
      }
      expect(await readdir(cwd)).toEqual([]);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("repeated --from preserves input order and sends the prompt unchanged", async () => {
    const session = process.env.PI_SESSION_ID;
    activateAskBridge();
    process.env.PI_SESSION_ID = "image-cli-test";
    try {
      const prompt = 'Image 1: edit target. Image 2: style reference.\nText (verbatim): "Hello"';
      const from = ["base.png", "style.jpg", "subject.png", "composition.webp", "palette.png"];
      const result = await runNekocli(["image", prompt, "--out", "new.png",
        ...from.flatMap(path => ["--from", path])], tmpdir(), async () => "");
      expect(result.failed).toBeUndefined();
      const asks = asksIn(result.text, "image-cli-test", new Set());
      expect(asks).toHaveLength(1);
      expect(asks[0]!.kind).toBe("image");
      expect(JSON.parse(asks[0]!.query)).toEqual({ prompt, out: "new.png", from });
    } finally {
      deactivateAskBridge();
      if (session === undefined) delete process.env.PI_SESSION_ID;
      else process.env.PI_SESSION_ID = session;
    }
  });

  test("a request is accepted only when every field is usable", () => {
    const valid: ImageRequest = { prompt: "an orange cat", out: "assets/cat.png" };
    expect(parseRequest(JSON.stringify(valid))).toEqual(valid);
    expect(parseRequest(JSON.stringify({ ...valid, from: ["a.png", "b.png"] })))
      .toEqual({ ...valid, from: ["a.png", "b.png"] });
    const five = ["a.png", "b.png", "c.png", "d.png", "e.png"];
    expect(parseRequest(JSON.stringify({ ...valid, from: five }))).toEqual({ ...valid, from: five });
    for (const bad of [
      "not json", "null", "[]",
      JSON.stringify({ ...valid, prompt: "" }),
      JSON.stringify({ ...valid, prompt: "x".repeat(2_000) }),
      JSON.stringify({ ...valid, out: "" }),
      JSON.stringify({ prompt: "p" }),
      JSON.stringify({ ...valid, from: [...five, "f.png"] }),
      JSON.stringify({ ...valid, from: "a.png" }),
    ]) {
      expect(parseRequest(bad), bad.slice(0, 40)).toBeUndefined();
    }
  });

  test("only the declared image types are accepted", () => {
    expect(mimeFor("a.png")).toBe("image/png");
    expect(mimeFor("a.JPG")).toBe("image/jpeg");
    expect(mimeFor("a.svg")).toBeUndefined();
    expect(mimeFor("noextension")).toBeUndefined();
  });

  test("removed size flags, excess references and oversized requests fail before signing", async () => {
    for (const flag of ["--size", "--size=1024x1024"]) {
      await expect(runNekocli(["image", "a cat", "--out", "cat.png", flag, "1024x1024"], tmpdir()))
        .rejects.toThrow("unexpected argument");
    }
    await expect(runNekocli(["image", "a cat", "--out", "cat.png",
      ...Array.from({ length: 6 }, (_, i) => ["--from", `${i}.png`]).flat()], tmpdir()))
      .rejects.toThrow("up to 5");
    await expect(runNekocli(["image", "a cat", "--out", "cat.png",
      ...Array.from({ length: 5 }, (_, i) => ["--from", `${i}${"x".repeat(500)}.png`]).flat()], tmpdir()))
      .rejects.toThrow("Use shorter paths or a shorter prompt");
    expect(IMAGE_HELP).not.toContain("--size");
  });

  test("job controls sign only their action and ID and reject ambiguous arguments", async () => {
    const session = process.env.PI_SESSION_ID;
    activateAskBridge();
    process.env.PI_SESSION_ID = "image-controls";
    try {
      for (const action of ["status", "cancel"]) {
        const result = await runNekocli(["image", `--${action}`, "image-example"], tmpdir());
        const [ask] = asksIn(result.text, "image-controls", new Set());
        expect(JSON.parse(ask!.query)).toEqual({ action, id: "image-example" });
      }
      for (const args of [
        ["--status"], ["--cancel", "not-a-job"],
        ["--status", "image-example", "--cancel", "image-example"],
        ["a cat", "--status", "image-example"],
        ["--status", "image-example", "--out", "new.png"],
      ]) await expect(runNekocli(["image", ...args], tmpdir())).rejects.toThrow();
    } finally {
      deactivateAskBridge();
      if (session === undefined) delete process.env.PI_SESSION_ID;
      else process.env.PI_SESSION_ID = session;
    }
  });
});

describe("image collection", () => {
  test("the dedicated Codex image endpoint returns JSON, not a Responses stream", () => {
    expect(collectImage(JSON.stringify({ data: [{ b64_json: PIXEL }] }))).toBe(PIXEL);
    for (const value of [null, {}, { data: [] }, { data: [{ b64_json: "tiny" }] }]) {
      expect(collectImage(JSON.stringify(value))).toBeUndefined();
    }
  });
  test("the generated image survives an empty terminal output", () => {
    expect(collectImage(generated(PIXEL))).toBe(PIXEL);
    expect(collectImage(generated(`data:image/png;base64,${PIXEL}`))).toBe(PIXEL);
  });

  test("a partial or absent image is not mistaken for a result", () => {
    expect(collectImage(generated("tiny"))).toBeUndefined();
    expect(collectImage(stream([{ type: "response.completed", response: { output: [] } }]))).toBeUndefined();
    expect(collectImage("")).toBeUndefined();
  });
});

describe("image generation", () => {
  const request = (out: string, from?: string[]): ImageRequest =>
    ({ prompt: "a cat", out, ...(from ? { from } : {}) });

  test("the output path must be a new file inside the workspace", async () => {
    const parent = await mkdtemp(join(tmpdir(), "nekopi-image-"));
    const cwd = join(parent, "workspace");
    try {
      await mkdir(cwd);
      await symlink(parent, join(cwd, "escape"));
      // Nothing may reach the network before the path is judged.
      globalThis.fetch = (() => { throw new Error("the request must not be sent"); }) as never;
      for (const out of ["../outside.png", join(parent, "outside.png"), "escape/outside.png"]) {
        await expect(generateImage(request(out), cwd, TARGET, AUTH)).rejects
          .toThrow("inside the workspace");
      }
      await expect(generateImage(request("notes.txt"), cwd, TARGET, AUTH)).rejects
        .toThrow("image extension");
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  test("a generated image is written and reported by path and size", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nekopi-image-"));
    try {
      await mkdir(join(cwd, "assets"));
      serve(generated(PIXEL));
      const text = await generateImage(request("assets/cat.png"), cwd, TARGET, AUTH);
      expect(text).toContain("assets/cat.png");
      expect(text).toContain("16x16");
      expect(text).not.toContain("requested");
      expect(text).toContain("nek read assets/cat.png");
      expect(await readFile(join(cwd, "assets", "cat.png"))).toEqual(Buffer.from(PIXEL, "base64"));
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("Codex generation and edits use the dedicated endpoints and model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nekopi-image-wire-"));
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    try {
      await writeFile(join(cwd, "input.png"), "reference");
      await writeFile(join(cwd, "style.jpg"), "style reference");
      const more = ["subject.png", "composition.png", "palette.png"];
      for (const name of more) await writeFile(join(cwd, name), name);
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
        return new Response(JSON.stringify({ data: [{ b64_json: PIXEL }] }));
      }) as never;
      await generateImage(request("generated.png"), cwd, TARGET, AUTH);
      await generateImage(request("edited.png", ["input.png", "style.jpg", ...more]), cwd, TARGET, AUTH);
      expect(calls.map(call => call.url)).toEqual([TARGET.url, TARGET.url.replace("generations", "edits")]);
      expect(calls[0]!.body).toEqual({ model: "gpt-image-2", prompt: "a cat",
        background: "auto", quality: "auto" });
      expect(calls[1]!.body).toEqual({ ...calls[0]!.body,
        images: [
          { image_url: `data:image/png;base64,${Buffer.from("reference").toString("base64")}` },
          { image_url: `data:image/jpeg;base64,${Buffer.from("style reference").toString("base64")}` },
          ...more.map(name => ({ image_url: `data:image/png;base64,${Buffer.from(name).toString("base64")}` })),
        ] });
      expect(calls[0]!.headers.get("accept")).toBe("application/json");
      expect(calls[0]!.headers.get("authorization")).toBe("Bearer token");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("six references are refused before file reads or a provider call", async () => {
    globalThis.fetch = (() => { throw new Error("must not send a request"); }) as never;
    await expect(generateImage(request("new.png", Array(6).fill("missing.png")), tmpdir(), TARGET, AUTH))
      .rejects.toThrow("up to 5");
  });

  test("existing outputs, including dangling symlinks, are refused before generation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nekopi-image-existing-"));
    try {
      await writeFile(join(cwd, "keep.png"), "keep");
      await mkdir(join(cwd, "directory.png"));
      await symlink(join(cwd, "keep.png"), join(cwd, "alias.png"));
      await symlink(join(cwd, "missing.png"), join(cwd, "dangling.png"));
      globalThis.fetch = (() => { throw new Error("must not send a request"); }) as never;
      for (const out of ["keep.png", "directory.png", "alias.png", "dangling.png"]) {
        await expect(generateImage(request(out), cwd, TARGET, AUTH)).rejects.toThrow("new path");
      }
      expect(await readFile(join(cwd, "keep.png"), "utf8")).toBe("keep");
      await expect(generateImage(request("wrong.jpg"), cwd, TARGET, AUTH)).rejects.toThrow(".png");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("missing parents are prepared before the provider request", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nekopi-image-nested-"));
    try {
      globalThis.fetch = (async () => {
        expect((await stat(join(cwd, "new", "nested"))).isDirectory()).toBe(true);
        return new Response(JSON.stringify({ data: [{ b64_json: PIXEL }] }));
      }) as never;
      await generateImage(request("new/nested/cat.png"), cwd, TARGET, AUTH);
      expect(await readFile(join(cwd, "new", "nested", "cat.png"))).toEqual(Buffer.from(PIXEL, "base64"));
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("an output created during generation is never overwritten", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nekopi-image-race-"));
    try {
      globalThis.fetch = (async () => {
        await writeFile(join(cwd, "cat.png"), "keep");
        return new Response(JSON.stringify({ data: [{ b64_json: PIXEL }] }));
      }) as never;
      await expect(generateImage(request("cat.png"), cwd, TARGET, AUTH)).rejects.toThrow();
      expect(await readFile(join(cwd, "cat.png"), "utf8")).toBe("keep");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("a parent changed to an outside symlink during generation is refused", async () => {
    const parent = await mkdtemp(join(tmpdir(), "nekopi-image-parent-race-"));
    const cwd = join(parent, "workspace");
    try {
      await mkdir(cwd);
      globalThis.fetch = (async () => {
        await rename(join(cwd, "assets"), join(cwd, "moved"));
        await symlink(parent, join(cwd, "assets"));
        return new Response(JSON.stringify({ data: [{ b64_json: PIXEL }] }));
      }) as never;
      await expect(generateImage(request("assets/cat.png"), cwd, TARGET, AUTH)).rejects.toThrow("inside the workspace");
      await expect(stat(join(parent, "cat.png"))).rejects.toThrow();
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  test("an input image is read only from inside the workspace", async () => {
    const parent = await mkdtemp(join(tmpdir(), "nekopi-image-"));
    const cwd = join(parent, "workspace");
    try {
      await mkdir(cwd);
      await writeFile(join(parent, "outside.png"), "secret");
      await writeFile(join(cwd, "inside.png"), "fine");
      serve(generated(PIXEL));
      // The session resolves `--from` itself, so an escape yields no bytes
      // rather than reading the file and sending it to the provider.
      await expect(generateImage(request("out.png", ["../outside.png"]), cwd, TARGET, AUTH))
        .rejects.toThrow("no readable image");
      await expect(generateImage(request("out.png", ["notes.txt"]), cwd, TARGET, AUTH))
        .rejects.toThrow("not an image");
      const text = await generateImage(request("out.png", ["inside.png"]), cwd, TARGET, AUTH);
      expect(text).toContain("edited from 1 input image(s)");
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  test("a provider failure reports the status and writes nothing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nekopi-image-"));
    try {
      serve("", false);
      await expect(generateImage(request("cat.png"), cwd, TARGET, AUTH)).rejects.toThrow("429");
      serve(stream([{ type: "response.completed", response: { output: [] } }]));
      await expect(generateImage(request("cat.png"), cwd, TARGET, AUTH)).rejects.toThrow("no image");
      serve(JSON.stringify({ data: [{ b64_json: Buffer.alloc(128, 42).toString("base64") }] }));
      await expect(generateImage(request("cat.png"), cwd, TARGET, AUTH)).rejects.toThrow("invalid PNG");
      await expect(readFile(join(cwd, "cat.png"))).rejects.toThrow();
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
