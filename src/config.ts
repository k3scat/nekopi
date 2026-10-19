import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_HOSTED_TIMEOUT_SECONDS } from "./tools/hosted.ts";

const MAX_TIMEOUT_SECONDS = Math.floor(2_147_483_647 / 1000);

/** A per-language server override, for a binary or options nekopi cannot guess. */
interface ServerOverride {
  command?: string;
  args?: string[];
  initializationOptions?: Record<string, unknown>;
  rootMarkers?: string[];
  /** File extensions this server handles, for a language the syntax layer lacks. */
  extensions?: string[];
}

interface NekopiConfig {
  languageServers: { enabled: boolean; servers?: Record<string, ServerOverride> };
  nekocli: { enabled: boolean };
  diagnostics: { enabled: boolean };
  web: { enabled: boolean; timeoutSeconds: number };
  image: { enabled: boolean; timeoutSeconds: number };
  telemetry: { enabled: boolean };
}

const DEFAULT_CONFIG: Readonly<NekopiConfig> = {
  // Servers start lazily; diagnostics needs native-tool mode.
  languageServers: { enabled: true },
  // Fall back to native tools if the CLI is disabled or unavailable.
  nekocli: { enabled: true },
  diagnostics: { enabled: false },
  // Hosted tools are opt-in because they make additional provider requests.
  web: { enabled: false, timeoutSeconds: DEFAULT_HOSTED_TIMEOUT_SECONDS.web },
  image: { enabled: false, timeoutSeconds: DEFAULT_HOSTED_TIMEOUT_SECONDS.image },
  telemetry: { enabled: false },
};

type ConfigSection = keyof NekopiConfig;
type ConfigPatch = { [K in ConfigSection]?: Partial<NekopiConfig[K]> };

export interface LoadedConfig {
  config: NekopiConfig;
  sources: {
    user: { path: string; status: "loaded" | "missing" };
    project: { path: string; status: "loaded" | "missing" | "untrusted" };
  };
  origins: Record<string, "default" | "user" | "project">;
}

const retired: Record<string, string> = {
  sourceTools: "'sourceTools' is retired. Nekopi has one source tool set; there is no mode to select.",
  delegation: "'delegation' is retired. Review workers moved to the nekopi-lab repository.",
  codeIntelligence: "'codeIntelligence' is retired. Use 'languageServers', which governs the semantic layer rather than a tool.",
  output: "'output' is retired. It bounded delegation previews, and delegation moved to the nekopi-lab repository.",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Server overrides may launch programs; loadConfig enforces their trust boundary. */
function validateServers(value: unknown, source: string): Record<string, ServerOverride> {
  if (!isObject(value)) throw new Error(`${source}: 'languageServers.servers' must be an object.`);
  const servers: Record<string, ServerOverride> = {};
  for (const [language, entry] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(language)) throw new Error(`${source}: '${language}' is not a language id.`);
    if (!isObject(entry)) throw new Error(`${source}: 'languageServers.servers.${language}' must be an object.`);
    const override: ServerOverride = {};
    for (const [key, field] of Object.entries(entry)) {
      const at = `languageServers.servers.${language}.${key}`;
      if (key === "command") {
        if (typeof field !== "string" || !field.trim() || field.length > 1_024) throw new Error(`${source}: '${at}' must be a nonempty string.`);
        override.command = field;
      } else if (key === "args" || key === "rootMarkers") {
        if (!Array.isArray(field) || field.length > 32 || field.some(item => typeof item !== "string" || !item.length)) {
          throw new Error(`${source}: '${at}' must be an array of up to 32 nonempty strings.`);
        }
        override[key] = [...field as string[]];
      } else if (key === "extensions") {
        if (!Array.isArray(field) || field.length > 32
          || field.some(item => typeof item !== "string" || !/^\.?[A-Za-z0-9_+-]{1,16}$/.test(item))) {
          throw new Error(`${source}: '${at}' must be up to 32 file extensions, such as ['.zig'].`);
        }
        override.extensions = (field as string[]).map(item => item.replace(/^\./, "").toLowerCase());
      } else if (key === "initializationOptions") {
        if (!isObject(field)) throw new Error(`${source}: '${at}' must be an object.`);
        override.initializationOptions = structuredClone(field);
      } else throw new Error(`${source}: unknown setting '${at}'.`);
    }
    servers[language] = override;
  }
  return servers;
}

function validateConfig(value: unknown, source: string): ConfigPatch {
  if (!isObject(value)) throw new Error(`${source}: expected a JSON object.`);
  const patch: Record<string, Record<string, unknown>> = {};
  for (const [section, fields] of Object.entries(value)) {
    if (retired[section]) throw new Error(`${source}: ${retired[section]}`);
    if (!Object.hasOwn(DEFAULT_CONFIG, section)) throw new Error(`${source}: unknown section '${section}'.`);
    if (!isObject(fields)) throw new Error(`${source}: '${section}' must be an object.`);
    const defaults = DEFAULT_CONFIG[section as ConfigSection];
    const validated: Record<string, unknown> = {};
    let servers: Record<string, ServerOverride> | undefined;
    for (const [key, field] of Object.entries(fields)) {
      // `servers` is a map rather than a scalar, so it is not in the defaults.
      if (section === "languageServers" && key === "servers") {
        servers = validateServers(field, source);
        continue;
      }
      if (!Object.hasOwn(defaults, key)) throw new Error(`${source}: unknown setting '${section}.${key}'.`);
      if ((section === "web" || section === "image") && key === "timeoutSeconds") {
        if (typeof field !== "number" || !Number.isInteger(field) || field < 1 || field > MAX_TIMEOUT_SECONDS) {
          throw new Error(`${source}: '${section}.${key}' must be an integer from 1 to ${MAX_TIMEOUT_SECONDS} seconds.`);
        }
        validated[key] = field;
        continue;
      }
      // Every remaining setting is a boolean switch.
      if (typeof field !== "boolean") throw new Error(`${source}: '${section}.${key}' must be boolean.`);
      validated[key] = field;
    }
    patch[section] = servers ? { ...validated, servers } : validated;
  }
  return patch as ConfigPatch;
}

async function readConfig(file: string): Promise<ConfigPatch | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (Buffer.byteLength(text) > 65_536) throw new Error(`${file}: configuration exceeds 64 KiB.`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${file}: invalid JSON.`);
  }
  return validateConfig(value, file);
}

export async function loadConfig(options: {
  cwd: string;
  agentDir: string;
  trustedProject: boolean;
}): Promise<LoadedConfig> {
  const userPath = path.join(options.agentDir, "nekopi.json");
  const projectPath = path.join(options.cwd, ".pi", "nekopi.json");
  const [user, project] = await Promise.all([
    readConfig(userPath),
    options.trustedProject ? readConfig(projectPath) : undefined,
  ]);
  const config = structuredClone(DEFAULT_CONFIG);
  const origins: LoadedConfig["origins"] = {};
  for (const section of Object.keys(config) as ConfigSection[]) {
    for (const key of Object.keys(config[section])) origins[`${section}.${key}`] = "default";
    for (const [name, layer] of [["user", user], ["project", project]] as const) {
      if (!layer?.[section]) continue;
      Object.assign(config[section], layer[section]);
      for (const key of Object.keys(layer[section])) origins[`${section}.${key}`] = name;
    }
  }
  return {
    config,
    sources: {
      user: { path: userPath, status: user ? "loaded" : "missing" },
      project: { path: projectPath, status: !options.trustedProject ? "untrusted" : project ? "loaded" : "missing" },
    },
    origins,
  };
}
