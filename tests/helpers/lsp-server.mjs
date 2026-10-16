#!/usr/bin/env node
/**
 * A scripted LSP server for offline tests.
 *
 * Behavior comes from NEKOPI_FAUX_LSP, a JSON object:
 *   capabilities   server capabilities returned by initialize
 *   responses      method name to result, or to an array consumed in order
 *   diagnostics    published for every didOpen and didChange; an array of
 *                  arrays is consumed one set per publish
 *   delayMs        delay before answering a named method, as { method: ms }
 *   exitOnStart    exit before answering initialize
 *   exitOnRequest  exit when this method arrives
 *   errorOnRequest { method: { code, message } } answered as a JSON-RPC error,
 *                  or an array consumed in order; past its end, and for a null
 *                  entry, the method answers normally
 *   stderr         text written to stderr at startup
 *   omitInitialized do not require an initialized notification
 *   workingFor      report work-done progress in flight for this many ms after
 *                   the initialized notification, as a loading server does
 */
import { createInterface } from "node:readline";

const script = JSON.parse(process.env.NEKOPI_FAUX_LSP ?? "{}");
if (script.stderr) process.stderr.write(`${script.stderr}\n`);
if (script.exitOnStart) process.exit(3);

const counters = new Map();
let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

/** A scripted error for this call, if the script has one left. */
function failureFor(method) {
  const configured = script.errorOnRequest?.[method];
  if (configured === undefined || configured === null) return undefined;
  if (!Array.isArray(configured)) return configured;
  const index = counters.get(`error:${method}`) ?? 0;
  counters.set(`error:${method}`, index + 1);
  return configured[index] ?? undefined;
}

function resultFor(method) {
  const configured = script.responses?.[method];
  if (configured === undefined) return null;
  if (!Array.isArray(configured)) return configured;
  const index = counters.get(method) ?? 0;
  counters.set(method, index + 1);
  return configured[Math.min(index, configured.length - 1)] ?? null;
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === "exit") process.exit(0);
  if (script.exitOnRequest && method === script.exitOnRequest) process.exit(4);
  const delay = script.delayMs?.[method];
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));

  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { capabilities: script.capabilities ?? {
      positionEncoding: "utf-16",
      textDocumentSync: 1,
      definitionProvider: true,
      referencesProvider: true,
      implementationProvider: true,
      typeDefinitionProvider: true,
      hoverProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      renameProvider: { prepareProvider: true },
    }, serverInfo: { name: "faux", version: "1.0.0" } } });
    return;
  }
  if (method === "initialized" && script.workingFor) {
    send({ jsonrpc: "2.0", method: "$/progress",
      params: { token: "loading", value: { kind: "begin", title: "indexing" } } });
    setTimeout(() => send({ jsonrpc: "2.0", method: "$/progress",
      params: { token: "loading", value: { kind: "end" } } }), script.workingFor);
    return;
  }
  if (method === "shutdown") { send({ jsonrpc: "2.0", id, result: null }); return; }
  if (method === "textDocument/didOpen" || method === "textDocument/didChange") {
    const uri = params?.textDocument?.uri;
    if (uri && script.diagnostics) {
      // A nested array is a sequence: one set per publish, the last repeating.
      const sets = Array.isArray(script.diagnostics[0]) ? script.diagnostics : [script.diagnostics];
      const index = counters.get("publish") ?? 0;
      counters.set("publish", index + 1);
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics",
        params: { uri, diagnostics: sets[Math.min(index, sets.length - 1)] ?? [] } });
    }
    return;
  }
  if (id === undefined) return; // Any other notification needs no reply.
  const failure = failureFor(method);
  if (failure) {
    send({ jsonrpc: "2.0", id, error: { code: failure.code ?? -32603, message: failure.message ?? "server error" } });
    return;
  }
  send({ jsonrpc: "2.0", id, result: resultFor(method) });
}

process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const header = buffer.indexOf("\r\n\r\n");
    if (header < 0) return;
    const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, header).toString("ascii"));
    if (!match) return;
    const length = Number(match[1]);
    const start = header + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    try { void handle(JSON.parse(body)); } catch { /* ignore malformed input */ }
  }
});
createInterface({ input: process.stdin }).on("close", () => process.exit(0));
