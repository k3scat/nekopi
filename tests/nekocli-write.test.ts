import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNekocli } from "../src/nekocli.ts";

test("write cannot follow a file or parent symlink outside the workspace", async () => {
  const parent = await mkdtemp(join(tmpdir(), "nekocli-write-"));
  const cwd = join(parent, "workspace");
  try {
    await mkdir(cwd);
    await writeFile(join(parent, "outside.txt"), "safe\n");
    await symlink(join(parent, "outside.txt"), join(cwd, "file.txt"));
    await symlink(parent, join(cwd, "directory"));
    for (const path of ["file.txt", "directory/outside.txt", "directory/new/file.txt"]) {
      await expect(runNekocli(["write", path], cwd, async () => "changed\n"))
        .rejects.toThrow();
      expect(await readFile(join(parent, "outside.txt"), "utf8")).toBe("safe\n");
    }
    await expect(stat(join(parent, "new"))).rejects.toThrow();
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("CLI edit refuses absolute, parent and symlink escapes but allows internal symlinks", async () => {
  const parent = await mkdtemp(join(tmpdir(), "nekocli-edit-"));
  const cwd = join(parent, "workspace");
  const edit = (path: string) => runNekocli(["edit", path], cwd,
    async () => '[{"oldText":"safe","newText":"changed"}]');
  try {
    await mkdir(cwd);
    await writeFile(join(parent, "outside.txt"), "safe\n");
    await symlink(join(parent, "outside.txt"), join(cwd, "file.txt"));
    await symlink(parent, join(cwd, "directory"));
    for (const path of ["../outside.txt", join(parent, "outside.txt"), "file.txt", "directory/outside.txt"]) {
      await expect(edit(path)).rejects.toThrow("inside the workspace");
      expect(await readFile(join(parent, "outside.txt"), "utf8")).toBe("safe\n");
    }
    await mkdir(join(cwd, "@.."));
    await writeFile(join(cwd, "@..", "outside.txt"), "safe\n");
    await writeFile(join(cwd, "file\u00a0name.txt"), "safe\n");
    await symlink(join(parent, "outside.txt"), join(cwd, "file name.txt"));
    for (const path of ["@../outside.txt", "file\u00a0name.txt"]) {
      await expect(edit(path)).rejects.toThrow();
      expect(await readFile(join(parent, "outside.txt"), "utf8")).toBe("safe\n");
    }
    await writeFile(join(cwd, "local.txt"), "safe\n");
    await expect(edit(join(cwd, "local.txt"))).rejects.toThrow("inside the workspace");
    await symlink(join(cwd, "local.txt"), join(cwd, "alias.txt"));
    await edit("alias.txt");
    expect(await readFile(join(cwd, "local.txt"), "utf8")).toBe("changed\n");
  } finally { await rm(parent, { recursive: true, force: true }); }
});
