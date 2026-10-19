import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { DEFAULT_HOSTED_TIMEOUT_SECONDS, finalOutput, postHosted, type HostedAuth, type HostedTarget } from "./hosted.ts";
import { resolveInside, resolveNewInside } from "./workspace-path.ts";

export const CODEX_IMAGE_TARGET: HostedTarget = {
  url: "https://chatgpt.com/backend-api/codex/images/generations", codex: true, model: "gpt-image-2",
};
export const MAX_PROMPT_BYTES = 1_024;
export const MAX_INPUTS = 5;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
};

/** Local, on-demand guidance, not added to every model request. */
export const IMAGE_HELP = `nek image <prompt> --out PATH [--from PATH ...]
nek image --status ID
nek image --cancel ID

Generation returns a background job ID immediately. Continue other work; the session
delivers a completion or failure follow-up automatically, waking the agent if idle.
Use --status to retrieve a result, not a polling loop. --cancel requests cancellation.
Up to 4 requests run at once; the latest 32 jobs are kept in session memory.
Reload, session replacement and shutdown abort jobs and discard their status.
Cancellation does not delete written files or guarantee a refund of provider usage.
Shell && only waits for submission: read or use the output after completion.

Generate a PNG with image.enabled and /login openai-codex. --out must be a new
.png path inside the workspace; missing parents are created, nothing is overwritten.
Repeat --from for up to ${MAX_INPUTS} workspace images (${Object.keys(MIME).join(", ")}; ${MAX_INPUT_BYTES / 1024 / 1024} MiB each).
Inputs are numbered Image 1 through Image ${MAX_INPUTS} in flag order. Name each role: edit target,
subject, style or composition reference. References need not be edit targets.
Prompt limit: ${MAX_PROMPT_BYTES} UTF-8 bytes. The prompt is sent unchanged.

Prompting guidance (optional scaffolding, not a required form or model schema):
- Describe scene/backdrop, subject, key details, constraints, then intended use.
- For complex requests, use short labeled lines; omit unhelpful fields.
- Preserve detailed user requirements without inventing extra creative requirements.
- For edits, say what changes and what stays; repeat invariants when iterating.
- Quote required image text verbatim; specify placement and typography.
- Ask for aspect ratio/composition in the prompt; exact dimensions are not
  guaranteed. The result reports actual PNG dimensions. Nothing is resized or cropped.

Use only the lines that help:
Use case: <type of image>
Asset type: <where it will be used>
Primary request: <main goal>
Input images: <Image 1: role; Image 2: role>
Scene/backdrop: <setting>
Subject: <main subject>
Style/medium: <photo, illustration, 3D, etc.>
Composition/framing: <viewpoint, placement, aspect ratio>
Lighting/mood: <lighting>
Text (verbatim): "<exact text>"
Constraints: <what must stay or must happen>
Avoid: <specific unwanted elements>

Example with two inputs:
nek image 'Image 1: edit target. Image 2: style reference. Apply Image 2 coloring to Image 1; keep its subject and framing unchanged.' --from base.png --from style.jpg --out result.png

The result is a saved path, not an attached picture. Use nek read PATH to inspect
subject, composition, text and invariants; iterate with one targeted change.`;

export interface ImageRequest {
  prompt: string;
  out: string;
  /** Workspace paths to edit from, already read by the caller. */
  from?: string[];
}

/** The extension's media type, or undefined when it is not an image nekopi sends. */
export function mimeFor(path: string): string | undefined {
  return MIME[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
}

function body(request: ImageRequest, target: HostedTarget,
  inputs: Array<{ mime: string; data: string }>): unknown {
  return {
    model: target.model,
    prompt: request.prompt,
    background: "auto",
    quality: "auto",
    ...(inputs.length ? { images: inputs.map(input => ({ image_url: `data:${input.mime};base64,${input.data}` })) } : {}),
  };
}

function stripDataUrl(value: string): string {
  return /^data:image\/[a-z0-9.+-]+;base64,(.+)$/iu.exec(value)?.[1] ?? value;
}

/** Dedicated Codex Images JSON, with Responses-stream compatibility. */
export function collectImage(stream: string): string | undefined {
  let output: unknown[] = [];
  try {
    const payload = JSON.parse(stream) as { data?: unknown } | null;
    if (Array.isArray(payload?.data)) output = payload.data;
  } catch { output = finalOutput(stream).output; }
  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as { type?: unknown; result?: unknown; b64_json?: unknown };
    const result = entry.type === "image_generation_call" ? entry.result : entry.b64_json;
    if (typeof result !== "string") continue;
    const data = stripDataUrl(result);
    // A short partial is not a generated image.
    if (data.length > 100 && /^[A-Za-z0-9+/=]+$/u.test(data)) return data;
  }
  return undefined;
}

export function parseRequest(value: string): ImageRequest | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { prompt, out, from } = parsed as Record<string, unknown>;
    if (typeof prompt !== "string" || !prompt || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) return undefined;
    if (typeof out !== "string" || !out) return undefined;
    if (from !== undefined && (!Array.isArray(from) || from.length > MAX_INPUTS
      || !from.every(path => typeof path === "string" && path))) return undefined;
    return { prompt, out, ...(from ? { from: from as string[] } : {}) };
  } catch { return undefined; }
}

/** Validate workspace paths and load references without writes or provider calls. */
export async function prepareImage(request: ImageRequest, cwd: string) {
  if ((request.from?.length ?? 0) > MAX_INPUTS) {
    throw new Error(`image failed: --from accepts up to ${MAX_INPUTS} input images.`);
  }
  const destination = await resolveNewInside(cwd, request.out);
  if (!destination) throw new Error("image failed: --out must be a new path inside the workspace.");
  if (extname(request.out).toLowerCase() !== ".png") {
    throw new Error("image failed: --out needs a .png image extension for Codex output.");
  }
  const inputs: Array<{ mime: string; data: string }> = [];
  for (const path of request.from ?? []) {
    const mime = mimeFor(path);
    if (!mime) throw new Error(`image failed: ${JSON.stringify(path)} is not an image nekopi can send.`);
    // Resolved against the session's own cwd, under the same rule as any read,
    // rather than trusting a path that arrived from the subprocess.
    const found = await resolveInside(cwd, path);
    const bytes = found ? await readFile(found.absolute).catch(() => undefined) : undefined;
    if (!bytes) throw new Error(`image failed: no readable image at ${JSON.stringify(path)} inside the workspace.`);
    if (bytes.byteLength > MAX_INPUT_BYTES) {
      throw new Error(`image failed: ${JSON.stringify(path)} exceeds ${MAX_INPUT_BYTES / 1024 / 1024} MiB.`);
    }
    inputs.push({ mime, data: bytes.toString("base64") });
  }
  return { destination, inputs };
}

/** Save one provider PNG, rechecking workspace paths after preflight and before writing. */
export async function generateImage(request: ImageRequest, cwd: string, target: HostedTarget,
  auth: HostedAuth, signal?: AbortSignal, timeoutSeconds: number = DEFAULT_HOSTED_TIMEOUT_SECONDS.image): Promise<string> {
  signal?.throwIfAborted();
  const { destination, inputs } = await prepareImage(request, cwd);
  signal?.throwIfAborted();
  await mkdir(dirname(destination.absolute), { recursive: true });
  if (!await resolveNewInside(cwd, request.out)) {
    throw new Error("image failed: --out must be a new path inside the workspace.");
  }
  const endpoint = inputs.length ? { ...target, url: target.url.replace(/\/generations$/u, "/edits") } : target;
  const data = collectImage(await postHosted("image", endpoint, auth,
    body(request, target, inputs), timeoutSeconds * 1000, signal, "application/json"));
  signal?.throwIfAborted();
  if (!data) throw new Error("image failed: the provider returned no image.");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("image failed: the provider returned invalid PNG data.");
  }
  const size = `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
  if (!await resolveNewInside(cwd, request.out)) {
    throw new Error("image failed: --out must still be a new path inside the workspace.");
  }
  signal?.throwIfAborted();
  await writeFile(destination.absolute, bytes, { mode: 0o644, flag: "wx" });
  const edited = inputs.length ? ` edited from ${inputs.length} input image(s),` : "";
  return `Wrote ${destination.display}, ${size},${edited} ${bytes.byteLength} bytes.`
    + ` Read it with \`nek read ${destination.display}\` to see it.`;
}
