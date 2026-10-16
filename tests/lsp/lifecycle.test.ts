import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createSdkFixture } from "../helpers/model-server.ts";

test("the semantic layer closes its compiler on reload and session shutdown", async () => {
  // Diagnostics is the layer's one consumer in the product, so this asks for
  // it and reaches the compiler the way an edit does. The package is not
  // loaded through the manifest here: under `loadPackage` the fixture does not
  // re-read the user config on reload, and this test is about the compiler's
  // lifetime rather than package loading, which `integration.test.ts` covers.
  const fixture = await createSdkFixture({
    sixTools: true,
    globalConfig: { languageServers: { enabled: true,
      servers: { typescript: { command: join(import.meta.dir, "missing-lifecycle-language-server") } } },
      diagnostics: { enabled: true } } });
  const require = createRequire(import.meta.url);
  const pidFile = join(fixture.cwd, "compiler.pid");
  let pid: number | undefined;
  try {
    const lib = join(fixture.cwd, "node_modules/typescript/lib");
    await mkdir(lib, { recursive: true });
    await writeFile(join(lib, "../package.json"), JSON.stringify({ name: "typescript", version: "5.9.3" }));
    await symlink(require.resolve("typescript"), join(lib, "typescript.js"));
    await writeFile(join(lib, "tsserver.js"), `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); require(${JSON.stringify(require.resolve("typescript/lib/tsserver.js"))});`);
    await writeFile(join(fixture.cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { noLib: true }, files: ["source.ts"] }));
    await writeFile(join(fixture.cwd, "source.ts"), "export const answer = 42;\n");
    // Each call renames the constant, so successive edits always have a match.
    let round = 0;
    const query = async () => {
      const [before, after] = [`answer${round || ""}`, `answer${++round}`];
      fixture.setResponses([
        fauxAssistantMessage(fauxToolCall("edit",
          { path: "source.ts", edits: [{ oldText: before, newText: after }] }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Renamed the declaration."),
      ]);
      await fixture.session.prompt("Rename the answer declaration.");
      const result = fixture.session.messages.findLast(message => message.role === "toolResult");
      expect(result?.isError).toBe(false);
      return Number(await readFile(pidFile, "utf8"));
    };
    pid = await query();
    expect(() => process.kill(pid!, 0)).not.toThrow();
    await fixture.session.reload();
    expect(() => process.kill(pid!, 0)).toThrow();
    const previous = pid;
    pid = await query();
    expect(pid).not.toBe(previous);
    await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expect(() => process.kill(pid!, 0)).toThrow();
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.cleanup(); }
}, 20_000);
