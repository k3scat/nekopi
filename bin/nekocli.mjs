#!/usr/bin/env node
// Allow benchmark hosts to disable source commands without changing the mount.
if (process.env.NEKOPI_REFUSE) {
  process.stderr.write(`nekocli: not available: ${process.env.NEKOPI_REFUSE}\n`);
  process.exit(1);
}
// Pi's tool module reads ready stdin during import under Bun. Capture input
// before loading it so regular-file redirection works like a pipe.
let input = "";
if (["patch", "edit", "write"].includes(process.argv[2]) && !process.stdin.isTTY) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  input = Buffer.concat(chunks).toString("utf8");
}
const { runNekocli } = await import("../dist/nekocli.js");

try {
  const result = await runNekocli(process.argv.slice(2), process.cwd(), async () => input);
  process.stdout.write(`${result.text}\n`);
  if (result.failed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`nekocli: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
