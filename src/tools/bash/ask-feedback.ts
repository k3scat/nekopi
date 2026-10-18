import type { ExtensionContext, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { CODEX_WEB_TARGET, isCodexCredential, resolveHostedTarget, unsupported,
  type HostedAuth, type HostedTarget } from "../hosted.ts";
import { CODEX_IMAGE_TARGET, generateImage, parseRequest, prepareImage } from "../image.ts";
import type { ImageJobs } from "../image-jobs.ts";
import { searchWeb } from "../web.ts";
import { asksIn, substitute, type AskKind } from "./ask-bridge.ts";

/** Which enabled settings this session answers for. */
export interface AskTools { web: boolean; image: boolean }

const LABEL: Record<AskKind, string> = { web: "web search", image: "image" };

/** Format hosted errors for marker replacement and job notifications. */
function failed(kind: AskKind, reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.startsWith(LABEL[kind]) ? message : `${LABEL[kind]} failed: ${message}`;
}

/** Prefer supported chat credentials for web; otherwise share the image login. */
async function accessFor(kind: AskKind, ctx: ExtensionContext):
Promise<{ target: HostedTarget; auth: HostedAuth }> {
  const model = ctx.model;
  if (kind === "web" && model) {
    const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model).catch(() => undefined);
    if (resolved?.ok && resolved.apiKey) {
      const target = resolveHostedTarget({ id: model.id, provider: model.provider, api: model.api,
        baseUrl: resolved.baseUrl ?? model.baseUrl }, resolved.apiKey);
      if (target) return { target, auth: { apiKey: resolved.apiKey, headers: resolved.headers } };
    }
  }
  const resolved = await ctx.modelRegistry.getProviderAuth("openai-codex").catch(() => undefined);
  const apiKey = resolved?.auth.apiKey;
  if (!apiKey || !isCodexCredential(apiKey)) {
    const reason = kind === "image" ? "image needs a Codex subscription login." : unsupported(LABEL.web, model);
    throw new Error(`${reason} Run /login openai-codex; keep your current coding model selected.`);
  }
  return { target: kind === "image" ? CODEX_IMAGE_TARGET : CODEX_WEB_TARGET,
    auth: { apiKey, headers: resolved?.auth.headers } };
}

/**
 * Answer every `nek` hosted-tool marker in a Bash result.
 *
 * The session holds the credential and performs the request. Calls for one
 * command run together. Web returns directly; images return a background job ID.
 */
export async function askFeedback(event: ToolResultEvent, ctx: ExtensionContext,
  enabled: AskTools, seen: Set<string>, images: ImageJobs): Promise<ToolResultEventResult | undefined> {
  if (event.toolName !== "bash") return undefined;
  const structured = event.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return undefined;
  const data = structured as { output?: unknown };
  if (typeof data.output !== "string") return undefined;
  const asks = asksIn(data.output, ctx.sessionManager.getSessionId(), seen)
    .filter(ask => enabled[ask.kind]);
  if (!asks.length) return undefined;

  const answers = new Map<string, string>();
  const access: Partial<Record<AskKind, ReturnType<typeof accessFor>>> = {};
  const done = await Promise.all(asks.map(async ask => {
    try {
      if (ask.kind === "image") {
        const payload: unknown = JSON.parse(ask.query);
        if (typeof payload === "object" && payload !== null && "action" in payload) {
          const control = payload as { action: unknown; id?: unknown };
          if (typeof control.id !== "string" || !/^image-[\w-]{1,80}$/u.test(control.id)
            || (control.action !== "status" && control.action !== "cancel")) {
            throw new Error("image failed: the job command was malformed.");
          }
          const text = control.action === "status" ? images.status(control.id) : images.cancel(control.id);
          return { marker: ask.marker, text, failed: !images.has(control.id) };
        }
        const request = parseRequest(ask.query);
        if (!request) throw new Error("image failed: the request was malformed.");
        await prepareImage(request, ctx.cwd);
        const text = images.start(request, ctx.cwd, async signal => {
          const { target, auth } = await (access.image ??= accessFor("image", ctx));
          signal.throwIfAborted();
          try { return await generateImage(request, ctx.cwd, target, auth, signal); }
          catch (error) { throw new Error(failed("image", error)); }
        });
        return { marker: ask.marker, text, failed: false };
      }
      const { target, auth } = await (access.web ??= accessFor("web", ctx));
      return { marker: ask.marker, text: await searchWeb(ask.query, target, auth), failed: false };
    } catch (error) { return { marker: ask.marker, text: failed(ask.kind, error), failed: true }; }
  }));
  for (const { marker, text } of done) answers.set(marker, text);

  const content = event.content.map(block => block.type === "text"
    ? { ...block, text: substitute(block.text, answers) } : block);
  return { content, structuredContent: { ...structured, output: substitute(data.output, answers) },
    isError: event.isError || done.some(answer => answer.failed) };
}
