/** Route hosted-tool requests only to the credential's matching endpoint. */
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OFFICIAL_BASE_URL = "https://api.openai.com/v1";
/** The claim a ChatGPT subscription token carries and an API key does not. */
const CODEX_CLAIM = "https://api.openai.com/auth";

export const DEFAULT_HOSTED_TIMEOUT_SECONDS = { web: 300, image: 180 } as const;

export interface HostedAuth {
  apiKey: string;
  headers?: Record<string, string | null>;
}

export interface HostedModel {
  id: string;
  provider: string;
  api: string;
  baseUrl: string;
}

export interface HostedTarget {
  url: string;
  /** A subscription token on the Codex backend, rather than an API key. */
  codex: boolean;
  model: string;
}

/** Search fallback for coding models without a supported hosted endpoint. */
export const CODEX_WEB_TARGET: HostedTarget = {
  url: CODEX_RESPONSES_URL, codex: true, model: "gpt-6.1-sol",
};

function jwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/**
 * Direct-use and Codex tokens share an audience: prefer scopes.
 * Audience is a fallback only when older tokens omit scopes entirely.
 */
export function credentialTarget(token: string): "api" | "codex" | undefined {
  const payload = jwtPayload(token);
  if (payload?.[CODEX_CLAIM] === undefined) return undefined;
  const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/u)
    : Array.isArray(payload.scp) ? payload.scp : undefined;
  if (scopes) return scopes.includes("chatgpt.tokens.use.direct") ? "api" : "codex";
  const audience = payload.aud;
  return audience === OFFICIAL_BASE_URL
    || (Array.isArray(audience) && audience.includes(OFFICIAL_BASE_URL)) ? "api" : "codex";
}

/** True when the credential belongs to the Codex backend specifically. */
export function isCodexCredential(token: string): boolean {
  return credentialTarget(token) === "codex";
}

function accountId(token: string): string | undefined {
  const auth = jwtPayload(token)?.[CODEX_CLAIM];
  if (typeof auth !== "object" || auth === null) return undefined;
  const id = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function official(baseUrl: string): boolean {
  try { return new URL(baseUrl).toString().replace(/\/+$/u, "") === OFFICIAL_BASE_URL; }
  catch { return false; }
}

/** Refuse unsupported gateway credentials rather than sending them to OpenAI. */
export function resolveHostedTarget(model: HostedModel, apiKey: string,
  modelOverride?: string): HostedTarget | undefined {
  const credential = credentialTarget(apiKey);
  // The provider id decides only for a credential that says nothing itself,
  // such as an opaque key configured against the Codex provider.
  const codex = credential === "codex" || (!credential && model.provider === "openai-codex");
  const chosen = modelOverride ?? model.id;
  if (codex) return { url: CODEX_RESPONSES_URL, codex: true, model: chosen };
  if (credential === "api"
    || (official(model.baseUrl) && (model.api === "openai-responses" || model.api === "openai-completions"))) {
    return { url: `${OFFICIAL_BASE_URL}/responses`, codex: false, model: chosen };
  }
  return undefined;
}

function headersFor(target: HostedTarget, auth: HostedAuth): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (typeof value === "string") headers[name] = value;
  }
  headers.Authorization = `Bearer ${auth.apiKey}`;
  headers["Content-Type"] = "application/json";
  headers.Accept = "text/event-stream";
  headers["OpenAI-Beta"] = "responses=experimental";
  if (target.codex) {
    const id = accountId(auth.apiKey);
    if (id) headers["chatgpt-account-id"] = id;
    // The Codex backend identifies its caller. `pi` is the harness this runs in.
    headers.originator = "pi";
  }
  return headers;
}

/**
 * Completed output items, including backends with an empty terminal snapshot.
 *
 * Item-done events and the terminal output are reconciled by index. Deltas are
 * redundant and accumulating them would double the work.
 */
export function finalOutput(stream: string): { output: unknown[]; types: Set<string> } {
  // Keyed by output index, because arrival order is not output order and a
  // terminal event may carry an empty output that must not erase what arrived.
  const items = new Map<number, unknown>();
  const types = new Set<string>();
  for (const line of stream.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let event: unknown;
    try { event = JSON.parse(data); } catch { continue; }
    if (typeof event !== "object" || event === null) continue;
    const type = (event as { type?: unknown }).type;
    if (typeof type === "string") types.add(type);
    if (type === "response.output_item.done") {
      const { output_index: index, item } = event as { output_index?: unknown; item?: unknown };
      if (typeof index === "number" && Number.isSafeInteger(index) && index >= 0
        && typeof item === "object" && item !== null) items.set(index, item);
      continue;
    }
    if (type !== "response.completed" && type !== "response.incomplete") continue;
    const response = (event as { response?: unknown }).response;
    if (typeof response !== "object" || response === null) continue;
    const output = (response as { output?: unknown }).output;
    if (!Array.isArray(output)) continue;
    output.forEach((item, index) => {
      if (typeof item === "object" && item !== null) items.set(index, item);
    });
  }
  return { output: [...items].sort(([a], [b]) => a - b).map(([, item]) => item), types };
}

/** One hosted-tool request. Throws a one-line message the caller shows as-is. */
export async function postHosted(label: string, target: HostedTarget, auth: HostedAuth,
  body: unknown, timeoutMs: number, signal?: AbortSignal, accept = "text/event-stream"): Promise<string> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
  try {
    const response = await fetch(target.url, {
      method: "POST", headers: { ...headersFor(target, auth), Accept: accept }, body: JSON.stringify(body),
      redirect: "error", signal: deadline,
    });
    // The body can echo the credential, so only the status is reported.
    if (!response.ok) throw new Error(`${label} failed: provider returned ${response.status}.`);
    return await response.text();
  } catch (error) {
    if (timeout.aborted && !signal?.aborted) {
      throw new Error(`${label} failed: request timed out after ${timeoutMs / 1000} seconds (total HTTP request limit).`);
    }
    throw error;
  }
}

/** Why a model cannot reach the hosted tools, in the one line the model sees. */
export function unsupported(label: string, model: { provider: string; id: string } | undefined): string {
  return model
    ? `${label} needs an OpenAI API key or a ChatGPT subscription; the current model is ${model.provider}/${model.id}.`
    : `${label} needs a selected model.`;
}
