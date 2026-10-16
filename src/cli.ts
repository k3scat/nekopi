import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPackageUpdate, UPDATE_HELP, updateNekopi } from "./update.ts";

export async function runCli(args: string[]): Promise<void> {
  try {
    if (args[0] === "update") {
      const options = args.slice(1);
      if (options.length === 1 && (options[0] === "--help" || options[0] === "-h")) {
        console.log(UPDATE_HELP);
        return;
      }
      if (options.length === 0) {
        process.exitCode = await updateNekopi(fileURLToPath(new URL("..", import.meta.url)));
        return;
      }
      if (!isPackageUpdate(options)) throw new Error(UPDATE_HELP);
    }
    // Keep Pi and its native dependencies out of the self-update process.
    const { runMainCli }: typeof import("./cli-main.ts") = await import(new URL("./cli-main.js", import.meta.url).href);
    await runMainCli(args);
  } catch (error) {
    console.error(`nekopi: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runCli(process.argv.slice(2));
}
