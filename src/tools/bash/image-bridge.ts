import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, constants, mkdtempSync, rmSync } from "node:fs";
import { open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionContext, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";

const KEY_ENV = "NEKOPI_IMAGE_BRIDGE_KEY";
const DIR_ENV = "NEKOPI_IMAGE_BRIDGE_DIR";
const MARKER = /^\[nekopi:image:v1:([A-Za-z0-9_-]{1,8192}):([A-Za-z0-9_-]{43})\]$/gmu;
const MAX_IMAGES = 16;
const MAX_SEEN = 256;
const MAX_SIDECARS = 32;
const MAX_SIDECAR_BYTES = 8 * 1024 * 1024;
const MAX_LOG_SCAN_BYTES = 4 * 1024 * 1024;
const STALE_MS = 60 * 60 * 1000;
let key: string | undefined;
let spoolDir: string | undefined;
let users = 0;

interface ImageRequest { session: string; file: string }
interface ImageBlock { type: "image"; data: string; mimeType: string }

/** Keep a private spool while at least one Pi session uses the Bash shape. */
export function activateImageBridge(): void {
  key ??= randomBytes(32).toString("hex");
  if (!spoolDir) {
    const directory = mkdtempSync(join(tmpdir(), "nekopi-images-"));
    try { chmodSync(directory, 0o700); }
    catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
    spoolDir = directory;
  }
  users++;
  process.env[KEY_ENV] = key;
  process.env[DIR_ENV] = spoolDir;
}

/** Remove sidecars, including those whose markers Bash truncated or never returned. */
export async function deactivateImageBridge(): Promise<void> {
  if (!users) return;
  users--;
  if (users || !spoolDir) return;
  const directory = spoolDir;
  spoolDir = undefined;
  if (process.env[DIR_ENV] === directory) delete process.env[DIR_ENV];
  if (process.env[KEY_ENV] === key) delete process.env[KEY_ENV];
  await rm(directory, { recursive: true, force: true });
}

/** Clear old missed markers, then bound disk use during a long session. */
async function spoolHasRoom(directory: string): Promise<boolean> {
  const entries = await readdir(directory);
  if (entries.length < MAX_SIDECARS) return true;
  const now = Date.now();
  for (const name of entries) {
    if (!/^[a-f0-9]{32}\.json$/u.test(name)) continue;
    const path = join(directory, name);
    const info = await stat(path).catch(() => undefined);
    if (info && now - info.mtimeMs > STALE_MS) await rm(path, { force: true });
  }
  return (await readdir(directory)).length < MAX_SIDECARS;
}

/** Snapshot the exact native image blocks before a later Bash command can alter the file. */
export async function imageReadMarker(result: { content: Array<{ type: string }> }):
Promise<{ marker?: string; note?: string }> {
  const images = result.content.filter(block => block.type === "image");
  if (!images.length) return {};
  const secret = process.env[KEY_ENV], directory = process.env[DIR_ENV], session = process.env.PI_SESSION_ID;
  if (!secret || !/^[a-f0-9]{64}$/u.test(secret) || !directory || !session) return {};
  const snapshot = JSON.stringify(images);
  if (Buffer.byteLength(snapshot) > MAX_SIDECAR_BYTES) {
    return { note: "[Image attachment unavailable: inline image exceeds the bridge size limit.]" };
  }
  try {
    if (!await spoolHasRoom(directory)) {
      return { note: "[Image attachment unavailable: temporary image storage is full.]" };
    }
    const file = randomBytes(16).toString("hex") + ".json";
    const path = join(directory, file);
    try { await writeFile(path, snapshot, { flag: "wx", mode: 0o600 }); }
    catch (error) { await rm(path, { force: true }); throw error; }
    const payload = Buffer.from(JSON.stringify({ session, file } satisfies ImageRequest)).toString("base64url");
    const signature = createHmac("sha256", secret).update(payload).digest("base64url");
    return { marker: "[nekopi:image:v1:" + payload + ":" + signature + "]" };
  } catch {
    return { note: "[Image attachment unavailable: temporary image storage failed.]" };
  }
}

function signedRequest(payload: string, signature: string, session: string): ImageRequest | undefined {
  if (!key) return;
  const expected = createHmac("sha256", key).update(payload).digest();
  const supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ImageRequest;
    if (value.session !== session || typeof value.file !== "string"
      || !/^[a-f0-9]{32}\.json$/u.test(value.file)) return;
    return value;
  } catch { return; }
}

function markersIn(text: string): string[] {
  return [...text.matchAll(MARKER)].map(match => match[0]);
}

/** Pi retains only the first MiB of structured output. Inspect bounded log edges. */
async function markersInLog(path: string): Promise<string[]> {
  const file = await open(path, "r").catch(() => undefined);
  if (!file) return [];
  try {
    const size = (await file.stat()).size;
    const length = Math.min(size, MAX_LOG_SCAN_BYTES / 2);
    const positions = size <= MAX_LOG_SCAN_BYTES ? [0] : [0, size - length];
    const found: string[] = [];
    for (const position of positions) {
      const bytes = Buffer.alloc(size <= MAX_LOG_SCAN_BYTES ? size : length);
      const read = await file.read(bytes, 0, bytes.length, position);
      const text = bytes.subarray(0, read.bytesRead).toString("utf8");
      found.push(...markersIn(position ? text.slice(text.indexOf("\n") + 1) : text));
    }
    return found.slice(0, MAX_IMAGES);
  } catch { return []; }
  finally { await file.close(); }
}

function stripMarkers(text: string, markers: Set<string>): string {
  if (!markers.size) return text;
  return text.split("\n").filter(line => !markers.has(line.replace(/\r$/u, ""))).join("\n");
}

/** Read one exact image snapshot and unlink its sidecar even if it is invalid. */
async function consumeImage(file: string): Promise<ImageBlock[]> {
  if (!spoolDir || basename(file) !== file) throw new Error("temporary image storage is unavailable");
  const path = join(spoolDir, file);
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_SIDECAR_BYTES) throw new Error("image snapshot is invalid");
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!Array.isArray(parsed) || !parsed.length || !parsed.every(block =>
        typeof block === "object" && block !== null && block.type === "image"
        && typeof block.data === "string" && typeof block.mimeType === "string")) {
        throw new Error("image snapshot is invalid");
      }
      return parsed as ImageBlock[];
    } finally { await handle.close(); }
  } finally { await rm(path, { force: true }); }
}

/** Attach stored image blocks to a Bash result without sending image bytes through stdout. */
export async function imageFeedback(event: ToolResultEvent, ctx: ExtensionContext,
  seen: Set<string>): Promise<ToolResultEventResult | undefined> {
  if (event.toolName !== "bash" || !key || !spoolDir) return;
  if (typeof event.input.command !== "string"
    || !/(?:^|[^\w])nek(?:ocli)?[ \t]+read(?:[ \t]|$)/u.test(event.input.command)) return;
  const structured = event.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return;
  const data = structured as { output?: unknown; truncated?: unknown; full_output_path?: unknown };
  if (typeof data.output !== "string") return;
  const raw = markersIn(data.output).slice(0, MAX_IMAGES);
  if (data.truncated === true && typeof data.full_output_path === "string" && raw.length < MAX_IMAGES) {
    raw.push(...(await markersInLog(data.full_output_path)).filter(marker => !raw.includes(marker))
      .slice(0, MAX_IMAGES - raw.length));
  }
  if (!raw.length) return;
  const accepted = new Set<string>();
  const images: ImageBlock[] = [];
  const notes: string[] = [];
  for (const marker of raw) {
    if (seen.has(marker)) continue;
    const match = /^\[nekopi:image:v1:([A-Za-z0-9_-]{1,8192}):([A-Za-z0-9_-]{43})\]$/u.exec(marker);
    if (!match) continue;
    const request = signedRequest(match[1]!, match[2]!, ctx.sessionManager.getSessionId());
    if (!request) continue;
    seen.add(marker);
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value!);
    accepted.add(marker);
    try { images.push(...await consumeImage(request.file)); }
    catch (error) {
      notes.push("Image attachment unavailable: " + (error instanceof Error ? error.message : String(error)) + ".");
    }
  }
  if (!accepted.size) return;
  const content = event.content.map(block => block.type === "text"
    ? { ...block, text: stripMarkers(block.text, accepted) } : block);
  content.push(...notes.map(text => ({ type: "text" as const, text })), ...images);
  return { content, structuredContent: { ...structured, output: stripMarkers(data.output, accepted) } };
}
