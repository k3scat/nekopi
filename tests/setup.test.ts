import { describe, expect, test } from "bun:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { environmentChecks, meetsFloor, nodeFloor, ready, renderChecks,
  type Check } from "../src/setup.ts";

describe("setup", () => {
  test("the Node floor comes from the manifest and compares by component", () => {
    expect(nodeFloor()).toEqual([22, 19, 0]);
    expect(nodeFloor(">= 24.0.0")).toEqual([24, 0, 0]);
    // A range nekopi does not model must not be read as a floor of zero.
    expect(nodeFloor("^22.19.0")).toBeUndefined();
    expect(nodeFloor("22.19.0 || 24")).toBeUndefined();
  });

  test("a version at the floor passes and a lower component fails", () => {
    const floor: [number, number, number] = [22, 19, 0];
    for (const version of ["22.19.0", "22.19.1", "22.20.0", "24.15.0", "100.0.0"]) {
      expect(meetsFloor(version, floor)).toBe(true);
    }
    // 22.9 is below 22.19: a string or major-only comparison gets this wrong.
    for (const version of ["22.18.9", "22.9.0", "21.99.99", "20.0.0"]) {
      expect(meetsFloor(version, floor)).toBe(false);
    }
  });

  test("readiness ignores warnings and reports only failures", () => {
    const base: Check = { name: "x", status: "ok", detail: "d" };
    expect(ready([base, { ...base, status: "warn" }])).toBe(true);
    expect(ready([base, { ...base, status: "fail" }])).toBe(false);
    expect(ready([])).toBe(true);
  });

  test("a check renders its fix only when it has one", () => {
    const rendered = renderChecks([
      { name: "ripgrep", status: "fail", detail: "not found", fix: "install ripgrep" },
      { name: "nek", status: "ok", detail: "/bin/nek" },
    ]);
    expect(rendered).toContain("FAIL");
    expect(rendered).toContain("install ripgrep");
    expect(rendered).toContain("1 check(s) failed.");
    expect(rendered.split("\n").filter(line => line.includes("/bin/nek"))).toHaveLength(1);
    expect(renderChecks([{ name: "nek", status: "ok", detail: "ok" }])).toContain("Ready.");
  });

  test("the checks run against this checkout and name every subsystem", async () => {
    const checks = await environmentChecks(process.cwd(), getAgentDir());
    expect(checks.map(check => check.name)).toEqual(
      ["versions", "node", "nek", "ripgrep", "grammars", "settings", "servers"]);
    // This checkout is built and its grammars install with the package.
    const byName = new Map(checks.map(check => [check.name, check]));
    expect(byName.get("node")!.status).toBe("ok");
    expect(byName.get("grammars")!.detail).toBe("tree-sitter loaded");
    expect(byName.get("nek")!.detail).toContain("bin/nek");
  });
});
