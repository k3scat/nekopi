import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";

export interface Personas {
  global?: string;
  project?: string;
}

const MAX_BYTES = 65_536;

async function readPersona(file: string): Promise<string | undefined> {
  try {
    // Nonblocking open also lets us reject a FIFO without waiting for a writer.
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("expected a regular file.");
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_BYTES) throw new Error("persona exceeds 64 KiB.");
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)).trim();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** A project persona replaces, rather than accumulates with, the global persona. */
export async function loadPersonas(options: {
  cwd: string; agentDir: string; trustedProject: boolean;
}): Promise<Personas> {
  const global = await readPersona(path.join(options.agentDir, "PERSONA.md"));
  if (options.trustedProject) {
    let directory = path.resolve(options.cwd);
    while (true) {
      const project = await readPersona(path.join(directory, "PERSONA.md"));
      if (project !== undefined) return { global, project };
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return { global };
}

/** Change only structured preamble patches; leave every other field intact. */
export function personaMessages(messages: ContextWithSystemEvent["messages"], persona: string, original: string) {
  return messages.map(message => message.role === "system" && message.sections?.preamble === original
    ? { ...message, sections: { ...message.sections, preamble: persona } } : message);
}

/** The existing prompt viewer receives rendered text rather than message sections. */
export function previewPersona(prompt: string, persona: string | undefined): string {
  const end = prompt.indexOf("\n\n<");
  return persona && end !== -1 ? persona + prompt.slice(end) : prompt;
}
