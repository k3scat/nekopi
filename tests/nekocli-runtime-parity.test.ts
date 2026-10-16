import { expect, test } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const launcher = new URL("../bin/nek", import.meta.url).pathname;

async function run(cwd: string, runtime: "node" | "bun" | "auto", args: string[], input = "",
  env: Record<string, string> = {}, inputFile?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const stdinFd = inputFile ? openSync(inputFile, "r") : undefined;
    const child = spawn(launcher, args, {
      cwd, env: { ...process.env, NEKOPI_ASK_BRIDGE_KEY: "", NEKOPI_CLI_RUNTIME: runtime, ...env },
      stdio: [stdinFd ?? "pipe", "pipe", "pipe"],
    });
    if (stdinFd !== undefined) closeSync(stdinFd);
    let stdout = "", stderr = "";
    child.stdout!.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr!.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
    if (!inputFile) child.stdin!.end(input);
  });
}

test("the pinned Bun CLI agrees with Node for every command", async () => {
  const dirs = await Promise.all(["node", "bun"].map(async name => {
    const dir = await mkdtemp(join(tmpdir(), `nek-runtime-${name}-`));
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src/sample.ts"),
      "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    await writeFile(join(dir, "src/other.txt"), "needle\n");
    return dir;
  }));
  const cases: Array<{ args: string[]; input?: string }> = [
    { args: ["--help"] },
    { args: ["image", "--help"] },
    { args: ["image", "-h"] },
    { args: ["image", "--status", "image-example"] },
    { args: ["image", "--cancel", "image-example"] },
    { args: ["read", "src/sample.ts"] },
    { args: ["read", "src/sample.ts", "--lines", "1-2"] },
    { args: ["read", "src/sample.ts", "--lines", "1-2-3"] },
    { args: ["read", "--symbol", "add", "--lines", "1-2"] },
    { args: ["read", "src/sample.ts", "--symbol", "add"] },
    { args: ["grep", "return", "src", "--context", "1"] },
    { args: ["grep", "[", "src"] },
    { args: ["find", "*.ts", "src"] },
    { args: ["patch", "--check"], input: "*** Begin Patch\n*** Update File: src/sample.ts\n@@\n-  return a + b;\n+  return a - b;\n*** End Patch\n" },
    { args: ["patch"], input: "*** Begin Patch\n*** Update File: src/sample.ts\n@@\n-  return a + b;\n+  return a - b;\n*** End Patch\n" },
    { args: ["edit", "src/other.txt"], input: '[{"oldText":"needle","newText":"thread"}]' },
    { args: ["write", "src/new.txt"], input: "new content\n" },
    { args: ["read", "src/absent.txt"] },
  ];
  try {
    for (const { args, input } of cases) {
      const results = await Promise.all(dirs.map((dir, index) =>
        run(dir, index === 0 ? "node" : "bun", args, input)));
      const normal = (text: string) => dirs.reduce((value, dir) => value.replaceAll(dir, "<workspace>"), text);
      expect({ ...results[1], stdout: normal(results[1]!.stdout), stderr: normal(results[1]!.stderr) },
        args.join(" ")).toEqual({ ...results[0], stdout: normal(results[0]!.stdout), stderr: normal(results[0]!.stderr) });
    }
    for (const path of ["src/sample.ts", "src/other.txt", "src/new.txt"]) {
      expect(await readFile(join(dirs[1]!, path), "utf8")).toBe(await readFile(join(dirs[0]!, path), "utf8"));
    }
    const patchInput = "*** Begin Patch\n*** Update File: src/file-input.txt\n@@\n-before\n+after\n*** End Patch\n";
    for (const dir of dirs) {
      await writeFile(join(dir, "src/file-input.txt"), "before\n");
      await writeFile(join(dir, "input.patch"), patchInput);
      await writeFile(join(dir, "input.edit"), '[{"oldText":"before","newText":"edited"}]');
      await writeFile(join(dir, "input.write"), "written from a file\n");
    }
    for (const [args, file] of [
      [["patch", "--check"], "input.patch"],
      [["edit", "src/file-input.txt"], "input.edit"],
      [["write", "src/from-file.txt"], "input.write"],
    ] as const) {
      const results = await Promise.all(dirs.map((dir, index) =>
        run(dir, index === 0 ? "node" : "bun", [...args], "", {}, join(dir, file))));
      expect(results[1], `regular-file stdin for ${args[0]}`).toEqual(results[0]!);
      expect(results[1]!.code).toBe(0);
    }
    expect(await readFile(join(dirs[1]!, "src/file-input.txt"), "utf8")).toBe("edited\n");
    expect(await readFile(join(dirs[1]!, "src/from-file.txt"), "utf8")).toBe("written from a file\n");
    const shell = '"$1" patch --check <<\'PATCH\'\n'
      + patchInput.replace("-before\n+after", "-edited\n+after") + 'PATCH\n';
    const { stdout } = await promisify(execFile)("bash", ["-c", shell, "bash", launcher], {
      cwd: dirs[1], env: { ...process.env, NEKOPI_CLI_RUNTIME: "bun" },
    });
    expect(stdout).toContain("Would apply:\n");
    const largeInput = `${"x".repeat(65_536)}\n`;
    const largeShell = '"$1" write src/heredoc.txt <<\'DATA\'\n' + largeInput + 'DATA\n';
    await promisify(execFile)("bash", ["-c", largeShell, "bash", launcher], {
      cwd: dirs[1], env: { ...process.env, NEKOPI_CLI_RUNTIME: "bun" },
    });
    expect(await readFile(join(dirs[1]!, "src/heredoc.txt"), "utf8")).toBe(largeInput);
    expect(await run(dirs[0]!, "auto", ["--help"])).toEqual(await run(dirs[0]!, "bun", ["--help"]));
    const fakeBun = join(dirs[0]!, "bun");
    await writeFile(fakeBun, "#!/bin/sh\nprintf '1.3.0\\n'\n");
    await chmod(fakeBun, 0o755);
    expect(await run(dirs[0]!, "auto", ["--help"], "",
      { PATH: `${dirs[0]}:${process.env.PATH}` })).toEqual(await run(dirs[0]!, "node", ["--help"]));
  } finally {
    await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
  }
}, 60_000);
