import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function runSmoke(args) {
  const usage = "Usage: bun run smoke [--help]";
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(`${usage}\nCheck the built Node launcher without calling a model. Run build first.`);
    return;
  }
  if (args.length) throw new Error(usage);

  const { runNekocli } = await import("../dist/nekocli.js");
  const node = process.versions.bun ? "node" : process.execPath;
  const root = fileURLToPath(new URL("..", import.meta.url));
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const agentDir = await mkdtemp(path.join(tmpdir(), "nekopi-launcher-"));
  const options = {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
  };

  async function run(args) {
    const outputPath = path.join(agentDir, "stdout.txt");
    const errorPath = path.join(agentDir, "stderr.txt");
    const output = await open(outputPath, "w");
    let error;
    try {
      error = await open(errorPath, "w");
      const child = spawn(node, ["bin/nekopi.mjs", ...args], {
        ...options, stdio: ["ignore", output.fd, error.fd], timeout: 15_000, killSignal: "SIGKILL",
      });
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      const stdout = await readFile(outputPath, "utf8");
      const stderr = await readFile(errorPath, "utf8");
      assert.equal(result.code, 0, `Launcher ${args.join(" ")} exited with ${result.code ?? result.signal}.\n${stderr}`);
      return { stdout, stderr };
    } finally {
      await output.close();
      await error?.close();
    }
  }

  try {
    const version = await run(["--version"]);
    assert.equal(version.stdout, `NekoPi ${manifest.version} (Pi ${manifest.devDependencies["@earendil-works/pi-coding-agent"]})\n`);
    const inspected = await run(["inspect"]);
    const configuration = JSON.parse(inspected.stdout);
    assert.equal(configuration.config.nekocli.enabled, true);
    assert.equal(configuration.config.languageServers.enabled, true);
    assert.equal(configuration.config.diagnostics.enabled, false);
    assert.equal(configuration.config.telemetry.enabled, false);
    assert.equal(configuration.sources.user.path, path.join(agentDir, "nekopi.json"));
    assert.equal(configuration.sources.project.status, "untrusted");
    const help = await run(["--help"]);
    assert.equal(help.stdout.split("Pi commands and options follow:").length - 1, 1);
    assert.match(help.stdout, /--model/);

    // Derive command coverage from the built CLI, not a second command list.
    const declared = (await runNekocli(["--help"])).text
      .split("\n").flatMap(line => /^  ([a-z]+) /u.exec(line)?.[1] ?? []);
    assert.ok(declared.length >= 5, `nekocli --help listed ${declared.length} command(s).`);
    for (const name of ["nek", "nekocli"]) {
      const launcher = path.join(root, "bin", name);
      const probe = await new Promise((resolve, reject) => {
        const child = spawn(launcher, ["--help"], { cwd: root, stdio: ["ignore", "pipe", "pipe"],
          timeout: 15_000, killSignal: "SIGKILL" });
        let out = "", err = "";
        child.stdout.on("data", chunk => { out += chunk; });
        child.stderr.on("data", chunk => { err += chunk; });
        child.once("error", reject);
        child.once("close", code => resolve({ code, out, err }));
      });
      assert.equal(probe.code, 0, `bin/${name} exited with ${probe.code}.\n${probe.err}`);
      assert.match(probe.out, /^nekocli <command>/, `bin/${name} did not print its usage.`);
      for (const command of declared) {
        assert.match(probe.out, new RegExp(`^  ${command} `, "m"), `${name} --help omits ${command}.`);
      }
    }
    console.log("Built Node launcher: version, configuration, help, nek and nekocli passed.");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runSmoke(process.argv.slice(2));
}
