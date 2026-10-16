/** Leave room for Bash's own output framing and for a later shell command. */
export const CLI_READ_MAX_BYTES = 48 * 1024;
export const CLI_READ_MAX_LINES = 1900;
const CLI_RANGE_MAX_LINES = 1800;

export function linesIn(text: string): number {
  return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function nextSpan(start: number, total?: number): string {
  const end = Math.min(total ?? Number.MAX_SAFE_INTEGER, start + 199, Number.MAX_SAFE_INTEGER);
  return `${start}-${Math.max(start, end)}`;
}

/** Range generation can budget the exact CLI continuation before selecting source lines. */
export function cliRangeLimits(path: string, prefix = "") {
  const quoted = shellQuote(path);
  return {
    maxBytes: CLI_READ_MAX_BYTES - Buffer.byteLength(prefix),
    maxLines: CLI_RANGE_MAX_LINES - linesIn(prefix),
    continuation: (start: number, end: number) =>
      `[Output limit: source lines ${start}-${end} not returned. Continue with nek read ${quoted} --lines ${start}-${end}.]`,
  };
}

export function rewriteContinuations(text: string, path: string, total?: number): string {
  const quoted = shellQuote(path);
  return text
    .replace(/^(\[[^\]\n]*?)Use offset=(\d+) to continue\.\]$/gmu,
      (_match, lead: string, next: string) =>
        `${lead}Run nek read ${quoted} --lines ${nextSpan(Number(next), total)} to continue.]`)
    .replace(/^\[Output limit: source lines (\d+)-(\d+) not returned\. Continue with ranges=\[\{"start":\d+,"end":\d+\}\]\.\]$/gmu,
      (_match, start: string, end: string) =>
        `[Output limit: source lines ${start}-${end} not returned. Continue with nek read ${quoted} --lines ${start}-${end}.]`);
}
