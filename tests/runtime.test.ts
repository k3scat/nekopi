/**
 * The product runs under node. The tests run under Bun.
 *
 * That difference hid a defect in shipped, advertised code: `checkEnvelope`
 * called `Bun.file`, which is defined in every test and undefined in every real
 * invocation, so `nekocli patch` with the `*** Begin Patch` dialect answered
 * "Bun is not defined". 398 tests passed over it. A probe run found it in two
 * runs for half a cent, and the model lost a call to it.
 *
 * Fixing the one line is not the fix. Any Bun global added later would pass
 * `bun test` the same way, so the class is closed here: shipped source may not
 * reach for a Bun API, and the paths a launcher actually takes are exercised
 * under node rather than under the runner.
 */
import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { readdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;

/**
 * `bin/nekocli`, driven the way a model's shell drives it.
 *
 * stdin is always written and always closed, even when empty. `nekocli` reads
 * it whenever it is not a TTY, so a pipe left open hangs the process rather
 * than failing it, which is how the first version of this file timed out.
 */
async function nekocli(args: string[], cwd: string, stdin = ""): Promise<string> {
  return new Promise<string>(resolve => {
    const child = execFile(join(ROOT, "bin", "nekocli"), args,
      { cwd, timeout: 20_000, env: { ...process.env, NEKOPI_CLI_RUNTIME: "node" } },
      (_error, stdout, stderr) => resolve(`${stdout}${stderr}`));
    child.stdin?.end(stdin);
  });
}

/** Every shipped module, which is all of `src/`. Build and benchmark scripts and tests run under Bun. */
async function sources(directory = join(ROOT, "src")): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sources(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

describe("the shipped source runs under node", () => {
  test("no module under src/ reaches for a Bun API", async () => {
    const offenders: string[] = [];
    for (const file of await sources()) {
      const text = await readFile(file, "utf8");
      for (const [index, line] of text.split("\n").entries()) {
        // Comments are where the reason for not using it is written.
        const code = line.replace(/\/\/.*$/u, "").replace(/^\s*\*.*$/u, "");
        if (/(?<![\w.])Bun\s*\./u.test(code) || /(?<![\w.])Bun\s*\[/u.test(code)) {
          offenders.push(`${file.replace(ROOT, "")}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders,
      "src/ ships to a node launcher, where `Bun` is undefined. These would throw at runtime"
      + " and pass every test, because the tests run under Bun. Use the node:* equivalent.",
    ).toEqual([]);
  });

  test("nekocli applies the Begin Patch dialect under node, not just under Bun", async () => {
    // The exact path that threw. Driven through `bin/nekocli`, so it runs the
    // launcher, the entry and the built bundle the way a model's shell does.
    const cwd = await mkdtemp(join(tmpdir(), "nekopi-runtime-"));
    try {
      await writeFile(join(cwd, "sample.ts"), "export function one() {\n  return 1;\n}\n");
      const envelope = [
        "*** Begin Patch",
        "*** Update File: sample.ts",
        "@@",
        "-  return 1;",
        "+  return 2;",
        "*** End Patch",
        "",
      ].join("\n");

      // `--check` reports without writing, and must agree with the real run.
      const check = await nekocli(["patch", "--check"], cwd, envelope);
      expect(check).not.toContain("Bun is not defined");
      expect(check).toContain("Would apply");
      expect(await readFile(join(cwd, "sample.ts"), "utf8")).toContain("return 1;");

      const applied = await nekocli(["patch"], cwd, envelope);
      expect(applied).not.toContain("Bun is not defined");
      expect(applied).toContain("sample.ts");
      expect(await readFile(join(cwd, "sample.ts"), "utf8")).toContain("return 2;");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("a hunk that does not match leaves every file alone", async () => {
    // The reason the pre-check exists: a measured run had one file written and
    // the next refused, missed it, retried, and duplicated a branch.
    const cwd = await mkdtemp(join(tmpdir(), "nekopi-runtime-"));
    try {
      await writeFile(join(cwd, "a.ts"), "export const a = 1;\n");
      await writeFile(join(cwd, "b.ts"), "export const b = 2;\n");
      const envelope = [
        "*** Begin Patch",
        "*** Update File: a.ts",
        "@@",
        "-export const a = 1;",
        "+export const a = 11;",
        "*** Update File: b.ts",
        "@@",
        "-export const b = 999;",
        "+export const b = 22;",
        "*** End Patch",
        "",
      ].join("\n");
      const output = await nekocli(["patch"], cwd, envelope);
      expect(output).not.toContain("Bun is not defined");
      expect(output).toContain("Nothing was applied.");
      // Neither file moved, which is the whole claim.
      expect(await readFile(join(cwd, "a.ts"), "utf8")).toBe("export const a = 1;\n");
      expect(await readFile(join(cwd, "b.ts"), "utf8")).toBe("export const b = 2;\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
