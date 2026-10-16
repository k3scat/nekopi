import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { COMMANDS } from "../src/tools/commands.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

test("documentation links point to existing files and Markdown headings", async () => {
  const docs = ["README.md", ...(await readdir(join(root, "docs")))
    .filter(name => name.endsWith(".md")).map(name => `docs/${name}`)];
  for (const file of docs) {
    const text = await readFile(join(root, file), "utf8");
    for (const match of text.matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/gu)) {
      const href = match[1]!;
      if (/^[a-z][a-z\d+.-]*:/iu.test(href)) continue;
      const [path, fragment] = href.split("#");
      const target = path ? resolve(root, dirname(file), decodeURIComponent(path)) : join(root, file);
      expect(await stat(target).catch(() => undefined), `${file}: ${href}`).toBeDefined();
      if (fragment && target.endsWith(".md")) {
        const content = await readFile(target, "utf8");
        const headings = [...content.matchAll(/^#{1,6}\s+(.+)$/gmu)].map(heading => heading[1]!
          .toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/gu, "-"));
        expect(headings, `${file}: ${href}`).toContain(fragment);
      }
    }
  }
});

test("documented settings and defaults agree with configuration loading", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nekopi-docs-"));
  try {
    const { config } = await loadConfig({ cwd: directory, agentDir: directory, trustedProject: false });
    const text = await readFile(join(root, "docs/configuration.md"), "utf8");
    const rows = new Map([...text.matchAll(/^\| `([\w.]+)` \| ([^|]+)\|/gmu)]
      .map(match => [match[1]!, match[2]!.trim()]));
    const expected = ["languageServers.servers"];
    for (const [section, fields] of Object.entries(config)) {
      for (const [field, value] of Object.entries(fields)) {
        const key = `${section}.${field}`;
        expected.push(key);
        expect(rows.get(key), key).toBe(`\`${value}\``);
      }
    }
    expect([...rows.keys()].sort()).toEqual(expected.sort());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the reference names every command and keeps its long flags discoverable", async () => {
  const text = await readFile(join(root, "docs/tools.md"), "utf8");
  for (const command of COMMANDS) {
    expect(text, command.name).toContain(`nek ${command.name}`);
    for (const flag of command.flags ?? []) {
      if (flag.startsWith("--")) expect(text, `${command.name} ${flag}`).toContain(flag);
    }
  }
});
