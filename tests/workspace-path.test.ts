import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inside, resolveInside } from "../src/tools/workspace-path.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "nekopi-path-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
  return root;
}

test("a workspace-relative path resolves to its root, target and display name", async () => {
  const root = await workspace();
  const file = await resolveInside(root, "src/a.ts");
  if (!file) throw new Error("expected src/a.ts to resolve");
  expect(file.display).toBe("src/a.ts");
  expect(file.absolute.endsWith("src/a.ts")).toBe(true);
  // The root is realpathed, so a caller comparing against it does not have to
  // care whether the workspace itself arrived through a symlink.
  const self = await resolveInside(root, ".");
  expect(file.root).toBe(self?.absolute ?? "");
});

test("a path that leaves the workspace is refused before the filesystem is touched", async () => {
  const root = await workspace();
  for (const requested of ["/etc/passwd", "../outside.ts", "src/../../outside.ts"]) {
    expect(await resolveInside(root, requested)).toBeUndefined();
  }
});

test("a symlink inside the workspace that points out of it is refused", async () => {
  // The second check exists for exactly this: the requested path looks local,
  // and only the resolved path shows where it goes.
  const root = await workspace();
  const outside = await mkdtemp(join(tmpdir(), "nekopi-path-outside-"));
  roots.push(outside);
  await writeFile(join(outside, "secret.ts"), "export const secret = 1;\n");
  await symlink(join(outside, "secret.ts"), join(root, "link.ts"));
  expect(await resolveInside(root, "link.ts")).toBeUndefined();
});

test("a missing file is refused rather than thrown", async () => {
  const root = await workspace();
  expect(await resolveInside(root, "src/absent.ts")).toBeUndefined();
});

test("inside accepts the root itself and rejects a sibling with a shared prefix", async () => {
  expect(inside("/work", "/work")).toBe(true);
  expect(inside("/work", "/work/src/a.ts")).toBe(true);
  expect(inside("/work", "/work-other/a.ts")).toBe(false);
  expect(inside("/work", "/elsewhere")).toBe(false);
});
