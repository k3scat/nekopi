/** Measure offline request payloads against the committed prompt-budget baseline. */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { createSdkFixture } from "../tests/helpers/model-server.ts";
import manifest from "../package.json";

const BASELINE = fileURLToPath(new URL("../docs/prompt-budget.json", import.meta.url));

/** o200k_base, for a stable number across iterations rather than per-provider truth. */
const tokens = (text: string) => (text ? encode(text).length : 0);

/** Normalize machine-specific paths without excluding their sections from the count. */
const PATH_PLACEHOLDER = "/path";

/** Replace machine-specific absolute paths so a count means the same everywhere. */
function stable(text: string, paths: readonly string[]): string {
  let out = text;
  // Longest first: the package directory can sit inside the checkout.
  for (const path of [...paths].sort((a, b) => b.length - a.length)) {
    if (path) out = out.replaceAll(path, PATH_PLACEHOLDER);
  }
  return out;
}

interface ToolBudget {
  name: string;
  description: number;
  parameters: number;
  parameterDescriptions: number;
  guidance: number;
  total: number;
}

interface SectionBudget { name: string; pi: number; nekopi: number; total: number }

/** Plain Pi, the default CLI surface, or the native-tool fallback. */
export type Shape = "pi" | "default" | "sixTools";

/** Only plain Pi and the default surface are recorded in the baseline. */
export type BaselineShape = "pi" | "default";

export interface Budget {
  version: string;
  piVersion: string;
  shape: Shape;
  systemPrompt: { total: number; pi: number; nekopi: number; sections: SectionBudget[] };
  tools: { count: number; total: number; items: ToolBudget[] };
  total: number;
}

/** Store both surfaces together so the comparison remains reproducible. */
export interface Budgets {
  version: string;
  piVersion: string;
  tokenizerEncoding: "o200k_base";
  shapes: Record<BaselineShape, Budget>;
}

export const SHAPES: readonly BaselineShape[] = ["pi", "default"];

/** Every `description` string in a JSON schema, which the model reads in full. */
function schemaDescriptions(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) schemaDescriptions(item, found);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "description" && typeof child === "string") found.push(child);
      else schemaDescriptions(child, found);
    }
  }
  return found;
}

export async function capture(options: { omitNekopi?: boolean; sixTools?: boolean } = {}) {
  const fixture = await createSdkFixture({ useDefaultSystemPrompt: true, ...options });
  try {
    const requests: TranscriptContext[] = [];
    fixture.setResponses([(context: TranscriptContext) => { requests.push(context); return "Ready."; }] as never);
    await fixture.session.prompt("Report readiness.");
    const context = requests[0];
    if (!context) throw new Error("The offline provider captured no request.");
    // Pi assembles the prompt from named sections; the provider receives those,
    // so measuring them shows which section a change grew.
    const system = context.messages.find(message => message.role === "system") as
      { sections?: Record<string, unknown> } | undefined;
    const sections = new Map<string, string>();
    for (const [name, value] of Object.entries(system?.sections ?? {})) {
      sections.set(name, typeof value === "string" ? value : JSON.stringify(value));
    }
    if (!sections.size) sections.set("prompt", fixture.session.systemPrompt);
    return { sections, cwd: fixture.cwd,
      tools: getCurrentTools(context.messages), guidance: toolGuidance(fixture.session) };
  } finally {
    await fixture.cleanup();
  }
}

/** Tool-contributed prompt rules are counted separately from tool schemas. */
function toolGuidance(session: { getAllTools(): ReadonlyArray<Record<string, unknown>> }): Map<string, string> {
  const guidance = new Map<string, string>();
  for (const tool of session.getAllTools()) {
    const name = typeof tool.name === "string" ? tool.name : "";
    const snippet = typeof tool.promptSnippet === "string" ? tool.promptSnippet : "";
    const rules = Array.isArray(tool.promptGuidelines) ? tool.promptGuidelines.filter(rule => typeof rule === "string") : [];
    if (name) guidance.set(name, [snippet, ...rules].filter(Boolean).join("\n"));
  }
  return guidance;
}

export async function measure(shape: Shape = "default"): Promise<Budget> {
  const sixTools = shape === "sixTools";
  // The baseline is measured against itself, so its nekopi share is zero by
  // construction rather than by subtracting a number from itself.
  const bare = await capture({ omitNekopi: true });
  const full = shape === "pi" ? bare : await capture({ sixTools });
  const paths = [getPackageDir(), full.cwd, bare.cwd];
  const names = [...new Set([...full.sections.keys(), ...bare.sections.keys()])];
  const sections: SectionBudget[] = names.map(name => {
    const total = tokens(stable(full.sections.get(name) ?? "", paths));
    const pi = tokens(stable(bare.sections.get(name) ?? "", paths));
    return { name, pi, nekopi: total - pi, total };
  }).filter(section => section.total || section.pi).sort((a, b) => b.nekopi - a.nekopi || b.total - a.total);
  const systemTotal = sections.reduce((sum, section) => sum + section.total, 0);
  const piTotal = sections.reduce((sum, section) => sum + section.pi, 0);
  const items: ToolBudget[] = full.tools.map(tool => {
    const description = tokens(tool.description ?? "");
    const parameters = tokens(JSON.stringify(tool.parameters ?? {}));
    const parameterDescriptions = tokens(schemaDescriptions(tool.parameters).join("\n"));
    const guidance = tokens(full.guidance.get(tool.name) ?? "");
    return { name: tool.name, description, parameters, parameterDescriptions, guidance,
      total: description + parameters };
  }).sort((a, b) => b.total - a.total);
  const toolTotal = items.reduce((sum, item) => sum + item.total, 0);
  return {
    version: manifest.version,
    piVersion: manifest.devDependencies["@earendil-works/pi-coding-agent"],
    shape,
    systemPrompt: { total: systemTotal, pi: piTotal, nekopi: systemTotal - piTotal, sections },
    tools: { count: items.length, total: toolTotal, items },
    total: systemTotal + toolTotal,
  };
}

/** What the baseline holds. */
export async function measureAll(): Promise<Budgets> {
  const [pi, shipped] = [await measure("pi"), await measure("default")];
  return {
    version: shipped.version,
    piVersion: shipped.piVersion,
    tokenizerEncoding: "o200k_base",
    shapes: { pi, default: shipped },
  };
}

function delta(current: number, previous: number | undefined): string {
  if (previous === undefined) return "    new";
  const change = current - previous;
  if (!change) return "      =";
  return `${change > 0 ? "+" : ""}${change}`.padStart(7);
}

function render(budget: Budget, previous?: Budget): string {
  const shape = { pi: "plain Pi, the baseline", default: "nekopi, one tool",
    sixTools: "nekopi, native tools" }[budget.shape];
  const lines = [`Prompt budget  nekopi ${budget.version} (Pi ${budget.piVersion})  ${shape}`,
    "o200k_base proxy; provider token usage can differ.", ""];
  const row = (label: string, value: number, before?: number) =>
    `  ${label.padEnd(26)}${String(value).padStart(7)}${delta(value, before)}`;

  lines.push("System prompt, tokens");
  lines.push(`  ${"section".padEnd(14)}${"total".padStart(7)}${"Pi".padStart(8)}${"nekopi".padStart(8)}${"delta".padStart(8)}`);
  const beforeSections = new Map((previous?.systemPrompt.sections ?? []).map(item => [item.name, item]));
  for (const section of budget.systemPrompt.sections) {
    lines.push(`  ${section.name.padEnd(14)}${String(section.total).padStart(7)}${String(section.pi).padStart(8)}`
      + `${String(section.nekopi).padStart(8)}${delta(section.total, beforeSections.get(section.name)?.total).padStart(8)}`);
  }
  lines.push(`  ${"TOTAL".padEnd(14)}${String(budget.systemPrompt.total).padStart(7)}`
    + `${String(budget.systemPrompt.pi).padStart(8)}${String(budget.systemPrompt.nekopi).padStart(8)}`
    + `${delta(budget.systemPrompt.total, previous?.systemPrompt.total).padStart(8)}`);
  lines.push("");

  lines.push(`Tool definitions, tokens (${budget.tools.count} tools)`);
  lines.push(`  ${"name".padEnd(14)}${"total".padStart(7)}${"descr".padStart(8)}${"params".padStart(8)}${"of which".padStart(10)}${"rules".padStart(8)}${"delta".padStart(8)}`);
  lines.push(`  ${"".padEnd(14)}${"".padStart(7)}${"".padStart(8)}${"".padStart(8)}${"descr".padStart(10)}${"".padStart(8)}${"".padStart(8)}`);
  const before = new Map((previous?.tools.items ?? []).map(item => [item.name, item]));
  for (const item of budget.tools.items) {
    lines.push(`  ${item.name.padEnd(14)}${String(item.total).padStart(7)}${String(item.description).padStart(8)}`
      + `${String(item.parameters).padStart(8)}${String(item.parameterDescriptions).padStart(10)}`
      + `${String(item.guidance).padStart(8)}${delta(item.total, before.get(item.name)?.total).padStart(8)}`);
  }
  lines.push(`  ${"TOTAL".padEnd(14)}${String(budget.tools.total).padStart(7)}`
    + `${String(budget.tools.items.reduce((sum, item) => sum + item.description, 0)).padStart(8)}`
    + `${String(budget.tools.items.reduce((sum, item) => sum + item.parameters, 0)).padStart(8)}`
    + `${String(budget.tools.items.reduce((sum, item) => sum + item.parameterDescriptions, 0)).padStart(10)}`
    + `${String(budget.tools.items.reduce((sum, item) => sum + item.guidance, 0)).padStart(8)}`
    + `${delta(budget.tools.total, previous?.tools.total).padStart(8)}`);
  lines.push("");

  lines.push(row("Every request costs", budget.total, previous?.total));
  const removed = (previous?.tools.items ?? []).filter(item => !budget.tools.items.some(current => current.name === item.name));
  if (removed.length) lines.push("", `Removed since the baseline: ${removed.map(item => item.name).join(", ")}.`);
  if (!previous) lines.push("", "No baseline yet. Run with --save to record one.");
  return lines.join("\n");
}

export async function runBudget(args: string[], options: {
  baselinePath?: string;
  measure?: () => Promise<Budgets>;
  log?: (message: string) => void;
} = {}): Promise<void> {
  const usage = "Usage: bun run budget [--save] [--json]";
  const log = options.log ?? console.log;
  const baselinePath = options.baselinePath ?? BASELINE;
  if (args.some(arg => arg === "--help" || arg === "-h")) {
    log(`${usage}\nEstimate the tokens nekopi adds to every model request with o200k_base,`
      + " against docs/prompt-budget.json.");
    return;
  }
  if (args.some(arg => !["--save", "--json"].includes(arg))) throw new Error(usage);
  const budgets = await (options.measure ?? measureAll)();
  const json = JSON.stringify(budgets, null, 2);
  const jsonOutput = args.includes("--json");
  let previous: Budgets | undefined;
  if (!jsonOutput) {
    try {
      previous = JSON.parse(await readFile(baselinePath, "utf8")) as Budgets;
    } catch { /* the first run has no baseline */ }
  }
  if (args.includes("--save")) await writeFile(baselinePath, `${json}\n`, "utf8");
  if (jsonOutput) {
    log(json);
    return;
  }
  log(SHAPES.map(shape => render(budgets.shapes[shape], previous?.shapes?.[shape])).join("\n\n"));
  // These are the figures the documentation quotes, so they are printed rather
  // than left to be worked out and typed in by hand.
  const { pi, default: shipped } = budgets.shapes;
  log(`\nPer request: plain Pi ${pi.total}, nekopi ${shipped.total}.`);
  if (args.includes("--save")) {
    log(`\nBaseline written to ${baselinePath.replace(`${process.cwd()}/`, "")}.`);
  }
}

if (import.meta.main) await runBudget(process.argv.slice(2));
