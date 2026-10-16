#!/usr/bin/env node
// Match the source launcher's benchmark opt-out.
if (process.env.NEKOPI_REFUSE) {
  process.stderr.write(`nekopi: not available: ${process.env.NEKOPI_REFUSE}\n`);
  process.exit(1);
}
import { runCli } from "../dist/cli.js";

await runCli(process.argv.slice(2));
