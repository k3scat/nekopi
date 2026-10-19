import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "nekopi-config-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "repo");
  await Promise.all([mkdir(agentDir), mkdir(path.join(cwd, ".pi"), { recursive: true })]);
  return { agentDir, cwd };
}

test("only trusted project configuration overrides user values, with origins", async () => {
  const dirs = await fixture();
  await writeFile(path.join(dirs.agentDir, "nekopi.json"), JSON.stringify({ telemetry: { enabled: true } }));
  await writeFile(path.join(dirs.cwd, ".pi/nekopi.json"), JSON.stringify({ telemetry: { enabled: false } }));
  const untrusted = await loadConfig({ ...dirs, trustedProject: false });
  expect(untrusted.config.telemetry.enabled).toBe(true);
  expect(untrusted.sources.project.status).toBe("untrusted");
  const trusted = await loadConfig({ ...dirs, trustedProject: true });
  expect(trusted.config.telemetry.enabled).toBe(false);
  expect(trusted.origins["telemetry.enabled"]).toBe("project");
  expect(trusted.origins["diagnostics.enabled"]).toBe("default");
});

test("invalid untrusted project data is never parsed", async () => {
  const dirs = await fixture();
  await writeFile(path.join(dirs.cwd, ".pi/nekopi.json"), "broken JSON");
  expect((await loadConfig({ ...dirs, trustedProject: false })).config.telemetry.enabled).toBe(false);
  await expect(loadConfig({ ...dirs, trustedProject: true })).rejects.toThrow("invalid JSON");
});

for (const [section, seconds] of [["web", 300], ["image", 180]] as const) {
  test(`${section} timeout defaults and partial overrides follow project trust with origins`, async () => {
    const dirs = await fixture();
    const defaults = await loadConfig({ ...dirs, trustedProject: false });
    expect(defaults.config[section]).toEqual({ enabled: false, timeoutSeconds: seconds });
    expect(defaults.origins[`${section}.timeoutSeconds`]).toBe("default");
    await writeFile(path.join(dirs.agentDir, "nekopi.json"),
      JSON.stringify({ [section]: { enabled: true, timeoutSeconds: 600 } }));
    await writeFile(path.join(dirs.cwd, ".pi/nekopi.json"),
      JSON.stringify({ [section]: { timeoutSeconds: 900 } }));
    const untrusted = await loadConfig({ ...dirs, trustedProject: false });
    expect(untrusted.config[section]).toEqual({ enabled: true, timeoutSeconds: 600 });
    expect(untrusted.origins[`${section}.timeoutSeconds`]).toBe("user");
    const trusted = await loadConfig({ ...dirs, trustedProject: true });
    expect(trusted.config[section]).toEqual({ enabled: true, timeoutSeconds: 900 });
    expect(trusted.origins[`${section}.timeoutSeconds`]).toBe("project");
    expect(trusted.origins[`${section}.enabled`]).toBe("user");
  });

  test(`${section} timeout rejects invalid values and accepts timer boundaries`, async () => {
    const dirs = await fixture();
    for (const timeoutSeconds of [0, -1, 0.5, "300", true, null, {}, [], 2147484, Infinity]) {
      await writeFile(path.join(dirs.agentDir, "nekopi.json"), JSON.stringify({ [section]: { timeoutSeconds } }));
      await expect(loadConfig({ ...dirs, trustedProject: true }))
        .rejects.toThrow(`${section}.timeoutSeconds' must be an integer`);
    }
    for (const timeoutSeconds of [1, 2147483]) {
      await writeFile(path.join(dirs.agentDir, "nekopi.json"), JSON.stringify({ [section]: { timeoutSeconds } }));
      expect((await loadConfig({ ...dirs, trustedProject: true })).config[section].timeoutSeconds).toBe(timeoutSeconds);
    }
  });
}

test("rejects typos, invalid limits and prototype keys without coercion", async () => {
  const dirs = await fixture();
  for (const value of ['{"diagnostic":{}}', '{"__proto__":{}}', '{"diagnostics":{"enabled":"true"}}',
    '{"telemetry":{"enabled":1}}', '{"languageServers":{"enabled":"yes"}}']) {
    await writeFile(path.join(dirs.agentDir, "nekopi.json"), value);
    await expect(loadConfig({ ...dirs, trustedProject: true })).rejects.toThrow();
  }
});

// The semantic layer is permitted by default and asked nothing by default.
// Diagnostics and telemetry stay off.
for (const [section, expected] of [["diagnostics", false], ["telemetry", false], ["languageServers", true]] as const) {
  test(`${section} follows project trust and reports configuration origins`, async () => {
    const dirs = await fixture();
    expect((await loadConfig({ ...dirs, trustedProject: false })).config[section].enabled).toBe(expected);
    await writeFile(path.join(dirs.agentDir, "nekopi.json"), JSON.stringify({ [section]: { enabled: true } }));
    await writeFile(path.join(dirs.cwd, ".pi/nekopi.json"), JSON.stringify({ [section]: { enabled: false } }));
    const untrusted = await loadConfig({ ...dirs, trustedProject: false });
    expect(untrusted.config[section].enabled).toBe(true);
    expect(untrusted.origins[`${section}.enabled`]).toBe("user");
    const trusted = await loadConfig({ ...dirs, trustedProject: true });
    expect(trusted.config[section].enabled).toBe(false);
    expect(trusted.origins[`${section}.enabled`]).toBe("project");
  });
}

test("server overrides are validated field by field and only from a trusted layer", async () => {
  const dirs = await fixture();
  const servers = { go: { command: "/opt/gopls", args: ["-rpc.trace"], extensions: [".go", "go"],
    initializationOptions: { build: { directoryFilters: ["-vendor"] } }, rootMarkers: ["go.work"] } };
  await writeFile(path.join(dirs.cwd, ".pi/nekopi.json"), JSON.stringify({ languageServers: { servers } }));
  // An override names a binary, so an untrusted project never supplies one.
  expect((await loadConfig({ ...dirs, trustedProject: false })).config.languageServers.servers).toBeUndefined();
  const trusted = await loadConfig({ ...dirs, trustedProject: true });
  expect(trusted.config.languageServers.servers).toEqual({
    go: { command: "/opt/gopls", args: ["-rpc.trace"], extensions: ["go", "go"],
      initializationOptions: { build: { directoryFilters: ["-vendor"] } }, rootMarkers: ["go.work"] },
  });
  for (const invalid of [
    '{"languageServers":{"servers":[]}}',
    '{"languageServers":{"servers":{"go":{"command":""}}}}',
    '{"languageServers":{"servers":{"go":{"args":"-v"}}}}',
    '{"languageServers":{"servers":{"go":{"extensions":["../etc"]}}}}',
    '{"languageServers":{"servers":{"go":{"initializationOptions":"x"}}}}',
    '{"languageServers":{"servers":{"go":{"unknown":1}}}}',
    '{"languageServers":{"servers":{"Go!":{"command":"x"}}}}',
  ]) {
    await writeFile(path.join(dirs.agentDir, "nekopi.json"), invalid);
    await expect(loadConfig({ ...dirs, trustedProject: true })).rejects.toThrow();
  }
});

for (const [section, message] of [["sourceTools", "there is no mode to select"], ["delegation", "nekopi-lab"],
  ["codeIntelligence", "languageServers"], ["output", "delegation previews"]] as const) {
  test(`retired ${section} configuration gives an explicit migration error`, async () => {
    const dirs = await fixture();
    await writeFile(path.join(dirs.cwd, ".pi/nekopi.json"), JSON.stringify({ [section]: { enabled: true } }));
    await expect(loadConfig({ ...dirs, trustedProject: false })).resolves.toBeDefined();
    await expect(loadConfig({ ...dirs, trustedProject: true })).rejects.toThrow(message);
  });
}
