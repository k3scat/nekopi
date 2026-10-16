/** Cold-process timings on a generated, reusable large workspace. No provider calls. */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const usage = "Usage: node scripts/profile-cli.mjs [--cli PATH] [--runtime node|bun] [--runs N] [--fixture PATH] [--out PATH]";
if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
  console.log(`${usage}\nGenerate a temporary workspace, or reuse a fixture from an earlier run.`);
  process.exit(0);
}
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--cli", "--runtime", "--runs", "--fixture", "--out"].includes(args[i]) || !args[i + 1]) {
    throw new Error(usage);
  }
  options[args[i].slice(2)] = args[i + 1];
}
const runs = Number(options.runs ?? 5);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100) throw new Error("--runs must be 1 to 100");
const cli = resolve(options.cli ?? fileURLToPath(new URL("../bin/nekocli.mjs", import.meta.url)));
const runtime = options.runtime ?? "node";
const version = spawnSync(runtime, ["--version"], { encoding: "utf8" });
if (version.error || version.status !== 0) throw new Error(`Cannot start ${runtime}: ${version.error ?? version.stderr}`);
const fixture = options.fixture ? resolve(options.fixture) : await mkdtemp(join(tmpdir(), "nek-cli-profile-"));
const marker = join(fixture, ".nek-cli-profile.json");
let size;
if (options.fixture) {
  size = JSON.parse(await readFile(marker, "utf8"));
} else {
  size = { files: 5025, lines: 0, bytes: 0 };
  const save = async (path, text) => {
    await writeFile(join(fixture, path), text);
    size.lines += text.split("\n").length - 1;
    size.bytes += Buffer.byteLength(text);
  };
  for (let group = 0; group < 50; group++) {
    await mkdir(join(fixture, "src", String(group)), { recursive: true });
    for (let i = 0; i < 100; i++) {
      const text = Array.from({ length: 12 }, (_, n) =>
        `export function work${n}(value: number) {\n  const result = value + ${n};\n  return result;\n}\n`).join("\n");
      await save(`src/${group}/module${i}.ts`, text);
    }
  }
  await save("src/target.ts", "export function perf_target(value: number) {\n  return value + 1;\n}\n");
  await mkdir(join(fixture, "large"));
  const large = Array.from({ length: 1200 }, (_, n) =>
    `export function member${n}(value: number) {\n  const result = value + ${n};\n  return result;\n}\n`).join("\n")
    + 'export function finalMember() {\n  return "perf_hit";\n}\n';
  for (let i = 0; i < 24; i++) await save(`large/module${i}.ts`, large);
  await writeFile(marker, JSON.stringify(size));
}
const patch = "*** Begin Patch\n*** Update File: src/target.ts\n@@\n-  return value + 1;\n+  return value + 2;\n*** End Patch\n";
const cases = [
  ["help", ["--help"]],
  ["find", ["find", "*.ts", "src", "--limit", "100"]],
  ["grep-absent", ["grep", "perf_nonexistent_identifier"]],
  ["grep-files", ["grep", "work0", "src", "--files"]],
  ["grep-one", ["grep", "perf_target", "src"]],
  ["grep-large-labels", ["grep", "perf_hit", "large"]],
  ["read-small", ["read", "src/target.ts"]],
  ["read-preview", ["read", "large/module0.ts"]],
  ["read-range", ["read", "large/module0.ts", "--lines", "5900-5920"]],
  ["read-symbol", ["read", "large/module0.ts", "--symbol", "finalMember"]],
  ["lookup-symbol", ["read", "--symbol", "perf_target"]],
  ["write", ["write", "benchmark-output.txt"], "benchmark\n"],
  ["edit", ["edit", "benchmark-edit.txt"], '[{"oldText":"before","newText":"after"}]'],
  ["patch-check", ["patch", "--check"], patch],
];
const results = [];
for (const [name, argv, input = ""] of cases) {
  const times = [];
  let firstMs, outputBytes;
  for (let i = 0; i <= runs; i++) {
    if (name === "edit") await writeFile(join(fixture, "benchmark-edit.txt"), "before\n");
    const started = performance.now();
    const child = spawnSync(runtime, [cli, ...argv], { cwd: fixture, input, encoding: "utf8",
      timeout: 120000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, PI_OFFLINE: "1" } });
    const ms = performance.now() - started;
    if (child.error || child.status !== 0) throw new Error(`${name}: ${child.error ?? (child.stderr || child.stdout)}`);
    outputBytes = Buffer.byteLength(child.stdout);
    if (i === 0) firstMs = ms;
    else times.push(ms);
  }
  times.sort((a, b) => a - b);
  results.push({ name, firstMs, medianMs: times[Math.floor(times.length / 2)],
    p95Ms: times[Math.ceil(times.length * 0.95) - 1], outputBytes, samplesMs: times });
}
const report = { runtime, runtimeVersion: version.stdout.trim(), cli, fixture, size, runs, results };
console.table(results.map(row => ({ command: row.name, medianMs: +row.medianMs.toFixed(1), p95Ms: +row.p95Ms.toFixed(1) })));
console.log(`Fixture: ${fixture} (${size.files} files, ${size.lines} lines, ${size.bytes} bytes)`);
console.log("Each timing includes a new process. The filesystem cache is not cleared.");
if (options.out) await writeFile(resolve(options.out), JSON.stringify(report, null, 2) + "\n");
