import { expect, test } from "bun:test";
import { Parser } from "web-tree-sitter";
import { disposeSyntax, isParsed, parseSource } from "../../src/tools/syntax/parser.ts";

test("a WASM memory trap retries with a new parser", async () => {
  disposeSyntax();
  const original = Object.getOwnPropertyDescriptor(Parser.prototype, "parse")!;
  const seen: Parser[] = [];
  Object.defineProperty(Parser.prototype, "parse", {
    ...original,
    value: function (this: Parser, ...args: unknown[]) {
      seen.push(this);
      if (seen.length === 1) throw new WebAssembly.RuntimeError("Out of bounds memory access");
      return Reflect.apply(original.value, this, args);
    },
  });

  try {
    const parsed = await parseSource("sample.ts", "export function answer() { return 42; }\n");
    expect(isParsed(parsed)).toBe(true);
    if (isParsed(parsed)) parsed.tree.delete();
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  } finally {
    Object.defineProperty(Parser.prototype, "parse", original);
    disposeSyntax();
  }
});
