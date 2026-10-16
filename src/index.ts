import path from "node:path";
import { getAgentDir, getPackageDir, type BeforeAgentStartEvent, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadConfig, type LoadedConfig } from "./config.ts";
import { createTelemetry, type Telemetry } from "./telemetry.ts";
import { createSourceTools } from "./source-tools.ts";
import { createEditRecoveryTool } from "./tools/edit.ts";
import { createReadBufferTool } from "./tools/read.ts";
import { createSemanticLayer, type SemanticLayer } from "./tools/lsp.ts";
import { installerPath, lspDoctor, renderDoctor } from "./tools/lsp/doctor.ts";
import { disposeSyntax } from "./tools/syntax/parser.ts";
import { nativeBashFeedback } from "./tools/bash/feedback.ts";
import { activateImageBridge, deactivateImageBridge, imageFeedback } from "./tools/bash/image-bridge.ts";
import { activateAskBridge, deactivateAskBridge } from "./tools/bash/ask-bridge.ts";
import { askFeedback } from "./tools/bash/ask-feedback.ts";
import { ImageJobs, describeImageJob } from "./tools/image-jobs.ts";
import { readPreviewFeedback } from "./tools/bash/read-preview.ts";
import { exposeOnPath, launcher } from "./tools/launcher.ts";
import { COMPLETION_GUIDELINES, IMAGE_GUIDANCE, NEKOCLI_GUIDANCE, PI_ENVIRONMENT_RULE, WEB_GUIDANCE, piDocsSection } from "./prompt.ts";
import { renderStats } from "./stats.ts";
import { loadPersonas, personaMessages, previewPersona, type Personas } from "./persona.ts";

const ANOMALOUS_NATIVE_BASH_TIMEOUT_SECONDS = 1_000;
const RECOVERY_NATIVE_BASH_TIMEOUT_SECONDS = 300;

interface SessionState {
  loaded: LoadedConfig;
  personas?: Promise<Personas>;
  promptOptions?: BeforeAgentStartEvent["systemPromptOptions"];
  preamble?: string;
  telemetry: Telemetry;
  toolStarts: Map<string, number>;
  configuredTools: string[];
  imageMarkers: Set<string>;
  imageBridgeActive: boolean;
  askMarkers: Set<string>;
  askBridgeActive: boolean;
  imageJobs: ImageJobs;
  lsp?: SemanticLayer;
  /** One-time user notices and missing-server languages. */
  noticed: Set<string>;
  /** Whether the user has been told that diagnostics needs the other shape. */
  noticedDiagnostics?: boolean;
  /** Effective shell mode, after launcher and tool-override checks. */
  shell: boolean;
}

/** Compose policies with public Pi APIs. The host retains tools, prompts and providers. */
export function createNekopiExtension(options: { agentDir?: string;
  /** Disable default completion rules for controlled SDK hosts. */
  completionGuidance?: boolean;
  /** Override launcher detection, including tests of the native-tool fallback. */
  resolveLauncher?: typeof launcher } = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const agentDir = options.agentDir ?? getAgentDir();
    let state: SessionState | undefined;
    let initialization: Promise<SessionState> | undefined;
    let reloading = false;

    function isNativeBash(): boolean {
      const tool = pi.getAllTools().find(tool => tool.name === "bash");
      return tool?.sourceInfo.source === "builtin" && tool.sourceInfo.path === "builtin:bash";
    }

    async function personaFor(current: SessionState, ctx: ExtensionContext): Promise<string | undefined> {
      current.personas ??= loadPersonas({ cwd: ctx.cwd, agentDir, trustedProject: ctx.isProjectTrusted() });
      const personas = await current.personas;
      return ctx.isProjectTrusted() ? personas.project ?? personas.global : personas.global;
    }

    function initialize(ctx: ExtensionContext): Promise<SessionState> {
      initialization ??= (async () => {
        const loaded = await loadConfig({ cwd: ctx.cwd, agentDir, trustedProject: ctx.isProjectTrusted() });
        const telemetry = createTelemetry({
          enabled: loaded.config.telemetry.enabled,
          directory: path.join(agentDir, "nekopi", "telemetry"),
          sessionId: ctx.sessionManager.getSessionId(),
          onError: (error) => { if (ctx.hasUI) ctx.ui.notify(error.message, "warning"); },
        });
        const configuredTools = createSourceTools(ctx.cwd).map(tool => tool.name);
        // Keep tool selection and prompt guidance in sync if the launcher is missing.
        let shell = loaded.config.nekocli.enabled;
        if (shell) {
          const found = await (options.resolveLauncher ?? launcher)();
          if (found) exposeOnPath(found.directory);
          else {
            shell = false;
            if (ctx.hasUI) {
              ctx.ui.notify("nekopi: nekocli could not be found or has not been built;"
                + " registering the native tools instead. Run 'bun run build' in the nekopi checkout.", "warning");
            }
          }
        }
        const sessionId = ctx.sessionManager.getSessionId();
        const imageJobs = new ImageJobs(job => {
          if (state?.imageJobs !== imageJobs || ctx.sessionManager.getSessionId() !== sessionId) return;
          pi.sendMessage({ customType: "nekopi:image-job", content: describeImageJob(job),
            display: true, details: job }, { triggerTurn: true, deliverAs: "followUp" });
        });
        state = { loaded, telemetry, toolStarts: new Map(), configuredTools, imageJobs,
          imageMarkers: new Set(), imageBridgeActive: false,
          askMarkers: new Set(), askBridgeActive: false, noticed: new Set(), shell };
        await telemetry.record({ type: "session_start" });
        return state;
      })();
      return initialization;
    }

    async function close(): Promise<void> {
      const current = state;
      state = undefined;
      initialization = undefined;
      if (!current) return;
      current.imageJobs.dispose();
      await current.lsp?.dispose();
      if (current.imageBridgeActive) await deactivateImageBridge();
      if (current.askBridgeActive) deactivateAskBridge();
      disposeSyntax();
      current.toolStarts.clear();
      await current.telemetry.record({ type: "session_end" });
      await current.telemetry.close();
    }

    pi.on("session_start", async (event, ctx) => {
      await close();
      reloading = event.reason === "reload";
      await initialize(ctx);
    });
    pi.on("session_shutdown", async (event) => {
      if (event.reason === "reload" && state) pi.appendEntry("nekopi:configured-tools", state.configuredTools);
      await close();
    });
    pi.on("resources_discover", async (_event, ctx) => {
      // Pi emits this after startup handlers, when user and SDK overrides are available.
      const current = await initialize(ctx);
      const tools = new Map(pi.getAllTools().map(tool => [tool.name, tool]));
      const isNative = (name: string) => tools.get(name)?.sourceInfo.source === "builtin"
        && tools.get(name)?.sourceInfo.path === `builtin:${name}`;
      // Registration can reactivate allowlisted tools; preserve the current selection.
      const active = pi.getActiveTools();
      const added: string[] = [];
      // Shell mode requires an active, built-in Bash tool.
      if (current.shell && (!active.includes("bash") || !isNative("bash"))) current.shell = false;

      const shell = current.shell;
      if (shell && !current.imageBridgeActive) {
        activateImageBridge();
        current.imageBridgeActive = true;
      }
      // Only enabled hosted tools need the session channel.
      const hosted = current.loaded.config.web.enabled || current.loaded.config.image.enabled;
      if (shell && hosted && !current.askBridgeActive) {
        activateAskBridge();
        current.askBridgeActive = true;
      }
      if (!shell) {
        for (const tool of createSourceTools(ctx.cwd)) {
          if (!isNative(tool.name)) continue;
          pi.registerTool({ ...tool, defaultActive: false });
          added.push(tool.name);
        }
      }
      // Only native edits can take before/after snapshots on the session's server.
      if (shell && current.loaded.config.diagnostics.enabled && !current.noticedDiagnostics && ctx.hasUI) {
        current.noticedDiagnostics = true;
        ctx.ui.notify("nekopi: diagnostics.enabled attaches to the native edit and write"
          + " tools. Set nekocli.enabled to false to register them.", "warning");
      }
      const wantsDiagnostics = current.loaded.config.languageServers.enabled
        && current.loaded.config.diagnostics.enabled && !shell;
      const noticeUntrusted = () => {
        if (!ctx.hasUI || current.noticed.has("diagnostics:untrusted")) return;
        current.noticed.add("diagnostics:untrusted");
        ctx.ui.notify("nekopi: automatic diagnostics are disabled for untrusted projects."
          + " Trust this project and reload to enable them.", "warning");
      };
      const wantsLayer = wantsDiagnostics && ctx.isProjectTrusted();
      if (wantsDiagnostics && !wantsLayer) noticeUntrusted();
      if (!wantsLayer && current.lsp) {
        await current.lsp.dispose();
        current.lsp = undefined;
      }
      if (wantsLayer && !current.lsp) {
        current.lsp = createSemanticLayer(ctx.cwd,
          current.loaded.config.languageServers.servers ? { servers: current.loaded.config.languageServers.servers } : {});
      }

      // Register native wrappers after their diagnostics provider is ready.
      if (!shell) {
        const diagnose = wantsLayer ? async (file: string, signal?: AbortSignal) => {
          // Recheck at use, not just discovery: trust can be revoked before reload.
          if (state !== current) return undefined;
          if (!ctx.isProjectTrusted()) {
            noticeUntrusted();
            const layer = current.lsp;
            current.lsp = undefined;
            await layer?.dispose();
            return undefined;
          }
          return current.lsp?.diagnose(file, signal);
        } : undefined;
        const mutations = diagnose
          ? (await import("./tools/edit/diagnostics.ts")).createDiagnosticMutationTools(ctx.cwd, diagnose)
          : [createEditRecoveryTool(ctx.cwd)];
        for (const tool of [...mutations, createReadBufferTool(ctx.cwd)]) {
          if (isNative(tool.name)) pi.registerTool({ ...tool, defaultActive: false });
        }
      }
      const previous = reloading ? ctx.sessionManager.getBranch().findLast(entry =>
        entry.type === "custom" && entry.customType === "nekopi:configured-tools") : undefined;
      const previousTools = previous?.type === "custom" && Array.isArray(previous.data) ? previous.data : [];
      // Pi restores pending tools when they are registered on reload.
      const restored = pi.getActiveTools().filter(name => !tools.has(name));
      // Pi restores active tools on reload. Activate only our newly configured optional tools.
      if (shell) {
        // Everything the shell command covers is deselected, so its schema is
        // not sent. A host that allowlisted a tool of its own keeps it.
        const covered = new Set(["grep", "find", "read", "edit", "write", "ls"]);
        pi.setActiveTools(pi.getActiveTools().filter(name => !covered.has(name) || !isNative(name)));
      } else {
        pi.setActiveTools([...new Set([...active, ...restored, ...added.filter(name => !previousTools.includes(name))])]);
      }
    });

    pi.on("before_agent_start", event => {
      const prompt = event.systemPromptOptions;
      if (state) state.promptOptions = prompt;
      // Custom system prompts belong to the host.
      if (prompt.customPrompt || prompt.forceSystemPrompt !== undefined) return;
      if (state) state.preamble = event.systemPrompt.split("\n\n<", 1)[0];
      // Keep Pi-specific help out of ordinary coding context.
      prompt.sections.docs ??= piDocsSection(getPackageDir());
      if (state?.shell) {
        const blocks = [NEKOCLI_GUIDANCE,
          ...(state.loaded.config.web.enabled ? [WEB_GUIDANCE] : []),
          ...(state.loaded.config.image.enabled ? [IMAGE_GUIDANCE] : [])];
        prompt.sections.nekocli ??= blocks.join("\n\n");
      }
      for (const [tool, rules] of Object.entries(prompt.toolGuidelines)) {
        const kept = rules.filter(rule => rule !== PI_ENVIRONMENT_RULE);
        if (kept.length !== rules.length) prompt.toolGuidelines[tool] = kept;
      }
      if (options.completionGuidance === false) return;
      for (const rule of COMPLETION_GUIDELINES) {
        if (!prompt.promptGuidelines.includes(rule)) prompt.promptGuidelines.push(rule);
      }
    });

    pi.on("context_with_system", async (event, ctx) => {
      const current = state;
      const prompt = current?.promptOptions;
      // Check after all start handlers, including later host prompt replacements.
      if (!current || !prompt || !current.preamble || prompt.customPrompt || prompt.forceSystemPrompt !== undefined) return;
      let persona: string | undefined;
      try {
        persona = await personaFor(current, ctx);
      } catch (error) {
        ctx.abort();
        throw error;
      }
      if (state !== current || !persona) return;
      return { messages: personaMessages(event.messages, persona, current.preamble) };
    });

    pi.on("tool_call", event => {
      if (event.toolName !== "bash" || typeof event.input.timeout !== "number"
        || event.input.timeout < ANOMALOUS_NATIVE_BASH_TIMEOUT_SECONDS) return;
      if (!isNativeBash()) return;
      event.input.timeout = RECOVERY_NATIVE_BASH_TIMEOUT_SECONDS;
    });

    pi.on("tool_result", async (event, ctx) => {
      if (event.toolName !== "bash") return undefined;
      if (!isNativeBash()) return undefined;
      let feedback = await nativeBashFeedback(event, ctx.cwd);
      const current = state;
      if (!current?.shell) return feedback;
      const preview = await readPreviewFeedback({ ...event, ...feedback });
      if (preview) feedback = { ...feedback, ...preview };
      const bridged = await imageFeedback({ ...event, ...feedback }, ctx, current.imageMarkers);
      let merged = bridged ? { ...feedback, ...bridged } : feedback;
      if (state !== current) return merged;
      if (current.askBridgeActive) {
        const answered = await askFeedback({ ...event, ...merged }, ctx,
          { web: current.loaded.config.web.enabled, image: current.loaded.config.image.enabled },
          current.askMarkers, current.imageJobs);
        if (answered) merged = { ...merged, ...answered };
      }
      return merged;
    });

    pi.on("tool_execution_start", (event) => {
      state?.toolStarts.set(event.toolCallId, performance.now());
    });
    pi.on("tool_execution_end", async (event) => {
      if (!state) return;
      const started = state.toolStarts.get(event.toolCallId);
      state.toolStarts.delete(event.toolCallId);
      await state.telemetry.record({
        type: "tool", tool: event.toolName, callId: event.toolCallId,
        ...(event.parentToolCallId ? { parentId: event.parentToolCallId } : {}),
        durationMs: started === undefined ? 0 : Math.round(performance.now() - started),
        isError: event.isError, outputBytes: textBytes(event.result),
      });
    });
    pi.on("message_end", async (event) => {
      if (!state || event.message.role !== "assistant") return;
      await state.telemetry.record({ type: "usage", provider: event.message.provider, model: event.message.model,
        usage: event.message.usage, usageReported: event.message.usage.totalTokens > 0 });
    });
    pi.on("agent_end", (_event, ctx) => {
      state?.toolStarts.clear();
      const current = state;
      if (!current?.lsp || !ctx.hasUI) return;
      // Installation hints go to the user, once per language.
      for (const language of current.lsp.session.missingLanguages) {
        if (current.noticed.has(language)) continue;
        current.noticed.add(language);
        ctx.ui.notify(`nekopi: no ${language} language server found. Run /nekopi lsp.`, "info");
      }
    });

    pi.registerCommand("nekopi", {
      description: "Inspect nekopi configuration, session statistics, language servers, or the effective prompt",
      async handler(args, ctx) {
        if (!ctx.hasUI) throw new Error("/nekopi requires an interactive or RPC UI. Use 'nekopi inspect' for configuration in a shell.");
        const command = args.trim() || "config";
        if (!["config", "stats", "prompt", "lsp"].includes(command)) {
          ctx.ui.notify("Usage: /nekopi config|stats|prompt|lsp", "warning");
          return;
        }
        const current = await initialize(ctx);
        let persona: string | undefined;
        if (command === "prompt") {
          const prompt = ctx.getSystemPromptOptions();
          if (!prompt.customPrompt && prompt.forceSystemPrompt === undefined
            && !current.promptOptions?.customPrompt && current.promptOptions?.forceSystemPrompt === undefined) {
            persona = await personaFor(current, ctx);
          }
        }
        const text = command === "prompt" ? previewPersona(ctx.getSystemPrompt(), persona)
          : command === "lsp" ? renderDoctor(ctx.cwd, await lspDoctor(ctx.cwd, current.loaded.config.languageServers.servers), await installerPath())
          : command === "stats" ? renderStats(current.telemetry.snapshot())
          : JSON.stringify(current.loaded, null, 2);
        const title = command === "stats" ? "NekoPi current run statistics"
          : command === "lsp" ? "NekoPi language servers" : `NekoPi ${command}`;
        await ctx.ui.editor(title, text);
      },
    });
  };
}

function textBytes(value: unknown): number {
  if (typeof value !== "object" || value === null || !("content" in value) || !Array.isArray(value.content)) return 0;
  return value.content.reduce((bytes: number, block: unknown) => bytes + (
    typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string"
      ? Buffer.byteLength(block.text) : 0
  ), 0);
}

export default createNekopiExtension();
