import { createReadToolDefinition, detectSupportedImageMimeTypeFromFile,
  type ReadOperations, type ReadToolOptions } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

const localOperations: ReadOperations = {
  access: path => access(path, constants.R_OK), readFile,
  detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

/** Capture the buffer used by native read, retaining its paths, operations and cancellation. */
export async function readSnapshot(cwd: string, options: ReadToolOptions,
  args: Parameters<ReturnType<typeof createReadToolDefinition>["execute"]>, rejectImages = false) {
  const operations = options.operations ?? localOperations;
  let captured: { path: string; buffer: Buffer } | undefined;
  let image = false;
  const native = createReadToolDefinition(cwd, { ...options, operations: {
    ...operations,
    async readFile(path) {
      const buffer = await operations.readFile(path);
      captured = { path, buffer };
      return buffer;
    },
    ...(operations.detectImageMimeType ? { async detectImageMimeType(path: string) {
      const mime = await operations.detectImageMimeType!(path);
      image = !!mime;
      if (image && rejectImages) throw new Error("ranges supports text files only. Read this image without ranges.");
      return mime;
    } } : {}),
  } });
  const result = await native.execute(...args);
  if (captured) {
    const path = relative(args[4]?.cwd || cwd, captured.path);
    captured.path = path && !isAbsolute(path) && path !== ".." && !path.startsWith("..") && !path.startsWith("..\\")
      ? path : captured.path;
  }
  return { result, captured, image };
}
