import { open } from "node:fs/promises";
import { truncateHead, truncateTail, type ToolResultEvent,
  type ToolResultEventResult } from "@earendil-works/pi-coding-agent";

const SCAN_BYTES = 1024 * 1024;
const TAIL_SCAN_BYTES = 64 * 1024;
const HEAD_BYTES = 30 * 1024;
const TAIL_BYTES = 12 * 1024;
const HEAD_LINES = 900;
const TAIL_LINES = 800;
const READ_HEADING = /^File "[^\n]*"\n(?:Source lines \d+-\d+\.|Requested \d+ of \d+ source lines)/mu;

function isChainedRead(command: unknown): command is string {
  return typeof command === "string"
    && /(?:^|[^\w])nek(?:ocli)?[ \t]+read(?:[ \t]|$)/u.test(command);
}

async function section(file: Awaited<ReturnType<typeof open>>, start: number, length: number): Promise<string> {
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await file.read(bytes, 0, length, start);
  return bytes.subarray(0, bytesRead).toString("utf8");
}

/** Preserve the start of a read and the end of a chained command within one Bash preview. */
export async function readPreviewFeedback(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
  if (event.toolName !== "bash" || !isChainedRead(event.input.command)) return;
  const details = event.details as { truncation?: { truncated?: boolean }; fullOutputPath?: string } | undefined;
  if (details?.truncation?.truncated !== true || !details.fullOutputPath) return;
  const firstText = event.content.findIndex(block => block.type === "text");
  if (firstText < 0) return;

  const file = await open(details.fullOutputPath, "r").catch(() => undefined);
  if (!file) return;
  try {
    const size = (await file.stat()).size;
    let source = await section(file, 0, Math.min(size, SCAN_BYTES));
    let heading = READ_HEADING.exec(source);
    let fromEnd = false;
    if (!heading && size > SCAN_BYTES) {
      source = await section(file, size - SCAN_BYTES, SCAN_BYTES);
      fromEnd = true;
      // The last window may begin inside a line. Search only complete lines.
      const boundary = source.indexOf("\n");
      const firstLine = boundary < 0 ? source.length : boundary + 1;
      const found = READ_HEADING.exec(source.slice(firstLine));
      heading = found && { ...found, index: firstLine + found.index };
    }
    if (!heading) return;
    const logPath = details.fullOutputPath;
    const exitCode = (event.structuredContent as { exit_code?: unknown } | undefined)?.exit_code;
    const status = event.isError && typeof exitCode === "number" && exitCode !== 0
      ? `\n\nCommand exited with code ${exitCode}` : "";
    const readOnward = source.slice(heading.index);
    if (size <= SCAN_BYTES || fromEnd) {
      const complete = truncateHead(readOnward,
        { maxBytes: HEAD_BYTES + TAIL_BYTES, maxLines: HEAD_LINES + TAIL_LINES });
      if (!complete.truncated) {
        const note = heading.index > 0 || fromEnd
          ? `\n\n[Earlier output omitted. Full output: ${logPath}]` : "";
        const content = event.content.map((block, index) => index === firstText && block.type === "text"
          ? { ...block, text: complete.content + note + status } : block);
        return { content, structuredContent: event.structuredContent };
      }
    }
    const head = truncateHead(readOnward, { maxBytes: HEAD_BYTES, maxLines: HEAD_LINES });
    const tailSource = size <= SCAN_BYTES || fromEnd ? source : await section(file,
      Math.max(0, size - TAIL_SCAN_BYTES), Math.min(size, TAIL_SCAN_BYTES));
    const tail = truncateTail(tailSource, { maxBytes: TAIL_BYTES, maxLines: TAIL_LINES });
    const preview = `${head.content}\n\n[Middle output omitted. Full output: ${logPath}]\n\n${tail.content}${status}`;
    const content = event.content.map((block, index) => index === firstText && block.type === "text"
      ? { ...block, text: preview } : block);
    return { content, structuredContent: event.structuredContent };
  } catch { return; }
  finally { await file.close(); }
}
