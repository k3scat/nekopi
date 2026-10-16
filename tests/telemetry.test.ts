import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { createTelemetry, MAX_PENDING_RECORDS, MAX_TELEMETRY_BYTES, type TelemetryRecord } from "../src/telemetry.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nekopi-telemetry-"));
  directories.push(directory);
  return directory;
}

const usage: Usage = {
  input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cacheWrite1h: 2, reasoning: 20, totalTokens: 165,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
};

function tool(callId: string): Extract<TelemetryRecord, { type: "tool" }> {
  return { type: "tool", tool: "read", callId, durationMs: 12, isError: false, outputBytes: 100 };
}

describe("factual telemetry", () => {
  test("projects only allowed metadata, accounts actual usage, and protects files", async () => {
    const directory = join(await temporary(), "logs");
    const telemetry = createTelemetry({ directory, sessionId: "session", enabled: true });
    const secret = "SECRET_PROMPT_AND_API_KEY";
    await telemetry.record({ type: "session_start", prompt: secret } as TelemetryRecord);
    await telemetry.record({ ...tool("call"), parentId: "parent", args: { path: secret }, result: secret } as TelemetryRecord);
    await telemetry.record({
      type: "usage", provider: "provider", model: "model", credential: secret,
      usage: { ...usage, prompt: secret, cost: { ...usage.cost, credential: secret } },
    } as TelemetryRecord);
    await telemetry.record({ type: "session_end" });
    await telemetry.close();

    const snapshot = telemetry.snapshot();
    expect(snapshot).toMatchObject({ recordsWritten: 4, recordsDropped: 0, toolCalls: 1, modelCalls: 1, totalOutputBytes: 100, usage });
    expect(snapshot.recording).toBe(false);
    expect(snapshot.filePath).toBeDefined();
    const content = await readFile(snapshot.filePath!, "utf8");
    expect(content).not.toContain(secret);
    expect(content).not.toContain(directory);
    const records = content.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.type)).toEqual(["session_start", "tool", "usage", "session_end"]);
    expect(records[1].parentId).toBe("parent");
    expect(records[2].usage.cost).toEqual(usage.cost);
    expect(snapshot.bytesWritten).toBe(Buffer.byteLength(content));
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(snapshot.filePath!)).mode & 0o777).toBe(0o600);
    }
    snapshot.usage.input = 999;
    expect(telemetry.snapshot().usage.input).toBe(100);
  });

  test("serializes concurrent calls and flushes pending writes on close", async () => {
    const directory = await temporary();
    const telemetry = createTelemetry({ directory, sessionId: "session", enabled: true });
    const writes = Array.from({ length: 25 }, (_, index) => telemetry.record(tool(String(index))));
    await telemetry.close();
    await Promise.all(writes);
    await telemetry.close();
    const lines = (await readFile(telemetry.snapshot().filePath!, "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).callId)).toEqual(Array.from({ length: 25 }, (_, index) => String(index)));
    expect(telemetry.snapshot().totalToolDurationMs).toBe(300);
    await telemetry.record(tool("after-close"));
    expect(telemetry.snapshot().recordsWritten).toBe(25);
  });

  test("separates outer inspection traffic from nested evidence copied into its result", async () => {
    const telemetry = createTelemetry({ directory: await temporary(), sessionId: "session", enabled: true });
    await telemetry.record({ ...tool("inspect/1"), parentId: "inspect", outputBytes: 100 });
    await telemetry.record({ ...tool("inspect/2"), parentId: "inspect", outputBytes: 200 });
    await telemetry.record({ ...tool("inspect"), tool: "inspect", outputBytes: 340 });
    await telemetry.close();
    expect(telemetry.snapshot()).toMatchObject({ toolCalls: 3, outerToolCalls: 1, nestedToolCalls: 2,
      totalOutputBytes: 640, outerOutputBytes: 340, nestedOutputBytes: 300, totalToolDurationMs: 36 });
  });

  test("records aggregate model call counts without multiplying reported usage", async () => {
    const directory = await temporary();
    const telemetry = createTelemetry({ directory, sessionId: "session", enabled: true });
    const record = { type: "usage", provider: "provider", model: "model", usage } as const;
    await telemetry.record({ ...record, calls: 3 });
    expect(telemetry.snapshot()).toMatchObject({ modelCalls: 3, usage });
    await telemetry.record({ ...record, calls: -1 });
    await telemetry.record({ ...record, calls: 0.5 });
    await telemetry.record(record);
    await telemetry.close();
    expect(telemetry.snapshot()).toMatchObject({ modelCalls: 4, recordsWritten: 2, recordsDropped: 2 });
    expect(telemetry.snapshot().usage.input).toBe(200);
    const lines = (await readFile(telemetry.snapshot().filePath!, "utf8")).trim().split("\n");
    expect(JSON.parse(lines[0]!).calls).toBe(3);
  });

  test("bounds concurrent buffering, tracks drops, and isolates diagnostics", async () => {
    const directory = await temporary();
    let errors = 0;
    const telemetry = createTelemetry({ directory, sessionId: "session", enabled: true, onError() { errors += 1; throw new Error("diagnostic failed"); } });
    await Promise.all(Array.from({ length: MAX_PENDING_RECORDS + 3 }, (_, index) => telemetry.record(tool(String(index)))));
    await telemetry.close();
    expect(telemetry.snapshot()).toMatchObject({ recordsWritten: MAX_PENDING_RECORDS, recordsDropped: 3, toolCalls: MAX_PENDING_RECORDS + 3 });
    expect(errors).toBe(1);
  });

  test("partial worker usage retains counters and makes aggregate completeness sticky", async () => {
    const telemetry = createTelemetry({ directory: await temporary(), sessionId: "session", enabled: true });
    const record = { type: "usage", provider: "provider", model: "model", usage } as const;
    await telemetry.record({ ...record, usageReported: true });
    expect(telemetry.snapshot().usageReported).toBe(true);
    await telemetry.record({ ...record, usageReported: false, calls: 2 });
    await telemetry.record({ ...record, usageReported: true });
    await telemetry.close();
    expect(telemetry.snapshot()).toMatchObject({ usageReported: false, modelCalls: 4, usage: { totalTokens: usage.totalTokens * 3 } });
    const records = (await readFile(telemetry.snapshot().filePath!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records.map(record => record.usageReported)).toEqual([true, false, true]);
  });

  test("a filesystem failure stops logging without losing in-memory totals", async () => {
    const directory = join(await temporary(), "not-a-directory");
    await writeFile(directory, "occupied");
    const errors: Error[] = [];
    const telemetry = createTelemetry({ directory, sessionId: "session", enabled: true, onError: (error) => { errors.push(error); } });
    await telemetry.record(tool("first"));
    await telemetry.record({ ...tool("second"), isError: true } as TelemetryRecord);
    await telemetry.close();
    expect(telemetry.snapshot()).toMatchObject({ recording: false, recordsWritten: 0, recordsDropped: 2, toolCalls: 2, toolErrors: 1 });
    expect(telemetry.snapshot().filePath).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).not.toContain(directory);
  });

  test("stops a run at its disk limit while retaining aggregate statistics", async () => {
    const directory = await temporary();
    const label = "漢".repeat(256);
    let errors = 0;
    const telemetry = createTelemetry({ directory, sessionId: label, enabled: true, onError() { errors += 1; } });
    const record: TelemetryRecord = { ...tool(label), tool: label, parentId: label };
    for (let batch = 0; batch < 100 && telemetry.snapshot().recording; batch += 1) {
      await Promise.all(Array.from({ length: 100 }, () => telemetry.record(record)));
    }
    expect(telemetry.snapshot().recording).toBe(false);
    expect(telemetry.snapshot().recordsDropped).toBeGreaterThan(0);
    const previousCalls = telemetry.snapshot().toolCalls;
    await telemetry.record(tool("after-limit"));
    await telemetry.close();
    expect(telemetry.snapshot().toolCalls).toBe(previousCalls + 1);
    expect((await stat(telemetry.snapshot().filePath!)).size).toBeLessThanOrEqual(MAX_TELEMETRY_BYTES);
    expect(errors).toBe(1);
  });

  test("writes no file when disabled but still counts, bounds metadata, and separates runs", async () => {
    const directory = await temporary();
    const disabled = createTelemetry({ directory, sessionId: "disabled", enabled: false });
    await disabled.record(tool("call"));
    await disabled.close();
    expect(await readdir(directory)).toEqual([]);
    // Counters are in memory, so tool adoption is visible with no setup. Only
    // the file is optional.
    expect(disabled.snapshot()).toMatchObject({ enabled: false, recording: false, toolCalls: 1 });
    expect(disabled.snapshot().tools).toEqual({ read: { calls: 1, errors: 0, durationMs: 12, outputBytes: 100 } });

    const options = { directory, sessionId: "x".repeat(20_000), enabled: true };
    const first = createTelemetry(options);
    const second = createTelemetry(options);
    await first.record(tool("y".repeat(20_000)));
    await second.record({ type: "session_start" });
    await Promise.all([first.close(), second.close()]);
    expect(first.snapshot().filePath).not.toBe(second.snapshot().filePath);
    const record = JSON.parse(await readFile(first.snapshot().filePath!, "utf8"));
    expect(record.sessionId).toHaveLength(256);
    expect(record.callId).toHaveLength(256);
  });

  test("rejects invalid runtime amounts without recording sensitive error data", async () => {
    const directory = await temporary();
    const telemetry = createTelemetry({ directory, sessionId: "session", enabled: true });
    await telemetry.record({ ...tool("bad"), durationMs: Number.NaN } as TelemetryRecord);
    await telemetry.record({ type: "unknown", prompt: "secret" } as unknown as TelemetryRecord);
    await telemetry.close();
    expect(telemetry.snapshot()).toMatchObject({ recordsDropped: 2, recordsWritten: 0, toolCalls: 0 });
    expect(await readdir(directory)).toEqual([]);
  });
});
