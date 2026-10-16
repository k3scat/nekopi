import { afterEach, expect, test } from "bun:test";
import { ImageJobs, MAX_IMAGE_JOBS, type ImageJob } from "../src/tools/image-jobs.ts";

const managers: ImageJobs[] = [];
afterEach(() => { for (const jobs of managers.splice(0)) jobs.dispose(); });
const tick = () => Bun.sleep(0);
function manager() {
  const notices: ImageJob[] = [];
  const jobs = new ImageJobs(job => notices.push(job));
  managers.push(jobs);
  return { jobs, notices };
}
function id(text: string): string { return /Started image job (image-[\w-]+)/u.exec(text)![1]!; }

test("image submission is immediate, status retains completion, and notification happens once", async () => {
  const { jobs, notices } = manager();
  let finish!: (text: string) => void;
  const job = id(jobs.start({ prompt: "cat", out: "cat.png" }, "/workspace",
    () => new Promise(resolve => { finish = resolve; })));
  expect(jobs.status(job)).toContain("running");
  expect(notices).toEqual([]);
  await tick();
  finish("Wrote cat.png, 16x16, 100 bytes.");
  await tick();
  expect(jobs.status(job)).toContain("completed. Wrote cat.png");
  expect(notices).toEqual([{ id: job, out: "cat.png", status: "completed", result: "Wrote cat.png, 16x16, 100 bytes." }]);
  jobs.status(job); jobs.cancel(job);
  expect(notices).toHaveLength(1);
});

test("failed jobs retain a retrievable failure and notify without unhandled rejections", async () => {
  const { jobs, notices } = manager();
  const job = id(jobs.start({ prompt: "cat", out: "cat.png" }, "/workspace", async () => { throw new Error("provider returned 429"); }));
  await tick();
  expect(jobs.status(job)).toContain("failed. provider returned 429");
  expect(notices).toHaveLength(1);
});

test("cancel aborts the request, does not notify again, and cannot access another session", async () => {
  const { jobs, notices } = manager();
  const other = manager().jobs;
  let signal!: AbortSignal;
  let finish!: (text: string) => void;
  const job = id(jobs.start({ prompt: "cat", out: "cat.png" }, "/workspace", value => {
    signal = value;
    return new Promise(resolve => { finish = resolve; });
  }));
  await tick();
  expect(other.status(job)).toContain("Unknown image job");
  expect(other.cancel(job)).toContain("Unknown image job");
  expect(signal.aborted).toBe(false);
  expect(jobs.cancel(job)).toContain("cancelled");
  expect(signal.aborted).toBe(true);
  finish("Late response must not change cancellation");
  await tick();
  expect(jobs.status(job)).not.toContain("Late response");
  expect(notices).toEqual([]);
});

test("session disposal aborts jobs and suppresses late completions", async () => {
  const { jobs, notices } = manager();
  let signal!: AbortSignal;
  let finish!: (text: string) => void;
  const job = id(jobs.start({ prompt: "cat", out: "cat.png" }, "/workspace", value => {
    signal = value;
    return new Promise(resolve => { finish = resolve; });
  }));
  await tick();
  jobs.dispose();
  expect(signal.aborted).toBe(true);
  finish("Late completion");
  await tick();
  expect(notices).toEqual([]);
  expect(jobs.status(job)).toContain("Unknown image job");
  expect(() => jobs.start({ prompt: "cat", out: "other.png" }, "/workspace", async () => "no"))
    .toThrow("closed");
});

test("bounded concurrency includes cancelled requests still unwinding and reserves output paths", async () => {
  const { jobs } = manager();
  const pending = () => new Promise<string>(() => {});
  const first = id(jobs.start({ prompt: "cat", out: "cat.png" }, "/workspace", pending));
  expect(() => jobs.start({ prompt: "cat", out: "./cat.png" }, "/workspace", pending)).toThrow("active job for that output");
  for (let i = 1; i < MAX_IMAGE_JOBS; i++) jobs.start({ prompt: "cat", out: `${i}.png` }, "/workspace", pending);
  expect(() => jobs.start({ prompt: "cat", out: "excess.png" }, "/workspace", pending)).toThrow("4 active jobs");
  jobs.cancel(first);
  expect(() => jobs.start({ prompt: "cat", out: "excess.png" }, "/workspace", pending)).toThrow("4 active jobs");
});

test("history is bounded without evicting a pending job", async () => {
  const { jobs } = manager();
  const running = id(jobs.start({ prompt: "cat", out: "running.png" }, "/workspace", () => new Promise(() => {})));
  let oldest = "", latest = "";
  for (let i = 0; i < 36; i++) {
    latest = id(jobs.start({ prompt: "cat", out: `${i}.png` }, "/workspace", async () => "Saved"));
    oldest ||= latest;
    await tick();
  }
  expect(jobs.status(oldest)).toContain("Unknown image job");
  expect(jobs.status(latest)).toContain("completed");
  expect(jobs.status(running)).toContain("running");
});

test("notification failure does not erase the saved result", async () => {
  const jobs = new ImageJobs(() => { throw new Error("delivery unavailable"); });
  managers.push(jobs);
  const job = id(jobs.start({ prompt: "cat", out: "cat.png" }, "/workspace", async () => "Wrote cat.png"));
  await tick();
  expect(jobs.status(job)).toContain("completed. Wrote cat.png");
  expect(jobs.status(job)).toContain("notification failed");
});
