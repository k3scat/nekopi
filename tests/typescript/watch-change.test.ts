/**
 * The namespace shape that made the semantic layer unreachable.
 *
 * A project pinning TypeScript below 5.9 has `ts.server` on its compiler and
 * no `ts.server.protocol`, because the tsserver protocol enums lived in
 * `tsserverlibrary.js` until later. The probe guarded only `server`, so it
 * threw on exactly those projects, `tryFallback` reported the throw as a
 * missing TypeScript installation, and every `lsp` query in vuejs/core
 * answered "use read and grep" for a whole measured batch.
 */
import { describe, expect, test } from "bun:test";
import { supportsWatchChange } from "../../src/tools/typescript.ts";

describe("the watch capability probe reads every compiler in the supported range", () => {
  test("a compiler with server but no protocol is unsupported, not a crash", () => {
    // TypeScript 5.2, which vuejs/core pins.
    expect(() => supportsWatchChange({ server: {} } as never)).not.toThrow();
    expect(supportsWatchChange({ server: {} } as never)).toBe(false);
  });

  test("a compiler with protocol but no CommandTypes is unsupported, not a crash", () => {
    expect(supportsWatchChange({ server: { protocol: {} } } as never)).toBe(false);
  });

  test("a compiler with no server at all is unsupported", () => {
    expect(supportsWatchChange({} as never)).toBe(false);
  });

  test("a compiler that carries the command is supported", () => {
    // TypeScript 5.9, which the harness itself installs.
    expect(supportsWatchChange(
      { server: { protocol: { CommandTypes: { WatchChange: "watchChange" } } } } as never)).toBe(true);
  });

  test("the harness's own compiler is read without throwing", async () => {
    const ts = await import("typescript");
    expect(() => supportsWatchChange(ts as never)).not.toThrow();
  });
});
