import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
});
