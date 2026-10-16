import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export type Point = { line: number; offset: number };

export async function source(path: string) {
  if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error("Source verification is limited to 2 MiB per file.");
  const buffer = await readFile(path);
  if (!isUtf8(buffer)) throw new Error("Source is not valid UTF-8; positions cannot be verified.");
  const decoded = buffer.toString("utf8");
  // Match TypeScript's disk reader for both closed files and open.fileContent.
  const text = decoded.startsWith("\uFEFF") ? decoded.slice(1) : decoded;
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const lines = text.split(/\r\n|\n|\r|\u2028|\u2029/);
  const starts: number[] = [0];
  for (const match of text.matchAll(/\r\n|\n|\r|\u2028|\u2029/g)) starts.push(match.index + match[0].length);
  return { text, lines, starts, sha256 };
}
export function offset(file: SourceText, pos: Point) {
  const line = file.lines[pos.line - 1];
  if (line === undefined || pos.offset > line.length + 1) throw new Error("tsserver span is outside current source.");
  const index = file.starts[pos.line - 1]! + pos.offset - 1;
  const char = file.text.charCodeAt(index), previous = file.text.charCodeAt(index - 1);
  if (char >= 0xdc00 && char <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) throw new Error("UTF-16 position splits a surrogate pair.");
  return index;
}

export type SourceText = Awaited<ReturnType<typeof source>>;
