import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Signed session channel: hosted credentials stay in the parent, never in CLI stdout. */
const KEY_ENV = "NEKOPI_ASK_BRIDGE_KEY";
const MARKER = /^\[nekopi:ask:v1:([A-Za-z0-9_-]{1,8192}):([A-Za-z0-9_-]{43})\]$/gmu;
export const MAX_ASK_BYTES = 2_048;
/** Bounds the hosted-tool calls one Bash command can trigger. */
export const MAX_REQUESTS = 4;
const MAX_SEEN = 256;

export type AskKind = "web" | "image";
const KINDS: readonly AskKind[] = ["web", "image"];

interface AskRequest { session: string; kind: AskKind; query: string; nonce?: string }

let key: string | undefined;
let users = 0;

/** Keep the channel open while at least one session has a hosted tool enabled. */
export function activateAskBridge(): void {
  key ??= randomBytes(32).toString("hex");
  users++;
  process.env[KEY_ENV] = key;
}

export function deactivateAskBridge(): void {
  if (!users) return;
  users--;
  if (users) return;
  if (process.env[KEY_ENV] === key) delete process.env[KEY_ENV];
}

/** True when this process is a session holding the channel open. */
export function askBridgeActive(): boolean {
  return key !== undefined && users > 0;
}

/** CLI side: undefined means no session channel, no session ID, or an oversized request. */
export function askMarker(kind: AskKind, query: string,
  env: NodeJS.ProcessEnv = process.env): string | undefined {
  const secret = env[KEY_ENV], session = env.PI_SESSION_ID;
  if (!secret || !/^[a-f0-9]{64}$/u.test(secret) || !session) return undefined;
  if (!query || Buffer.byteLength(query) > MAX_ASK_BYTES) return undefined;
  // Fresh invocations may ask the same question (especially job status). Only
  // replaying an already answered marker is a replay, not repeating its query.
  const payload = Buffer.from(JSON.stringify({ session, kind, query,
    nonce: randomBytes(12).toString("hex") } satisfies AskRequest))
    .toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `[nekopi:ask:v1:${payload}:${signature}]`;
}

function verified(payload: string, signature: string, session: string): AskRequest | undefined {
  if (!key) return undefined;
  const expected = createHmac("sha256", key).update(payload).digest();
  const supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AskRequest;
    if (value.session !== session || typeof value.query !== "string" || !value.query) return undefined;
    if (!KINDS.includes(value.kind)) return undefined;
    if (Buffer.byteLength(value.query) > MAX_ASK_BYTES) return undefined;
    return value;
  } catch { return undefined; }
}

export interface Ask { marker: string; kind: AskKind; query: string }

/** Session side: every request this output asks for, signed by this session. */
export function asksIn(text: string, session: string, seen: Set<string>): Ask[] {
  const asks: Ask[] = [];
  for (const match of text.matchAll(MARKER)) {
    const marker = match[0];
    if (seen.has(marker)) continue;
    const request = verified(match[1]!, match[2]!, session);
    if (!request) continue;
    seen.add(marker);
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value!);
    asks.push({ marker, kind: request.kind, query: request.query });
    if (asks.length >= MAX_REQUESTS) break;
  }
  return asks;
}

/** Replace each answered marker line with its result. */
export function substitute(text: string, answers: ReadonlyMap<string, string>): string {
  if (!answers.size) return text;
  return text.split("\n").map(line => answers.get(line.replace(/\r$/u, "")) ?? line).join("\n");
}
