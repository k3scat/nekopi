import { isAbsolute, relative, resolve, sep } from "node:path";
import { createWriteToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { createEditRecoveryTool } from "../edit.ts";

const MAX_REPORT_BYTES = 4_096;

/**
 * What an edit introduced, rather than what the file already suffered.
 *
 * A rendered diagnostic is `path:line:column  severity code: message`. The
 * position moves when an edit shifts lines, so a diagnostic is identified by
 * everything after its position, counted as a multiset: two identical messages
 * before and three after means one is new.
 */
function fingerprints(report: string | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of (report ?? "").split("\n")) {
    const key = keyOf(line);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function keyOf(line: string): string | undefined {
  const match = /^\S+?:\d+:\d+ {2}(.*)$/u.exec(line.trim());
  return match?.[1];
}

/** The report lines whose diagnostic was not already there before the edit. */
function introduced(before: Map<string, number>, report: string): string[] {
  const budget = new Map(before);
  const fresh: string[] = [];
  for (const line of report.split("\n")) {
    const key = keyOf(line);
    if (!key) continue;
    const seen = budget.get(key) ?? 0;
    if (seen > 0) { budget.set(key, seen - 1); continue; }
    fresh.push(line.trim());
  }
  return fresh;
}

/**
 * Diagnostics for one file, supplied by the caller.
 *
 * The provider is the `lsp` tool's diagnostics action, so the report comes from
 * the session's warm server rather than from a process started per edit, and it
 * covers every language with a server instead of TypeScript alone.
 */
export type DiagnoseFile = (file: string, signal?: AbortSignal) => Promise<string | undefined>;

/** Native edit failure feedback and optional diagnostics share one definition. */
export function createDiagnosticMutationTools(cwd: string, diagnose: DiagnoseFile) {
  return [createEditRecoveryTool(cwd), defineTool(createWriteToolDefinition(cwd))].map(tool => ({
    ...tool,
    description: `${tool.description} Reports any diagnostic this change introduced in the file, when a language server can say.`,
    async execute(...args: Parameters<typeof tool.execute>) {
      const [, input, signal, , ctx] = args;
      const target = input && typeof input === "object" && "path" in input
        && typeof input.path === "string" ? input.path : undefined;
      const root = resolve(ctx?.cwd ?? cwd);
      const file = target === undefined ? undefined : relative(root, resolve(root, target));
      // Native tools still accept their original paths. Diagnostics stay in the workspace.
      const inside = target !== undefined && file !== undefined && !target.startsWith("~")
        && !target.startsWith("@") && file !== ".." && !file.startsWith(`..${sep}`) && !isAbsolute(file);
      // Taken before the edit, so the report can name what the edit caused.
      // A file the server cannot see yet, or a server that is not up, yields
      // an empty baseline, and then every diagnostic reads as introduced.
      const before = inside ? await fingerprints(await diagnose(file!, signal).catch(() => undefined))
        : new Map<string, number>();
      const result = await tool.execute(...args);
      if (result.isError || !inside || file === undefined) return result;
      let text: string;
      try {
        const report = await diagnose(file, signal);
        if (!report) return result;
        const fresh = introduced(before, report);
        // Silence is the useful answer here: an edit that broke nothing should
        // cost nothing, and most edits break nothing.
        if (!fresh.length) return result;
        text = `This edit introduced ${fresh.length} diagnostic${fresh.length === 1 ? "" : "s"} `
          + `in this file. Pre-existing ones are not listed.\n${fresh.join("\n")}`;
      } catch (error) {
        const reason = [...(error instanceof Error ? error.message : String(error))].slice(0, 180).join("");
        text = `Post-edit diagnostics unavailable for ${JSON.stringify(file)}: ${JSON.stringify(reason)}. The file change succeeded; it was not rolled back.`;
      }
      if (Buffer.byteLength(text) > MAX_REPORT_BYTES) {
        text = "Post-edit diagnostics unavailable: report exceeds 4 KiB. The file change succeeded; it was not rolled back.";
      }
      return { ...result, content: [...result.content, { type: "text" as const, text }] };
    },
  }));
}
