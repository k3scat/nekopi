import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import { relative, resolve, sep } from "node:path";

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
import { quotedSearchErrors } from "./errors.ts";

/** Prevent native read from expanding leading @ and ~ in literal names. */
export function searchResultPath(cwd: string, path: string): string {
  const result = relative(cwd, resolve(cwd, path));
  return result.startsWith("@") || result === "~" || result.startsWith(`~${sep}`) ? `.${sep}${result}` : result;
}

export interface FileSearchDetails {
  outputMode: "files";
  files: string[];
  observedMatchingFiles: number;
  omittedMatchingFiles: number;
  scanComplete: boolean;
  resultOverflow: boolean;
  outputTruncated: boolean;
  errors: string[];
}

async function collectFiles(cwd: string, args: string[], limit: number, maxStreamBytes: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<{ files: string[]; observed: number; overflow: boolean; complete: boolean; errors: string[] }>((resolveResult, reject) => {
    const child = spawn(args[0]!, args.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const files: string[] = [], seen = new Set<string>(), errors: string[] = [];
    let buffered: Buffer = Buffer.alloc(0), stderr: Buffer = Buffer.alloc(0), bytes = 0;
    let stopped = false, overflow = false, aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
    };
    const abort = () => { aborted = true; stop(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped) return;
      const remaining = maxStreamBytes - bytes;
      bytes += chunk.length;
      // Preserve complete paths in the allowed prefix, including the last bounded chunk.
      buffered = Buffer.concat([buffered, chunk.subarray(0, Math.max(0, remaining))]);
      try {
        let nul: number;
        while (!stopped && (nul = buffered.indexOf(0)) >= 0) {
          const pathBytes = buffered.subarray(0, nul);
          buffered = buffered.subarray(nul + 1);
          if (!pathBytes.length || !isUtf8(pathBytes)) throw new Error("Invalid or non-UTF-8 filename; remaining matching files are unknown.");
          const path = searchResultPath(cwd, pathBytes.toString("utf8"));
          if (seen.has(path)) continue;
          seen.add(path);
          if (seen.size > limit) { overflow = true; stop(); break; }
          files.push(path);
        }
      } catch (error) { errors.push(String(error)); stop(); }
      if (!stopped && bytes > maxStreamBytes) {
        errors.push("Search stream byte limit reached; remaining matching files are unknown.");
        stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-8192); });
    child.on("error", error => { errors.push(error.message); });
    child.on("close", code => {
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (aborted) { reject(new DOMException("Search aborted.", "AbortError")); return; }
      if (!stopped && buffered.length) errors.push("ripgrep returned an unterminated filename; remaining matching files are unknown.");
      if (stderr.length) errors.push(stderr.toString("utf8").trim());
      if (!stopped && code !== 0 && code !== 1 && !stderr.length) errors.push(`ripgrep exited ${code}; remaining matching files are unknown.`);
      resolveResult({ files, observed: seen.size, overflow, complete: !stopped && errors.length === 0, errors });
    });
  });
}

/** File discovery retains whole path identities, not source text or line coordinates. */
export async function searchFiles(cwd: string, executable: string, args: string[], limit: number,
  limits: { maxStreamBytes: number; maxOutputBytes: number }, signal?: AbortSignal) {
  const scan = await collectFiles(cwd, [executable, ...args], limit, limits.maxStreamBytes, signal);
  signal?.throwIfAborted();
  const details: FileSearchDetails = { outputMode: "files", files: [], observedMatchingFiles: scan.observed,
    omittedMatchingFiles: 0, scanComplete: scan.complete, resultOverflow: scan.overflow, outputTruncated: false, errors: scan.errors };
  const lines: string[] = [];
  let bytes = 0;
  const footerReserve = 512;
  for (const path of scan.files) {
    const line = CONTROL.test(path) ? JSON.stringify(path) : path;
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > limits.maxOutputBytes - footerReserve) { details.outputTruncated = true; continue; }
    lines.push(line); details.files.push(path); bytes += size;
  }
  details.omittedMatchingFiles = scan.observed - details.files.length;
  // One closing line, only when the result is incomplete.
  if (details.resultOverflow || details.outputTruncated) {
    lines.push(`Incomplete: ${scan.observed} matching files found, ${details.files.length} shown. Narrow path or glob, or raise limit.`);
  } else if (!details.scanComplete && !scan.errors.length) {
    lines.push("Incomplete: the scan stopped early; unscanned matching files may exist.");
  }
  if (scan.errors.length) lines.push(`Search error: ${quotedSearchErrors(scan.errors)}`);
  else if (!scan.observed) lines.push("No matching files found.");
  return { content: [{ type: "text" as const, text: lines.join("\n") }], details, ...(scan.errors.length ? { isError: true } : {}) };
}
