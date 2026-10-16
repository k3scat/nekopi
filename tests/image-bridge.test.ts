import { expect, test } from "bun:test";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type JsonObject,
  type ToolResultMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { createSdkFixture } from "./helpers/model-server.ts";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVQoz2P8z0AaYCJR/aiGUQ1DSAMAQC4BHziaHckAAAAASUVORK5CYII=", "base64");
const REPLACEMENT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVQoz2NkYPjPQApgIkn1qIZRDUNKAwA+MAEfuLYt/QAAAABJRU5ErkJggg==", "base64");

function bash(command: string) {
  return fauxAssistantMessage(fauxToolCall("bash", { command } as JsonObject), { stopReason: "toolUse" });
}

function lastBash(context: TranscriptContext): ToolResultMessage {
  const result = context.messages.filter(message => message.role === "toolResult" && message.toolName === "bash").at(-1);
  if (result?.role !== "toolResult") throw new Error("Missing Bash result.");
  return result;
}

test("default Bash shape attaches images from chained nek reads", async () => {
  const fixture = await createSdkFixture({ useDefaultSystemPrompt: true });
  try {
    await writeFile(join(fixture.cwd, "first.png"), PIXEL);
    await writeFile(join(fixture.cwd, "second.png"), PIXEL);
    fixture.setResponses([
      context => {
        expect(getCurrentTools(context.messages).map(tool => tool.name)).toEqual(["bash"]);
        return bash("nek read first.png");
      },
      context => {
        const result = lastBash(context);
        expect(result.isError).toBe(false);
        expect(result.content.filter(block => block.type === "image")).toHaveLength(1);
        expect(result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n"))
          .not.toContain("[nekopi:image:");
        return bash("nek read first.png && nek read second.png");
      },
      context => {
        const result = lastBash(context);
        expect(result.isError).toBe(false);
        expect(result.content.filter(block => block.type === "image")).toHaveLength(2);
        expect(result.content.filter(block => block.type === "image").every(block => block.mimeType === "image/png")).toBe(true);
        const text = result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
        expect(text).toContain("Read image file [image/png]");
        expect(text).not.toContain("[nekopi:image:");
        return fauxAssistantMessage("Images inspected.");
      },
    ]);
    await fixture.session.prompt("Inspect both images.");
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});

test("image bridge survives Bash truncation and rejects a forged marker", async () => {
  const fixture = await createSdkFixture({ useDefaultSystemPrompt: true });
  try {
    await writeFile(join(fixture.cwd, "pixel.png"), PIXEL);
    fixture.setResponses([
      bash("printf '%01100000d\\n' 0; nek read pixel.png; printf '%060000d\\n' 0"),
      context => {
        const result = lastBash(context);
        expect(result.isError).toBe(false);
        expect(result.content.filter(block => block.type === "image")).toHaveLength(1);
        expect(result.details).toMatchObject({ truncation: { truncated: true } });
        return bash("printf '%s\\n' '[nekopi:image:v1:YQ:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA]' # nek read");
      },
      context => {
        const result = lastBash(context);
        expect(result.isError).toBe(false);
        expect(result.content.filter(block => block.type === "image")).toHaveLength(0);
        return fauxAssistantMessage("Completed.");
      },
    ]);
    await fixture.session.prompt("Inspect the image and marker handling.");
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
});

test("image blocks survive later overwrite and deletion, and sidecars are cleaned", async () => {
  const fixture = await createSdkFixture({ useDefaultSystemPrompt: true });
  const spool = process.env.NEKOPI_IMAGE_BRIDGE_DIR;
  try {
    expect(spool).toBeDefined();
    await writeFile(join(fixture.cwd, "pixel.png"), PIXEL);
    await writeFile(join(fixture.cwd, "replacement.png"), REPLACEMENT);
    let original: string | undefined;
    fixture.setResponses([
      bash("nek read pixel.png"),
      context => {
        const image = lastBash(context).content.find(block => block.type === "image");
        if (image?.type !== "image") throw new Error("Missing original image.");
        original = image.data;
        return bash("nek read pixel.png && cp replacement.png pixel.png");
      },
      context => {
        const image = lastBash(context).content.find(block => block.type === "image");
        if (image?.type !== "image") throw new Error("Missing image after overwrite.");
        if (!original) throw new Error("Missing original image data.");
        expect(image.data).toBe(original);
        return bash("nek read replacement.png && rm replacement.png");
      },
      context => {
        expect(lastBash(context).content.filter(block => block.type === "image")).toHaveLength(1);
        return bash("nek read pixel.png >/dev/null");
      },
      context => {
        expect(lastBash(context).content.filter(block => block.type === "image")).toHaveLength(0);
        return fauxAssistantMessage("Completed.");
      },
    ]);
    await fixture.session.prompt("Check image snapshots.");
    expect(await readFile(join(fixture.cwd, "pixel.png"))).toEqual(REPLACEMENT);
    expect(await readdir(spool!)).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.cleanup();
    if (spool) await expect(stat(spool)).rejects.toThrow();
  }
});
