import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isPackageUpdate, updateNekopi } from "../src/update.ts";
import { workspaces } from "./helpers/workspace.ts";

const workspace = workspaces("update with spaces");
afterEach(workspace.cleanup);

async function installation(body = "pkg.version = '1.1.0'; fs.writeFileSync(metadata, JSON.stringify(pkg));") {
  const root = await workspace.make();
  const globalRoot = join(root, "lib/node_modules");
  const installed = join(globalRoot, "nekopi");
  const node = join(root, "bin", process.platform === "win32" ? "node.exe" : "node");
  const npm = join(root, "bin/node_modules/npm/bin/npm-cli.js");
  const log = join(root, "commands.jsonl");
  const directory = join(root, "global-root.txt");
  await mkdir(installed, { recursive: true });
  await mkdir(dirname(npm), { recursive: true });
  await writeFile(join(installed, "package.json"), JSON.stringify({ name: "nekopi", version: "1.0.0" }));
  await writeFile(directory, globalRoot + "\n");
  await symlink(Bun.which("node")!, node);
  await writeFile(npm, `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, cwd: process.cwd()}) + '\\n');
if (args.join(' ') === 'root --global') process.stdout.write(fs.readFileSync(${JSON.stringify(directory)}, 'utf8'));
else if (args.join(' ') === 'install --global nekopi@latest') {
  const metadata = ${JSON.stringify(join(installed, "package.json"))};
  const pkg = JSON.parse(fs.readFileSync(metadata, 'utf8'));
  ${body}
} else process.exit(99);
`);
  const commands = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n")
    .filter(Boolean).map(line => JSON.parse(line) as { args: string[]; cwd: string });
  return { root, globalRoot, installed, node, npm, directory, commands };
}

test("a confirmed global install updates only nekopi@latest outside the workspace", async () => {
  const setup = await installation();
  expect(await updateNekopi(setup.installed, setup.node)).toBe(0);
  expect(await setup.commands()).toEqual([
    { args: ["root", "--global"], cwd: dirname(setup.node) },
    { args: ["install", "--global", "nekopi@latest"], cwd: dirname(setup.node) },
  ]);
  expect(JSON.parse(await readFile(join(setup.installed, "package.json"), "utf8")).version).toBe("1.1.0");
});

test("an unchanged version is a successful update", async () => {
  const setup = await installation("");
  expect(await updateNekopi(setup.installed, setup.node)).toBe(0);
  expect(await setup.commands()).toHaveLength(2);
});

test("installer failures retain the actual exit code", async () => {
  const setup = await installation("process.exit(17);");
  expect(await updateNekopi(setup.installed, setup.node)).toBe(17);
  expect(JSON.parse(await readFile(join(setup.installed, "package.json"), "utf8")).version).toBe("1.0.0");
});

test.skipIf(process.platform === "win32")("a terminated installer is not reported as successful", async () => {
  const setup = await installation("process.kill(process.pid, 'SIGTERM');");
  await expect(updateNekopi(setup.installed, setup.node)).rejects.toThrow("SIGTERM");
});

test("a checkout is refused before npm runs, even in a global-shaped directory", async () => {
  const setup = await installation();
  await mkdir(join(setup.installed, ".git"));
  await expect(updateNekopi(setup.installed, setup.node)).rejects.toThrow("source checkouts");
  expect(await setup.commands()).toEqual([]);
});

test("local installs and other npm prefixes cannot update a different global copy", async () => {
  const setup = await installation();
  const local = join(setup.root, "project/node_modules/nekopi");
  await mkdir(local, { recursive: true });
  await writeFile(join(local, "package.json"), JSON.stringify({ name: "nekopi", version: "0.9.0" }));
  await expect(updateNekopi(local, setup.node)).rejects.toThrow("same Node/npm installation");
  expect((await setup.commands()).map(command => command.args)).toEqual([["root", "--global"]]);
  expect(JSON.parse(await readFile(join(local, "package.json"), "utf8")).version).toBe("0.9.0");
});

test("npm-linked packages are not replaced by registry packages", async () => {
  const setup = await installation();
  const source = join(setup.root, "source/node_modules/nekopi");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "nekopi", version: "1.0.0" }));
  await rm(setup.installed, { recursive: true });
  await symlink(source, setup.installed, "junction");
  await expect(updateNekopi(source, setup.node)).rejects.toThrow("unlinked global npm installation");
  expect(await lstat(setup.installed).then(info => info.isSymbolicLink())).toBe(true);
  expect(await setup.commands()).toHaveLength(1);
});

test("missing adjacent npm and malformed global paths fail without an install", async () => {
  const setup = await installation();
  await writeFile(setup.directory, "not an absolute global path\n");
  await expect(updateNekopi(setup.installed, setup.node)).rejects.toThrow("Cannot confirm");
  expect(await setup.commands()).toHaveLength(1);
  await rm(setup.npm);
  await expect(updateNekopi(setup.installed, setup.node)).rejects.toThrow("Cannot locate npm beside Node");
  expect(await setup.commands()).toHaveLength(1);
});

test("only explicit extension and model modes can be delegated to Pi", () => {
  for (const args of [["--extensions"], ["--extension", "npm:example", "--no-approve"], ["--extension", "pi"], ["--models"],
    ["--approve", "--extensions"], ["--extension", "pi", "-na"], ["-a", "--extensions"]]) {
    expect(isPackageUpdate(args)).toBe(true);
  }
  for (const args of [[], ["pi"], ["self"], ["--self"], ["--all"], ["--extensions", "pi"],
    ["--extensions", "--self"], ["--models", "--all"], ["--extension"], ["--extension", "--models"],
    ["--approve"], ["--extensions", "-a", "pi"], ["--extension", "--approve", "pi"]]) {
    expect(isPackageUpdate(args)).toBe(false);
  }
});

test("the built update command handles help, refusals and invalid targets without importing Pi", async () => {
  const root = await workspace.make({
    "deny-sdk.mjs": 'import {registerHooks} from "node:module"; registerHooks({resolve(name, ctx, next) { if (name === "@earendil-works/pi-coding-agent") throw Error("Pi delegate reached"); return next(name, ctx); }});\n',
    "nekopi.json": "invalid JSON",
  });
  const launcher = resolve("bin/nekopi.mjs");
  for (const [args, code, text] of [
    [["--help"], 0, "Usage: nekopi update"],
    [[], 1, "source checkouts"],
    [["--all"], 1, "Usage: nekopi update"],
    [["--self"], 1, "Usage: nekopi update"],
    [["--extension", "--models"], 1, "Usage: nekopi update"],
    [["--extensions"], 1, "Pi delegate reached"],
    [["--no-approve", "--extensions"], 1, "Pi delegate reached"],
  ] as const) {
    const child = Bun.spawn(["node", "--import", join(root, "deny-sdk.mjs"), launcher, "update", ...args], {
      cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, PI_CODING_AGENT_DIR: root },
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ args, status, output: stdout + stderr }).toEqual({ args, status: code, output: expect.stringContaining(text) });
  }
});
