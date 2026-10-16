import { getAgentDir, main, parseArgs, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import manifest from "../package.json";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { readAdoption, renderAdoption } from "./adoption.ts";
import { runLsp, runSetup } from "./setup.ts";
import nekopiExtension from "./index.ts";
import { createBrandingExtension } from "./branding.ts";

const inspectHelp = "Usage: nekopi inspect [--trust-project]\nShow effective settings and their sources. Project settings require explicit trust.";
const adoptionHelp = "Usage: nekopi adoption [--days N]\nReport which tools the agent actually called, across saved telemetry runs.";
const doctorHelp = "Usage: nekopi doctor [--trust-project]\nCheck this machine for everything a session needs, and name the fix for what is missing.";
const lspHelp = "Usage: nekopi lsp [--trust-project]\nReport the language servers nekopi finds for this workspace, and how to install the rest.";

export async function runMainCli(args: string[]): Promise<void> {
  try {
    if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
      console.log(`NekoPi ${manifest.version} (Pi ${PI_VERSION})`);
      return;
    }
    if (args[0] === "inspect") {
      const options = args.slice(1);
      if (options.some(arg => !["--trust-project", "--help", "-h"].includes(arg))) {
        throw new Error(inspectHelp);
      }
      if (options.includes("--help") || options.includes("-h")) { console.log(inspectHelp); return; }
      const loaded = await loadConfig({
        cwd: process.cwd(), agentDir: getAgentDir(), trustedProject: args.includes("--trust-project"),
      });
      console.log(JSON.stringify({ version: manifest.version, piVersion: PI_VERSION, ...loaded }, null, 2));
      return;
    }
    for (const [name, help, run] of [
      ["doctor", doctorHelp, runSetup] as const,
      ["lsp", lspHelp, runLsp] as const,
    ]) {
      if (args[0] !== name) continue;
      const options = args.slice(1);
      if (options.some(arg => !["--trust-project", "--help", "-h"].includes(arg))) throw new Error(help);
      if (options.includes("--help") || options.includes("-h")) { console.log(help); return; }
      const outcome = await run(process.cwd(), getAgentDir(), options.includes("--trust-project"));
      if (outcome === false) process.exitCode = 1;
      return;
    }
    if (args[0] === "adoption") {
      const options = args.slice(1);
      if (options.includes("--help") || options.includes("-h")) { console.log(adoptionHelp); return; }
      let days: number | undefined;
      for (let index = 0; index < options.length; index++) {
        if (options[index] !== "--days") throw new Error(adoptionHelp);
        days = Number(options[++index]);
        if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new Error(adoptionHelp);
      }
      const directory = resolve(getAgentDir(), "nekopi", "telemetry");
      console.log(renderAdoption(await readAdoption(directory, days === undefined ? {} : { days }), directory));
      return;
    }
    if (args.includes("--help") || args.includes("-h")) {
      console.log(`NekoPi ${manifest.version} (Pi ${PI_VERSION})\n\nLocal commands:\n  nekopi update                    Update this global npm installation.\n  nekopi inspect [--trust-project]  Show effective settings and their sources.\n  nekopi adoption [--days N]        Report which tools the agent actually called.\n  nekopi doctor [--trust-project]   Check this machine for what a session needs.\n  nekopi lsp [--trust-project]      Report language servers found for this workspace.\n\nSession commands:\n  /nekopi config|stats|lsp|prompt   Inspect the current session.\n\nNekoPi overrides Pi's update command; see nekopi update --help.\nPi commands and options follow:\n`);
    }
    const parsed = parseArgs(args);
    await main(args, { extensionFactories: parsed.noExtensions ? []
      : [{ name: "nekopi", replaceable: true, factory: nekopiExtension },
        { name: "nekopi-branding", factory: createBrandingExtension({ verbose: parsed.verbose }) }] });
  } catch (error) {
    console.error(`nekopi: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
