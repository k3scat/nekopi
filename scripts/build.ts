import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

async function runBuild(args: string[]): Promise<void> {
  const usage = "Usage: bun run build [--help]";
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(`${usage}\nReplace generated dist files and build the CLI and extension.`);
    return;
  }
  if (args.length) throw new Error(usage);

  const root = new URL("..", import.meta.url);
  const output = new URL("dist/", root);
  // dist contains generated files only. Remove obsolete entry points before building.
  await rm(output, { recursive: true, force: true });
  let artifacts = 0;
  // Build the split CLI separately: Bun 1.2 duplicates exports when its lazy
  // modules are also shared with the extension's static entry point.
  for (const entries of [["src/cli.ts", "src/index.ts"], ["src/nekocli.ts"]]) {
    const result = await Bun.build({
      entrypoints: entries.map(path => fileURLToPath(new URL(path, root))),
      outdir: fileURLToPath(output),
      target: "node",
      packages: "external",
      splitting: entries.length === 1,
      sourcemap: "external",
    });
    if (!result.success) throw new AggregateError(result.logs, "NekoPi build failed.");
    artifacts += result.outputs.length;
  }
  console.log(`Built ${artifacts} artifacts in dist/.`);
}

if (import.meta.main) await runBuild(process.argv.slice(2));
