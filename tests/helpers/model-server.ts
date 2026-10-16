import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fauxProvider,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type FauxResponseStep,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createNekopiExtension } from "../../src/index.ts";

interface FixtureOptions {
  trusted?: boolean;
  tools?: string[];
  customTools?: ToolDefinition[];
  useDefaultSystemPrompt?: boolean;
  globalConfig?: unknown;
  projectConfig?: unknown;
  extensions?: InlineExtension[];
  loadPackage?: boolean;
  retainFinalToolDefinitions?: boolean;
  completionGuidance?: boolean;
  providerApi?: string;
  /** Build a bare Pi session, so a caller can measure nekopi's contribution. */
  omitNekopi?: boolean;
  /** Pretend `nekocli` cannot run, to exercise the default shape's fallback. */
  brokenLauncher?: boolean;
  /**
   * The six tool shape, for a test about the optional tools themselves.
   *
   * The default shape gives the model `bash` alone, so the registration,
   * trust, allowlist and reload paths for `read`, `grep`, `find`, `edit` and
   * `write` are only reachable with this set. It is spelled out at each call
   * site rather than defaulted here, so the fixture keeps matching the product
   * and a test that wants the older shape has to say so.
   */
  sixTools?: boolean;
}

/** A real Pi SDK session with an in-process provider; never calls a model API. */
export async function createSdkFixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "nekopi-sdk-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  let session: AgentSession | undefined;
  const responseErrors: unknown[] = [];

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const restoreAgentDir = () => {
    if (!options.loadPackage) return;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  };

  const cleanup = async () => {
    try {
      if (session) {
        await session.abort();
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
    } finally {
      restoreAgentDir();
      await rm(root, { recursive: true, force: true });
    }
    if (responseErrors.length) throw new AggregateError(responseErrors, "Offline provider responses failed.");
  };

  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const globalConfig = options.sixTools
      ? { ...(options.globalConfig as Record<string, unknown> | undefined), nekocli: { enabled: false } }
      : options.globalConfig;
    if (globalConfig !== undefined) {
      await writeFile(join(agentDir, "nekopi.json"), JSON.stringify(globalConfig));
    }
    if (options.projectConfig !== undefined) {
      await writeFile(join(cwd, ".pi", "nekopi.json"), JSON.stringify(options.projectConfig));
    }
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const faux = fauxProvider({ provider: "nekopi-offline-fixture", api: options.providerApi });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    });
    settingsManager.setProjectTrusted(options.trusted ?? false);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      ...(options.useDefaultSystemPrompt ? {} : { systemPrompt: "You are an offline integration test assistant." }),
      extensionFactories: [
        ...(options.loadPackage || options.omitNekopi
          ? [] : [createNekopiExtension({ agentDir, completionGuidance: options.completionGuidance,
            ...(options.brokenLauncher ? { resolveLauncher: async () => undefined } : {}) })]),
        ...(options.extensions ?? []),
      ],
      additionalExtensionPaths: options.loadPackage ? [fileURLToPath(new URL("../..", import.meta.url))] : [],
    });
    // A package's default factory resolves Pi's configured directory whenever it
    // is loaded, and `session.reload()` loads it again. Restoring the variable
    // after the first load therefore sent every later load to the real
    // `~/.pi/agent`, so a reloaded fixture read a different configuration than
    // the one it was given. A real process has one agent directory for its
    // lifetime, so the fixture keeps it set until cleanup.
    if (options.loadPackage) process.env.PI_CODING_AGENT_DIR = agentDir;
    await resourceLoader.reload();
    const loaded = resourceLoader.getExtensions();
    if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
    const result = await createAgentSession({
      cwd,
      agentDir,
      model: faux.getModel(),
      thinkingLevel: "off",
      tools: options.tools,
      customTools: options.customTools,
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    });
    session = result.session;
    const errors: string[] = [];
    await session.bindExtensions({
      mode: "print",
      onError: ({ error }) => errors.push(error),
    });
    const requests: TranscriptContext[] = [];
    const setResponses = (responses: FauxResponseStep[]) => {
      faux.setResponses(responses.map((response) => async (context, streamOptions, state, model) => {
        try {
          requests.push(structuredClone(context));
          return typeof response === "function" ? await response(context, streamOptions, state, model) : response;
        } catch (error) {
          // The faux provider converts thrown assertions into model errors. Fail the test at cleanup.
          responseErrors.push(error);
          throw error;
        }
      }));
    };

    const loadDiagnostics = { errors: loaded.errors, warnings: loaded.warnings ?? [] };
    return { session, cwd, agentDir, root, faux, requests, errors, loadDiagnostics, setResponses, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
