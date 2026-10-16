import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { posix } from "node:path";
import { promisify } from "node:util";

test("prepare keeps npm pack JSON clean even when lifecycle scripts run", async () => {
  const root = await mkdtemp(join(tmpdir(), "nekopi-pack-json-"));
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "src"));
    await copyFile(new URL("../scripts/build.ts", import.meta.url), join(root, "scripts/build.ts"));
    for (const name of ["cli", "index", "nekocli"]) await writeFile(join(root, `src/${name}.ts`), "export const ready = true;\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "nekopi-pack-fixture", version: "1.0.0", type: "module",
      scripts: { prepare: "bun scripts/build.ts" } }));
    const { stdout, stderr } = await promisify(execFile)("npm", ["pack", "--json", "--ignore-scripts=false"], { cwd: root, timeout: 15000 });
    expect(JSON.parse(stdout)[0].name).toBe("nekopi-pack-fixture");
    expect(stderr).toContain("Built");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the npm archive includes built launchers and excludes development and local data", async () => {
  const cwd = new URL("..", import.meta.url).pathname;
  const { stdout } = await promisify(execFile)("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 });
  const [archive] = JSON.parse(stdout) as Array<{ files: Array<{ path: string; mode: number }> }>;
  const paths = archive!.files.map(file => file.path);
  for (const path of ["LICENSE", "README.md", "package.json", "bin/nek", "bin/nekocli",
    "bin/nekopi.mjs", "bin/nekocli.mjs", "dist/cli.js", "dist/index.js", "dist/nekocli.js", "src/index.ts"]) {
    expect(paths).toContain(path);
  }
  expect(paths.some(path => /^(?:\.git|\.github|\.nekopi|\.pi|node_modules|bench|tests)\//u.test(path))).toBe(false);
  expect(paths).not.toContain(".npmrc");
  expect(paths).not.toContain(".env");
  expect(paths).not.toContain("release.config.mjs");
  for (const path of ["bin/nek", "bin/nekocli", "bin/nekopi.mjs", "bin/nekocli.mjs"]) {
    expect(archive!.files.find(file => file.path === path)!.mode & 0o111).not.toBe(0);
  }
  for (const path of paths.filter(path => path.startsWith("dist/") && path.endsWith(".js"))) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["'](\.\/[^"']+\.js)["']/gu)) {
      expect(paths).toContain(posix.join(posix.dirname(path), match[1]!));
    }
    // Catch invalid split exports from the build tool before publishing.
    await promisify(execFile)("node", ["--check", path], { cwd, timeout: 10_000 });
  }
});
