import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("importing the user CLI does not start a session or execute argv", async () => {
  const child = Bun.spawn([process.execPath, "--eval", `
    process.argv = [process.execPath, "cli.ts", "--version"];
    const { runCli } = await import(${JSON.stringify(new URL("../src/cli.ts", import.meta.url).href)});
    if (typeof runCli !== "function") throw new Error("Missing CLI entry point.");
    console.log("imported");
  `], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0" } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toBe("imported\n");
});

test("inspect help does not load invalid local settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nekopi-inspect-help-"));
  try {
    await writeFile(join(directory, "nekopi.json"), "invalid JSON");
    const entry = new URL("../src/cli.ts", import.meta.url).pathname;
    for (const args of [["--help"], ["--trust-project", "-h"], ["--unknown"]]) {
      const child = Bun.spawn([process.execPath, entry, "inspect", ...args], {
        stdout: "pipe", stderr: "pipe", env: { ...process.env, PI_CODING_AGENT_DIR: directory },
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(args[0] === "--unknown" ? 1 : 0);
      expect(stdout + stderr).toContain("Usage: nekopi inspect");
      expect(stdout + stderr).not.toContain("JSON");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
