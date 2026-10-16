import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/install-servers.sh", import.meta.url));

/** Run the provisioning script with no PATH, so it never installs during a test. */
async function run(args: string[], env: Record<string, string> = {}, cwd?: string) {
  const child = Bun.spawn(["/bin/sh", SCRIPT, ...args], {
    stdout: "pipe", stderr: "pipe", cwd, env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

test("help and the status report need no network and no toolchain", async () => {
  const help = await run(["--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("Usage: install-servers.sh");

  const report = await run([]);
  expect(report.code).toBe(0);
  // Without a toolchain nothing resolves, and the report says so rather than failing.
  expect(report.stdout).toContain("Installed language servers:");
  expect(report.stdout).toContain("typescript-language-server   -");
});

test("print shows pinned commands without running them", async () => {
  const printed = await run(["--print", "all"]);
  expect(printed.code).toBe(0);
  // A version must be pinned, so a rebuilt image installs the same server.
  for (const line of printed.stdout.split("\n").filter(item => item.startsWith("npm install"))) {
    expect(line).toMatch(/@\d+\.\d+\.\d+/);
  }
  expect(printed.stdout).toContain("typescript-language-server@");
  expect(printed.stdout).toContain("pyright@");
  expect(printed.stdout).toContain("gopls@v");
  expect(printed.stdout).not.toContain("@latest");
  // Nothing ran, so no "running:" line appears.
  expect(printed.stdout).not.toContain("running:");
});

test("a language this script will not guess at is named, not silently skipped", async () => {
  for (const language of ["rust", "cpp", "java"]) {
    const result = await run([language]);
    expect(result.code).toBe(0);
    expect(result.stderr + result.stdout).toContain("not installed by this script");
  }
});

test("a missing toolchain fails loudly so a build does not ship without a server", async () => {
  // npm is absent from this PATH, so the typescript install cannot proceed.
  const result = await run(["typescript"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("npm is required");
});

test("bad arguments are rejected before any install", async () => {
  const option = await run(["--bogus"]);
  expect(option.code).toBe(2);
  expect(option.stderr).toContain("unknown option");
  const language = await run(["klingon"]);
  expect(language.code).toBe(1);
  expect(language.stderr).toContain("unknown language klingon");
});

test("a later invalid language prevents earlier installs", async () => {
  const root = await mkdtemp(join(tmpdir(), "nekopi-install-"));
  try {
    const marker = join(root, "npm-called");
    const npm = join(root, "npm");
    await writeFile(npm, '#!/bin/sh\n: > "$NEKOPI_INSTALL_MARKER"\n');
    await chmod(npm, 0o755);
    const result = await run(["python", "klingon"], {
      PATH: `${root}:/usr/bin:/bin`, NEKOPI_INSTALL_MARKER: marker,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown language klingon");
    expect(existsSync(marker)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the report finds a server where nekopi finds one, not only on PATH", async () => {
  const home = await Bun.file(SCRIPT).text();
  // The report and the tool must agree, so it searches the same directories.
  for (const directory of ["node_modules/.bin", ".venv/bin", "go/bin", ".cargo/bin", "mason/bin"]) {
    expect(home).toContain(directory);
  }
});

test("the report searches ancestor package and virtual environment bins", async () => {
  const root = await mkdtemp(join(tmpdir(), "nekopi-servers-"));
  try {
    const nested = join(root, "project", "nested");
    const binaries = [
      join(root, "node_modules", ".bin", "typescript-language-server"),
      join(root, ".direnv", "bin", "gopls"),
    ];
    await mkdir(nested, { recursive: true });
    for (const binary of binaries) {
      await mkdir(dirname(binary), { recursive: true });
      await writeFile(binary, "#!/bin/sh\n");
      await chmod(binary, 0o755);
    }
    const report = await run([], {}, nested);
    expect(report.code).toBe(0);
    for (const binary of binaries) expect(report.stdout).toContain(binary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
