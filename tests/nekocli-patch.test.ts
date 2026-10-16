import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runNekocli } from "../src/nekocli.ts";

const patch = (cwd: string, text: string, check = false) =>
  runNekocli(check ? ["patch", "--check"] : ["patch"], cwd, async () => text);

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

test("concurrent patches in one process never share another caller's diff", async () => {
  const root = await mkdtemp(join(tmpdir(), "nekocli-concurrent-patches-"));
  const now = Date.now;
  try {
    const dirs = Array.from({ length: 6 }, (_, i) => join(root, String(i)));
    for (const cwd of dirs) {
      await mkdir(cwd);
      await writeFile(join(cwd, "source.txt"), "before\n");
    }
    // Every call starts in the same clock tick; isolation must not depend on timing.
    Date.now = () => 1_700_000_000_000;
    const results = await Promise.all(dirs.map((cwd, i) => patch(cwd,
      `--- a/source.txt\n+++ b/source.txt\n@@ -1 +1 @@\n-before\n+after-${i}\n`)));
    Date.now = now;
    for (const [i, cwd] of dirs.entries()) {
      expect(results[i]!.failed).toBeUndefined();
      expect(await readFile(join(cwd, "source.txt"), "utf8")).toBe(`after-${i}\n`);
    }
  } finally { Date.now = now; await rm(root, { recursive: true, force: true }); }
});

async function threeWayCase(base: string, wanted: string, current: string) {
  const cwd = await mkdtemp(join(tmpdir(), "nekocli-threeway-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Nekopi test");
  git(cwd, "config", "user.email", "nekopi@example.test");
  await writeFile(join(cwd, "source.txt"), base);
  git(cwd, "add", "source.txt");
  git(cwd, "commit", "-qm", "base");
  await writeFile(join(cwd, "source.txt"), wanted);
  const diff = git(cwd, "diff", "--", "source.txt");
  await writeFile(join(cwd, "source.txt"), current);
  git(cwd, "add", "source.txt");
  git(cwd, "commit", "-qm", "current");
  return { cwd, diff };
}

test("malformed raw diffs name their syntax mistake without changing successful output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nekocli-patch-"));
  try {
    await writeFile(join(cwd, "source.txt"), "old\n");
    const bare = "--- a/source.txt\n+++ b/source.txt\n@@\n-old\n+new\n";
    for (const check of [false, true]) {
      const result = await patch(cwd, bare, check);
      expect(result.failed).toBe(true);
      expect(result.text).toContain("No valid patches in input");
      expect(result.text).toContain("A unified diff needs a numbered header");
    }

    const strayEnd = "--- a/source.txt\n+++ b/source.txt\n@@ -1,2 +1,2 @@\n-old\n+new\n*** End Patch\n";
    const malformed = await patch(cwd, strayEnd);
    expect(malformed.failed).toBe(true);
    expect(malformed.text).toContain("Remove *** End Patch from a unified diff");
    expect(await readFile(join(cwd, "source.txt"), "utf8")).toBe("old\n");

    const valid = "--- a/source.txt\n+++ b/source.txt\n@@ -1 +1 @@\n-old\n+new\n";
    const applied = await patch(cwd, valid);
    expect(applied.failed).toBeUndefined();
    expect(applied.text).toBe("Patched 1 file(s):\nsource.txt");
    expect(await readFile(join(cwd, "source.txt"), "utf8")).toBe("new\n");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("raw diff recovery recognizes Git errors with a filename and line number", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nekocli-patch-format-"));
  const previousPath = process.env.PATH;
  try {
    const bin = join(cwd, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "git"), "#!/bin/sh\nprintf '%s\\n' 'error: corrupt patch at /tmp/input.diff:6' >&2\nexit 128\n");
    await chmod(join(bin, "git"), 0o755);
    await writeFile(join(cwd, "source.txt"), "old\n");
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
    const diff = "--- a/source.txt\n+++ b/source.txt\n@@ -1,2 +1,2 @@\n-old\n+new\n*** End Patch\n";
    for (const check of [false, true]) {
      const result = await patch(cwd, diff, check);
      expect(result.failed).toBe(true);
      expect(result.text).toContain("corrupt patch at /tmp/input.diff:6");
      expect(result.text).toContain("Remove *** End Patch from a unified diff");
    }
    expect(await readFile(join(cwd, "source.txt"), "utf8")).toBe("old\n");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a conflicting three-way retry leaves the working tree unchanged", async () => {
  const current = "a\nother change\nc\n";
  const { cwd, diff } = await threeWayCase("a\nb\nc\n", "a\npatch change\nc\n", current);
  try {
    expect((await patch(cwd, diff)).failed).toBe(true);
    expect(await readFile(join(cwd, "source.txt"), "utf8")).toBe(current);
    expect(git(cwd, "status", "--porcelain")).toBe("");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a clean three-way retry still applies the patch", async () => {
  const { cwd, diff } = await threeWayCase("a\nb\nc\nd\ne\n", "a\npatch change\nc\nd\ne\n",
    "a\nb\nc\nd\nother change\n");
  try {
    const result = await patch(cwd, diff);
    expect(result.failed).not.toBe(true);
    expect(result.text).toContain("three-way merge");
    expect(await readFile(join(cwd, "source.txt"), "utf8")).toBe("a\npatch change\nc\nd\nother change\n");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("an envelope checks adds and updates together before changing any file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nekocli-patch-"));
  try {
    await writeFile(join(cwd, "first.txt"), "before\n");
    await writeFile(join(cwd, "exists.txt"), "keep\n");
    const text = "*** Begin Patch\n*** Update File: first.txt\n@@\n-before\n+after\n"
      + "*** Add File: exists.txt\n+clobber\n*** End Patch\n";
    expect((await patch(cwd, text, true)).failed).toBe(true);
    expect((await patch(cwd, text)).failed).toBe(true);
    expect(await readFile(join(cwd, "first.txt"), "utf8")).toBe("before\n");
    expect(await readFile(join(cwd, "exists.txt"), "utf8")).toBe("keep\n");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("an envelope refuses paths outside the workspace, including symlinks", async () => {
  const parent = await mkdtemp(join(tmpdir(), "nekocli-patch-"));
  const cwd = join(parent, "workspace");
  try {
    await writeFile(join(parent, "outside.txt"), "before\n");
    await mkdir(cwd);
    await symlink(parent, join(cwd, "escape"));
    for (const path of ["../outside.txt", "escape/outside.txt"]) {
      const text = `*** Begin Patch\n*** Update File: ${path}\n@@\n-before\n+after\n*** End Patch\n`;
      expect((await patch(cwd, text)).failed).toBe(true);
      expect(await readFile(join(parent, "outside.txt"), "utf8")).toBe("before\n");
    }
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("an envelope applies an add, update and delete as one git patch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nekocli-patch-"));
  try {
    await writeFile(join(cwd, "old.txt"), "old\n");
    await writeFile(join(cwd, "delete.txt"), "gone\n");
    const text = "*** Begin Patch\n*** Update File: old.txt\n@@\n-old\n+new\n"
      + "*** Add File: new.txt\n+added\n*** Delete File: delete.txt\n*** End Patch\n";
    expect((await patch(cwd, text, true)).failed).not.toBe(true);
    expect(await readFile(join(cwd, "old.txt"), "utf8")).toBe("old\n");
    expect((await patch(cwd, text)).failed).not.toBe(true);
    expect(await readFile(join(cwd, "old.txt"), "utf8")).toBe("new\n");
    expect(await readFile(join(cwd, "new.txt"), "utf8")).toBe("added\n");
    await expect(readFile(join(cwd, "delete.txt"), "utf8")).rejects.toThrow();
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a malformed envelope does not apply its valid prefix", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nekocli-patch-"));
  try {
    await writeFile(join(cwd, "source.txt"), "old\n");
    const malformed = [
      "*** Begin Patch\n*** Update File: source.txt\n@@\n-old\n+new\nmissing prefix\n*** End Patch\n",
      "*** Begin Patch\n*** Update File: source.txt\n@@\n-old\n+new\n",
      "*** Begin Patch\n*** Add File: new.txt\n+first\nmissing prefix\n*** End Patch\n",
    ];
    for (const text of malformed) {
      await expect(patch(cwd, text)).rejects.toThrow("invalid patch envelope");
      expect(await readFile(join(cwd, "source.txt"), "utf8")).toBe("old\n");
      await expect(readFile(join(cwd, "new.txt"), "utf8")).rejects.toThrow();
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("complete consecutive envelopes still apply together", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nekocli-patch-"));
  try {
    await writeFile(join(cwd, "first.txt"), "before\n");
    await writeFile(join(cwd, "second.txt"), "old\n");
    const text = "*** Begin Patch\n*** Update File: first.txt\n@@\n-before\n+after\n*** End Patch\n"
      + "*** Begin Patch\n*** Update File: second.txt\n@@\n-old\n+new\n*** End Patch\n";
    expect((await patch(cwd, text)).failed).not.toBe(true);
    expect(await readFile(join(cwd, "first.txt"), "utf8")).toBe("after\n");
    expect(await readFile(join(cwd, "second.txt"), "utf8")).toBe("new\n");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("empty-file deletes stay atomic with other envelope changes and dry runs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nekocli-empty-delete-"));
  try {
    await writeFile(join(cwd, "empty space.txt"), "");
    await writeFile(join(cwd, "source.txt"), "before\n");
    const text = "*** Begin Patch\n*** Delete File: empty space.txt\n*** Update File: source.txt\n@@\n-before\n+after\n*** End Patch\n";
    expect((await patch(cwd, text, true)).failed).not.toBe(true);
    expect(await readFile(join(cwd, "empty space.txt"), "utf8")).toBe("");
    expect(await readFile(join(cwd, "source.txt"), "utf8")).toBe("before\n");
    expect((await patch(cwd, text.replace("-before", "-missing"))).failed).toBe(true);
    expect(await readFile(join(cwd, "empty space.txt"), "utf8")).toBe("");
    expect((await patch(cwd, text)).failed).not.toBe(true);
    await expect(readFile(join(cwd, "empty space.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(join(cwd, "source.txt"), "utf8")).toBe("after\n");
    await writeFile(join(cwd, "only.txt"), "");
    expect((await patch(cwd, "*** Begin Patch\n*** Delete File: only.txt\n*** End Patch\n")).failed)
      .not.toBe(true);
    await expect(readFile(join(cwd, "only.txt"), "utf8")).rejects.toThrow();
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
