import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Pi's documented directory without loading its session and UI modules. */
async function defaultAgentDir(): Promise<string> {
  // Delegate Windows shell-path normalization to the public SDK.
  if (process.platform === "win32") return (await import("@earendil-works/pi-coding-agent")).getAgentDir();
  const value = process.env.PI_CODING_AGENT_DIR;
  if (!value) return join(homedir(), ".pi", "agent");
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value.startsWith("file://") ? fileURLToPath(value) : value;
}

/** Use an existing Pi-managed binary or PATH; never download or import private Pi APIs. */
export async function resolveRipgrep(agentDir?: string, searchPath = process.env.PATH ?? "", cwd = process.cwd()): Promise<string> {
  agentDir ??= await defaultAgentDir();
  const binary = process.platform === "win32" ? "rg.exe" : "rg";
  const candidates = [join(agentDir, "bin", binary), ...searchPath.split(delimiter).map(directory => resolve(cwd, directory, binary))];
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw new Error("ripgrep is unavailable. Install rg on PATH or let Pi install its managed binary before enabling source inspection.");
}
