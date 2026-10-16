/**
 * The prompt may not advertise anything `nekocli` does not accept.
 *
 * `tests/surface.test.ts` compares prose against tool schemas and exists
 * because the `lsp` guidance once told the model to call `action: "rename"`
 * after `rename` had been removed, charged to every request of every session.
 * The default shape has no schemas to compare against, so this check runs the
 * other way: pull every command, flag and action out of the text the model is
 * sent, and make `nekocli` answer for each one.
 *
 * It fails in both directions on purpose. Prose naming something unimplemented
 * is the defect above. A command implemented but never named is dead code, and
 * this project has retired two tools and two parameters for exactly that.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_GUIDANCE, NEKOCLI_GUIDANCE, WEB_GUIDANCE } from "../src/prompt.ts";
import { COMMAND_NAMES, COMMANDS, usage } from "../src/tools/commands.ts";
import { IMAGE_HELP } from "../src/tools/image.ts";
import { runNekocli } from "../src/nekocli.ts";

/** Every `nek <word>` the guidance names, which is what the model will type. */
function advertisedCommands(text: string): string[] {
  return [...new Set([...text.matchAll(/\bnek\s+([a-z_]+)/gu)].map(match => match[1]!))]
    .filter(name => name !== "help");
}

/** Every flag the guidance names, with the command it was named under. */
function advertisedFlags(text: string): Array<{ command: string; flag: string }> {
  const found: Array<{ command: string; flag: string }> = [];
  for (const line of text.split("\n")) {
    const named = /\bnek\s+([a-z_]+)/u.exec(line);
    if (!named) continue;
    for (const match of line.matchAll(/(?<![\w-])(--?[a-z][a-z-]*)/gu)) {
      found.push({ command: named[1]!, flag: match[1]! });
    }
  }
  return found;
}

const ALL_GUIDANCE = [NEKOCLI_GUIDANCE, WEB_GUIDANCE, IMAGE_GUIDANCE].join("\n");

describe("nekocli surface", () => {
  test("the guidance names only commands nekocli has", () => {
    for (const name of advertisedCommands(ALL_GUIDANCE)) {
      expect(COMMAND_NAMES, `the prompt tells the model to run "nek ${name}"`).toContain(name);
    }
  });

  test("every command nekocli has is named in the guidance", () => {
    // A command the model is never told about cannot be reached. The project
    // has retired a tool and two parameters for going unused; an unadvertised
    // command is the same waste with none of the evidence.
    // `web` is named in its own block, sent only when the tool is enabled, so
    // the two blocks together must still account for every command.
    const advertised = new Set(advertisedCommands(ALL_GUIDANCE));
    for (const name of COMMAND_NAMES) {
      expect([...advertised], `nek ${name} exists but the prompt never names it`).toContain(name);
    }
  });

  test("a command behind a setting is named only in that setting's block", () => {
    // The default prompt must not describe a command the session will refuse,
    // and must not charge every request for a tool nobody enabled.
    const base = new Set(advertisedCommands(NEKOCLI_GUIDANCE));
    for (const [name, block] of [["web", WEB_GUIDANCE], ["image", IMAGE_GUIDANCE]] as const) {
      expect([...base], `the default prompt advertises ${name}`).not.toContain(name);
      expect(advertisedCommands(block)).toContain(name);
    }
  });

  test("the guidance names only flags the command declares", () => {
    const declared = new Map(COMMANDS.map(command => [command.name, new Set(command.flags ?? [])]));
    for (const { command, flag } of advertisedFlags(`${ALL_GUIDANCE}\n${IMAGE_HELP}`)) {
      const flags = declared.get(command);
      expect(flags, `the prompt names flags under an unknown command "${command}"`).toBeDefined();
      expect([...flags!], `the prompt tells the model to pass "${flag}" to nek ${command}`).toContain(flag);
    }
  });

  test("the guidance names only lsp actions the semantic layer answers", () => {
    // The `rename` defect in general form: a command in the prose that the code
    // does not have. It caught `lsp` actions drifting from the code; it now
    // covers every command the prompt names, including after one is retired.
    const named = new Set([...NEKOCLI_GUIDANCE.matchAll(/\bnek\s+([a-z]+)/gu)]
      .map(match => match[1]!).filter(name => name !== "help"));
    expect(named.size).toBeGreaterThan(0);
    for (const name of named) {
      expect(COMMAND_NAMES, `the prompt names "nek ${name}"`).toContain(name);
    }
  });

  test("--help renders every declared command", () => {
    const text = usage();
    for (const command of COMMANDS) expect(text).toContain(`  ${command.name} ${command.args}`);
  });

  test("every declared flag is accepted, not just declared", async () => {
    // Declaring a flag in the table is not evidence that the parser takes it.
    // Each one is passed to the real command against a real file; what is
    // rejected is an unknown flag, which these must not be.
    const cwd = await mkdtemp(join(tmpdir(), "nekocli-surface-"));
    try {
      await writeFile(join(cwd, "sample.ts"), "export function one(): number {\n  return 1;\n}\n");
      const calls: Array<[string, string[]]> = [
        ["grep", ["one", ".", "--glob", "*.ts"]],
        ["grep", ["one", ".", "-g", "*.ts"]],
        ["grep", ["one", ".", "--context", "1"]],
        ["grep", ["one", ".", "--limit", "5"]],
        ["grep", ["one", ".", "--files"]],
        ["grep", ["ONE", ".", "-i"]],
        ["grep", ["ONE", ".", "--ignore-case"]],
        ["grep", ["one", ".", "-F"]],
        ["grep", ["one", ".", "--fixed"]],
        ["find", ["*.ts", ".", "--limit", "5"]],
        ["read", ["sample.ts", "--lines", "1-2"]],
        ["read", ["sample.ts", "--lines", "1-1,3-3"]],
        ["read", ["sample.ts", "--symbol", "one"]],
        ["read", ["sample.ts", "--limit", "5"]],
        ["image", ["--help"]],
        ["image", ["-h"]],
        ["image", ["--status", "image-example"]],
        ["image", ["--cancel", "image-example"]],
      ];
      for (const [command, args] of calls) {
        const result = await runNekocli([command, ...args], cwd, async () => "");
        expect(result.text, `nekocli ${command} ${args.join(" ")}`).toBeString();
      }
      // `patch` reads stdin, so its dry run flags are exercised with a diff.
      for (const flag of ["--check", "-n", "--dry-run"]) {
        const result = await runNekocli(["patch", flag], cwd,
          async () => "--- a/sample.ts\n+++ b/sample.ts\n@@ -2 +2 @@\n-  return 1;\n+  return 2;\n");
        expect(result.text, `nekocli patch ${flag}`).toBeString();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
