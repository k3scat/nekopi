import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { launcher } from "../launcher.ts";
import { languageFor } from "../syntax/languages.ts";
import { FALLBACK_LANGUAGES } from "./tsserver-fallback.ts";
import { overrideRecipe, resolveServer, type ServerOverrides } from "./servers.ts";

const SKIP = new Set(["node_modules", ".git", "dist", "build", "target", "vendor",
  ".venv", "venv", "__pycache__", ".next", "coverage", ".tools", ".nekopi"]);
const MAX_FILES = 4_000;

interface Detected { language: string; files: number }

/** Languages present in the workspace, by file count, most common first. */
export async function detectLanguages(cwd: string): Promise<Detected[]> {
  const counts = new Map<string, number>();
  let seen = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8 || seen >= MAX_FILES) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (seen >= MAX_FILES) return;
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (SKIP.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(path, depth + 1); continue; }
      if (!entry.isFile()) continue;
      seen++;
      const language = languageFor(entry.name);
      if (language) counts.set(language.id, (counts.get(language.id) ?? 0) + 1);
    }
  };
  await walk(cwd, 0);
  return [...counts].map(([language, files]) => ({ language, files }))
    .sort((a, b) => b.files - a.files);
}

export interface DoctorRow {
  language: string;
  files: number;
  command?: string;
  install: string;
  fallback: boolean;
  configured?: true;
}

export async function lspDoctor(cwd: string, overrides: ServerOverrides = {}): Promise<DoctorRow[]> {
  return rowsFor(cwd, await detectLanguages(cwd), overrides);
}

/**
 * The shipped installer, by absolute path, or undefined when it is absent.
 *
 * An installed package puts it under the package directory, where nobody would
 * look for it. Naming the path is the difference between an instruction a user
 * can run and one they have to go find.
 */
export async function installerPath(): Promise<string | undefined> {
  const found = await launcher();
  if (!found) return undefined;
  const script = join(dirname(found.directory), "scripts", "install-servers.sh");
  try {
    await access(script, constants.R_OK);
    return script;
  } catch {
    return undefined;
  }
}

async function rowsFor(cwd: string, detected: Detected[], overrides: ServerOverrides): Promise<DoctorRow[]> {
  // A configured language counts even when no file of it is in the workspace,
  // so a typo in an override is visible rather than silent.
  const seen = new Set(detected.map(item => item.language));
  const all = [...detected, ...Object.keys(overrides).filter(language => !seen.has(language))
    .map(language => ({ language, files: 0 }))];
  const rows: DoctorRow[] = [];
  for (const { language, files } of all) {
    const recipe = overrideRecipe(language, overrides);
    if (!recipe) continue;
    const found = await resolveServer(language, cwd, overrides);
    rows.push({ language, files, install: recipe.install, fallback: FALLBACK_LANGUAGES.has(language),
      ...(found ? { command: found.command } : {}), ...(overrides[language] ? { configured: true as const } : {}) });
  }
  return rows;
}

/**
 * The report shown by `/nekopi lsp`.
 *
 * This is the only place an install command appears. The agent is never told to
 * install a server: that is a machine-wide decision, it can need elevated
 * privileges, and a server that takes minutes to install would burn the agent's
 * turns mid-task.
 */
export function renderDoctor(cwd: string, rows: readonly DoctorRow[], installer?: string): string {
  if (!rows.length) return "No files in this workspace use a language that nekopi maps to a language server.";
  const lines = [`Language servers for ${cwd}`, ""];
  const found = rows.filter(row => row.command);
  const missing = rows.filter(row => !row.command);
  if (found.length) {
    lines.push("Found:");
    for (const row of found) {
      lines.push(`  ${row.language.padEnd(12)} ${String(row.files).padStart(5)} file(s)   ${row.command}${row.configured ? "   (configured)" : ""}`);
    }
    lines.push("");
  }
  if (missing.length) {
    lines.push("Missing:");
    for (const row of missing) {
      lines.push(`  ${row.language.padEnd(12)} ${String(row.files).padStart(5)} file(s)${row.configured ? "   (configured, but its command was not found)" : ""}`);
      lines.push(`    install: ${row.install}`);
      if (row.fallback) lines.push("    nekopi answers definition, implementation, references and diagnostics through the project TypeScript server meanwhile.");
    }
    lines.push("");
  }
  if (installer && missing.length) {
    lines.push("A shipped script installs typescript, python, go and bash at pinned versions:",
      `  sh ${installer} typescript python`,
      "Run it with no language to report what is already installed. Rust, C++ and",
      "Java need a toolchain it will not guess at; use their install line above.", "");
  }
  lines.push("NekoPi never installs a server. It searches PATH, node_modules/.bin, .venv/bin,",
    "~/.local/bin, ~/go/bin, ~/.cargo/bin and the mason bin directory.",
    "Set languageServers.servers in nekopi.json to name a server yourself.");
  return lines.join("\n");
}
