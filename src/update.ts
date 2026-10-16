import { execFile, spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

export const UPDATE_HELP = `Usage: nekopi update [--help]
Update this global npm installation to nekopi@latest. Start a new session afterward.
Source, linked, and other installations require a manual update.

Package and catalog updates:
  nekopi update --extensions [--approve|--no-approve]
  nekopi update --extension SOURCE [--approve|--no-approve]
  nekopi update --models
These explicit options do not update a separate Pi installation.`;

const manual = "Automatic updates require an unlinked global npm installation using the same Node/npm installation."
  + "\nUse the package manager that installed NekoPi."
  + "\nFor global npm installs: npm install --global nekopi@latest (using the original Node/npm)."
  + "\nFor source checkouts, pull the desired changes, then run:"
  + "\n  bun install --frozen-lockfile --ignore-scripts && bun run build";

/** Only explicit package/catalog modes can reach Pi's update handler. */
export function isPackageUpdate(args: string[]): boolean {
  const trustFlags = ["--approve", "--no-approve", "-a", "-na"];
  const options = args.filter(arg => !trustFlags.includes(arg));
  const [mode, source] = options;
  if (mode === "--extension") {
    return options.length === 2 && !!source && !source.startsWith("-")
      && args[args.indexOf(mode) + 1] === source;
  }
  return options.length === 1 && (mode === "--extensions" || mode === "--models");
}

async function version(root: string): Promise<string> {
  const value = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (value.name !== "nekopi" || typeof value.version !== "string") throw new Error("Invalid NekoPi package metadata.");
  return value.version;
}

async function npmCli(node: string): Promise<string> {
  // Resolve beside Node, not from a workspace-controlled PATH or npm_execpath.
  for (const candidate of [join(dirname(node), "node_modules/npm/bin/npm-cli.js"), join(dirname(node), "npm")]) {
    const path = await realpath(candidate).catch(() => undefined);
    if (path && basename(path) === "npm-cli.js" && basename(dirname(dirname(path))) === "npm") return path;
  }
  throw new Error(`Cannot locate npm beside Node. ${manual}`);
}

/** Use the same Node installation for detection and installation. */
export async function updateNekopi(root: string, node = process.execPath): Promise<number> {
  const installed = await realpath(root);
  if (basename(installed) !== "nekopi" || basename(dirname(installed)) !== "node_modules"
    || await lstat(join(installed, ".git")).catch(() => undefined)) throw new Error(manual);
  const npm = await npmCli(node);
  const cwd = dirname(node);
  const { stdout } = await promisify(execFile)(node, [npm, "root", "--global"], {
    cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024,
  });
  const globalRoot = stdout.trim();
  if (!isAbsolute(globalRoot)) throw new Error(`Cannot confirm npm's global directory. ${manual}`);
  const target = join(globalRoot, "nekopi");
  const entry = await lstat(target).catch(() => undefined);
  if (!entry || entry.isSymbolicLink() || await realpath(target) !== installed) throw new Error(manual);
  const before = await version(installed);
  console.log(`Updating NekoPi ${before} with npm...`);
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(node, [npm, "install", "--global", "nekopi@latest"], { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) reject(new Error(`npm update stopped by ${signal}.`));
      else resolve(code ?? 1);
    });
  });
  if (code !== 0) {
    console.error(`NekoPi update failed (npm exit ${code}).`);
    return code;
  }
  const after = await version(installed);
  console.log(before === after ? `NekoPi ${after} is up to date.` : `Updated NekoPi ${before} to ${after}.`);
  console.log("Start a new session to use the installed version.");
  return 0;
}
