import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createReadBufferTool, readSelection } from "../src/tools/read.ts";
import { cliReadText } from "../src/tools/read/cli-output.ts";
import { cliRangeLimits } from "../src/tools/read/cli-budget.ts";
import { cliText, readSmallText, readTextSelection } from "../src/tools/read/cli-text.ts";
import { resolveRipgrep } from "../src/tools/search/ripgrep.ts";
import { indexSymbols, labelFor } from "../src/tools/syntax/labels.ts";
import { workspaces } from "./helpers/workspace.ts";

const workspace = workspaces("cli-performance");
afterEach(workspace.cleanup);

test("fast complete text reads match native numbered output", async () => {
  const root = await workspace.make();
  for (const text of ["", "x", "x\n", "\n", "x\n\n", "\uFEFFalpha\r\n🙂界\r\n", "x\n".repeat(200)]) {
    await writeFile(join(root, "file.ts"), text);
    const fast = await readSmallText(root, "file.ts");
    expect(fast).toBeDefined();
    const native = await createReadBufferTool(root).execute("read", { path: "file.ts", lineNumbers: true }, undefined, undefined, { cwd: root } as never);
    expect(await cliText(fast!, "file.ts")).toBe(cliReadText(native, "file.ts"));
  }
});

test("fast range and symbol reads preserve source evidence, limits and continuation", async () => {
  const root = await workspace.make({
    "source.ts": "export class Store {\n  load() {\n    return '界🙂';\n  }\n}\n",
    "large.txt": "界🙂 evidence\r\n".repeat(3000),
    "empty.txt": "",
  });
  for (const input of [
    { path: "source.ts", symbol: "Store/load" },
    { path: "source.ts", ranges: [{ start: 2, end: 3 }, { start: 5, end: 20 }] },
    { path: "large.txt", ranges: [{ start: 1, end: 2500 }, { start: 2700, end: 3500 }] },
    { path: "empty.txt", ranges: [{ start: 1, end: 20 }] },
  ]) {
    const prefix = "Declaration list\n\n";
    const fast = await readTextSelection(root, input, prefix);
    const native = await readSelection(root, {}, cliRangeLimits(input.path, prefix))(input);
    expect(fast).toEqual(native);
    expect(await cliText(fast!, input.path, prefix)).toBe(cliReadText(native, input.path, prefix));
  }
  await expect(readTextSelection(root, { path: "source.ts", ranges: Array.from({ length: 17 }, () => ({ start: 1, end: 1 })) }))
    .rejects.toThrow("1 to 16");
});

test("special paths, image signatures, invalid UTF-8 and large previews keep native handling", async () => {
  const root = await workspace.make({ "@file.ts": "text", "long.ts": "x\n".repeat(201), "big.txt": "x".repeat(2 * 1024 * 1024 + 1) });
  for (const data of [Buffer.from("GIF89a example"), Buffer.from("RIFF1234WEBPexample"), Buffer.from("BMexample"), Buffer.from([0xff, 0xd8, 0xff]), Buffer.from([0, 65]), Buffer.from([0xfe])]) {
    await writeFile(join(root, "image.ts"), data);
    expect(await readSmallText(root, "image.ts")).toBeUndefined();
    expect(await readTextSelection(root, { path: "image.ts", ranges: [{ start: 1, end: 2 }] })).toBeUndefined();
  }
  for (const path of ["@file.ts", "long.ts", "big.txt", join(root, "long.ts"), "missing.ts"]) {
    expect(await readSmallText(root, path)).toBeUndefined();
  }
});

test("standalone ripgrep resolution agrees with Pi directory overrides", async () => {
  const root = await workspace.make();
  const binary = process.platform === "win32" ? "rg.exe" : "rg";
  await mkdir(join(root, "agent", "bin"), { recursive: true });
  await writeFile(join(root, "agent", "bin", binary), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "agent", "bin", binary), 0o755);
  const before = process.env.PI_CODING_AGENT_DIR;
  try {
    for (const directory of [join(root, "agent"), relative(process.cwd(), join(root, "agent")),
      `~/${relative(homedir(), join(root, "agent"))}`, pathToFileURL(join(root, "agent")).href]) {
      process.env.PI_CODING_AGENT_DIR = directory;
      expect(await resolveRipgrep(undefined, "")).toBe(join(getAgentDir(), "bin", binary));
    }
    delete process.env.PI_CODING_AGENT_DIR;
    expect(getAgentDir()).toBe(join(homedir(), ".pi", "agent"));
  } finally {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
  }
});

test("line-focused symbol labels equal full outlines, including nested owners and boundary lines", async () => {
  const files = {
    "source.ts": "export class Store {\n  load() {\n    function inner() { return 1; }\n    return inner();\n  }\n}\nexport const other = 2;\n",
    "source.py": "class Store:\n    def load(self):\n        def inner():\n            return 1\n        return inner()\n\nother = 2\n",
    "source.cpp": "class Store {\npublic:\n  int load() {\n    return 1;\n  }\n};\nint other() { return 2; }\n",
  };
  const root = await workspace.make(files);
  const full = await indexSymbols(root, Object.keys(files));
  for (const [path, text] of Object.entries(files)) {
    for (let line = 1; line <= text.split("\n").length; line++) {
      const focused = await indexSymbols(root, [path], new Map([[path, [line]]]));
      expect(labelFor(focused, path, line) ?? null).toBe(labelFor(full, path, line) ?? null);
    }
  }
});

test.skipIf(process.platform === "win32")("built CLI common paths do not import the Pi SDK", async () => {
  const root = await workspace.make({
    "file.ts": "export function sample() {\n  return 1;\n}\n",
    "deny-sdk.mjs": 'import { registerHooks } from "node:module"; registerHooks({ resolve(name, ctx, next) { if (name === "@earendil-works/pi-coding-agent") throw new Error("unexpected Pi SDK import"); return next(name, ctx); } });\n',
  });
  const cli = resolve("bin/nekocli.mjs");
  const commands = [["--help"], ["find", "*.ts"], ["grep", "return"], ["grep", "return", "--files"],
    ["read", "file.ts"], ["read", "file.ts", "--lines", "1-2"], ["read", "file.ts", "--symbol", "sample"],
    ["read", "--symbol", "sample"], ["write", "written.txt"], ["patch", "--check"]];
  for (const args of commands) {
    const input = args[0] === "patch" ? "*** Begin Patch\n*** Update File: file.ts\n@@\n-  return 1;\n+  return 2;\n*** End Patch\n" : "contents\n";
    const result = spawnSync("node", ["--import", join(root, "deny-sdk.mjs"), cli, ...args], {
      cwd: root, input, encoding: "utf8", timeout: 10000,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") },
    });
    expect({ args, error: result.error?.message, status: result.status, stderr: result.stderr }).toEqual({ args, error: undefined, status: 0, stderr: "" });
  }
});
