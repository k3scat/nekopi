import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import manifest from "../package.json";
import { loadConfig } from "./config.ts";
import { launcher } from "./tools/launcher.ts";
import { isParsed, parseSource } from "./tools/syntax/parser.ts";
import { resolveRipgrep } from "./tools/search.ts";
import { lspDoctor } from "./tools/lsp/doctor.ts";

/** A check's outcome. `fail` means a command the model reaches for will not work. */
export type Status = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: Status;
  detail: string;
  /** What the user does about it. Omitted when there is nothing to do. */
  fix?: string;
}

/** The lowest Node version the manifest permits, parsed from `engines.node`. */
export function nodeFloor(range = manifest.engines.node): [number, number, number] | undefined {
  const match = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function meetsFloor(version: string, floor: [number, number, number]): boolean {
  const parts = version.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const part = parts[index] ?? 0;
    if (part !== floor[index]) return part > floor[index]!;
  }
  return true;
}

async function checkNode(): Promise<Check> {
  const floor = nodeFloor();
  const running = process.versions.node;
  if (!floor) return { name: "node", status: "warn", detail: `${running}; engines.node is not a simple floor` };
  return meetsFloor(running, floor)
    ? { name: "node", status: "ok", detail: `${running} (needs >=${floor.join(".")})` }
    : { name: "node", status: "fail", detail: `${running} is below ${floor.join(".")}`,
        fix: `install Node ${floor.join(".")} or newer` };
}

async function checkRipgrep(cwd: string): Promise<Check> {
  try {
    return { name: "ripgrep", status: "ok", detail: await resolveRipgrep(undefined, process.env.PATH ?? "", cwd) };
  } catch {
    // `nek grep` and `nek find` are the search layer; nothing else needs rg.
    return { name: "ripgrep", status: "fail", detail: "not found on PATH or in the Pi agent directory",
      fix: "install ripgrep; without it `nek grep` and `nek find` return an error" };
  }
}

async function checkLauncher(): Promise<Check> {
  const found = await launcher();
  return found
    ? { name: "nek", status: "ok", detail: found.command }
    : { name: "nek", status: "fail", detail: "the bin/nek chain or dist/nekocli.js is missing",
        fix: "run `bun run build` in the nekopi checkout" };
}

async function checkGrammars(): Promise<Check> {
  // Parse a real snippet: this is the only check that proves the WASM grammars
  // load, which a resolved package path does not.
  const parsed = await parseSource("probe.ts", "export const probe = 1;\n");
  if (isParsed(parsed)) {
    parsed.tree.delete();
    return { name: "grammars", status: "ok", detail: "tree-sitter loaded" };
  }
  return { name: "grammars", status: "warn", detail: "tree-sitter grammars did not load",
    fix: "reinstall dependencies; symbol maps and `read --symbol` fall back to plain text meanwhile" };
}

async function checkServers(cwd: string, overrides: Parameters<typeof lspDoctor>[1]): Promise<Check> {
  const rows = await lspDoctor(cwd, overrides);
  if (!rows.length) return { name: "servers", status: "ok", detail: "no mapped language in this workspace" };
  const found = rows.filter(row => row.command).length;
  return { name: "servers", status: found ? "ok" : "warn",
    detail: `${found} of ${rows.length} language(s) have a server`,
    ...(found === rows.length ? {} : { fix: "run `nekopi lsp` for the per-language report" }) };
}

export async function environmentChecks(cwd: string, agentDir: string,
  trustedProject = false): Promise<Check[]> {
  const loaded = await loadConfig({ cwd, agentDir, trustedProject });
  const overrides = loaded.config.languageServers.servers ?? {};
  const settings: Check = {
    name: "settings",
    status: "ok",
    detail: [loaded.sources.user, loaded.sources.project]
      .map(source => `${source.path} (${source.status})`).join(", "),
  };
  return [
    { name: "versions", status: "ok", detail: `NekoPi ${manifest.version}, Pi ${PI_VERSION}` },
    await checkNode(),
    await checkLauncher(),
    await checkRipgrep(cwd),
    await checkGrammars(),
    settings,
    loaded.config.languageServers.enabled
      ? await checkServers(cwd, overrides)
      : { name: "servers", status: "ok" as const, detail: "languageServers.enabled is false" },
  ];
}

const MARK: Record<Status, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

export function renderChecks(checks: readonly Check[]): string {
  const width = Math.max(...checks.map(check => check.name.length));
  const lines = checks.map(check => {
    const head = `${MARK[check.status]}  ${check.name.padEnd(width)}  ${check.detail}`;
    return check.fix ? `${head}\n${" ".repeat(width + 8)}${check.fix}` : head;
  });
  const failed = checks.filter(check => check.status === "fail").length;
  lines.push("", failed ? `${failed} check(s) failed.` : "Ready.");
  return lines.join("\n");
}

/** True when every check that blocks a model-facing command passed. */
export function ready(checks: readonly Check[]): boolean {
  return !checks.some(check => check.status === "fail");
}

export async function runSetup(cwd: string, agentDir: string, trustedProject: boolean): Promise<boolean> {
  const checks = await environmentChecks(cwd, agentDir, trustedProject);
  console.log(renderChecks(checks));
  return ready(checks);
}

export async function runLsp(cwd: string, agentDir: string, trustedProject: boolean): Promise<void> {
  const { installerPath, renderDoctor } = await import("./tools/lsp/doctor.ts");
  const loaded = await loadConfig({ cwd, agentDir, trustedProject });
  if (!loaded.config.languageServers.enabled) {
    console.log("languageServers.enabled is false; nekopi will not start a server.\n");
  }
  const rows = await lspDoctor(cwd, loaded.config.languageServers.servers ?? {});
  console.log(renderDoctor(cwd, rows, await installerPath()));
}
