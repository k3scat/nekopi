/** Shared command metadata for CLI help and prompt-surface checks. */

export interface Command {
  name: string;
  /** Positional arguments, as `--help` shows them. */
  args: string;
  /** Every flag this command accepts. */
  flags?: readonly string[];
  /** Flags that consume the next token, even when it starts with a dash. */
  valueFlags?: readonly string[];
  /** What `--help` adds after the flags. */
  note?: string;
}

export const COMMANDS: readonly Command[] = [
  { name: "grep", args: "[pattern] [paths...]",
    flags: ["--glob", "-g", "--context", "--limit", "--files", "-i", "--ignore-case", "-F", "--fixed", "-e", "--regexp"],
    valueFlags: ["--glob", "-g", "--context", "--limit", "-e", "--regexp"],
    note: "one pattern, positional or -e/--regexp; -F/--fixed searches literal text" },
  { name: "find", args: "<glob> [path]", flags: ["--limit"], valueFlags: ["--limit"] },
  { name: "read", args: "[file]", flags: ["--lines", "--symbol", "--limit"],
    valueFlags: ["--lines", "--symbol", "--limit"],
    note: "--symbol accepts grep declaration labels with a file; without a file, searches bare names" },
  { name: "patch", args: "[--check]", flags: ["--check", "-n", "--dry-run"],
    note: "unified diff on stdin; several files in one call; \"@@ 246\" pins a hunk to a line" },
  { name: "edit", args: "<file>", note: "[{\"oldText\": \"...\", \"newText\": \"...\"}] on stdin" },
  { name: "write", args: "<file>", note: "contents on stdin" },
  { name: "web", args: "<query>", note: "one web search; needs web.enabled" },
  { name: "image", args: "<prompt>", flags: ["--out", "--from", "--status", "--cancel", "--help", "-h"],
    valueFlags: ["--out", "--from", "--status", "--cancel"],
    note: "start a background job to --out; --help for usage and prompting; needs image.enabled" },
];

export const COMMAND_NAMES: readonly string[] = COMMANDS.map(command => command.name);

/** Flags shown beside a command in `--help`, which omits the aliases. */
const SHOWN: Record<string, string> = {
  grep: "[-e PATTERN|--regexp PATTERN] [--glob G|-g G] [--context N] [--limit N] [--files] [-i] [-F]",
  find: "[--limit N]",
  read: "[--lines A-B[,C-D]] [--symbol NAME] [--limit N]",
};

/** `nekocli --help`: every command, aligned. */
export function usage(): string {
  const left = COMMANDS.map(command => `  ${command.name} ${command.args}`);
  const width = Math.max(...left.map(text => text.length)) + 1;
  const rows = COMMANDS.map((command, index) => {
    const tail = [SHOWN[command.name], command.note].filter(Boolean).join("  ");
    return tail ? `${left[index]!.padEnd(width)}${tail}` : left[index]!;
  });
  return `nekocli <command> [...]\n\n${rows.join("\n")}\n\nUse -- before positional patterns or paths that start with "-".\nOutput is capped and search hits name the symbol containing them.`;
}
