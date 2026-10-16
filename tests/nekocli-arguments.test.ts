import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runNekocli } from "../src/nekocli.ts";
import { workspaces } from "./helpers/workspace.ts";

const workspace = workspaces("arguments");
afterEach(workspace.cleanup);

test("grep protects pattern values and accepts options before or after paths", async () => {
  const patterns = ["--frozen", "--files", "--", "-F", "--limit"];
  const root = await workspace.make({ "data.txt": patterns.join("\n") + "\n" });
  for (const [index, pattern] of patterns.entries()) {
    for (const args of [
      ["grep", "--", pattern, "data.txt"],
      ["grep", "-e", pattern, "data.txt"],
      ["grep", "data.txt", "--regexp", pattern],
      ["grep", "--limit", "10", "-e", pattern, "data.txt", "-F"],
    ]) {
      const result = await runNekocli(args, root);
      expect(result.failed).toBeUndefined();
      expect(result.text).toContain(`${index + 1}: ${pattern}`);
    }
  }
});

test("grep rejects unknown options, missing values and multiple patterns before searching", async () => {
  const root = await workspace.make();
  await expect(runNekocli(["grep", "--bogus", "x"], root)).rejects.toThrow("Use -e PATTERN or --");
  await expect(runNekocli(["grep", "-e"], root)).rejects.toThrow("-e needs a value");
  await expect(runNekocli(["grep", "-e", "x", "--regexp", "y"], root)).rejects.toThrow("one pattern");
});

test("end of options preserves literal dash-prefixed paths across source commands", async () => {
  const root = await workspace.make({ "--files": "--frozen\n", "-odd.ts": "export const value = 1;\n" });
  expect((await runNekocli(["grep", "-e", "--frozen", "--", "--files"], root)).text).toContain("1: --frozen");
  expect((await runNekocli(["grep", "-e", "--frozen", "--glob", "--files"], root)).text).toContain("1: --frozen");
  expect((await runNekocli(["read", "--lines", "1", "--", "-odd.ts"], root)).text).toContain("export const value = 1;");
  await runNekocli(["edit", "--", "-odd.ts"], root, async () => '[{"oldText":"value = 1","newText":"value = 2"}]');
  expect(await readFile(join(root, "-odd.ts"), "utf8")).toContain("value = 2");
  await runNekocli(["write", "--", "--limit"], root, async () => "--files\n");
  expect((await runNekocli(["grep", "--", "--files", "--limit"], root)).text).toContain("1: --files");
  expect((await runNekocli(["find", "*.ts", "--", "."], root)).text).toContain("-odd.ts");
  expect((await runNekocli(["find", "--", "-odd.ts"], root)).text).toContain("-odd.ts");
});
