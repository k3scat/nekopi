import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ImageRequest } from "./image.ts";

export interface ImageJob {
  id: string;
  out: string;
  status: "running" | "completed" | "failed" | "cancelled";
  result?: string;
}

interface RunningJob extends ImageJob { controller: AbortController; destination: string }
export const MAX_IMAGE_JOBS = 4;
const MAX_HISTORY = 32;

export function describeImageJob(job: ImageJob): string {
  return `Image job ${job.id}: ${job.status}. ${job.result ?? `Output: ${JSON.stringify(job.out)}.`}`;
}

/** Session-owned job records only: no credential persistence, spool files or worker process. */
export class ImageJobs {
  private jobs = new Map<string, RunningJob>();
  private pending = new Set<RunningJob>();
  private closed = false;

  constructor(private notify: (job: ImageJob) => void) {}

  start(request: ImageRequest, cwd: string, run: (signal: AbortSignal) => Promise<string>): string {
    if (this.closed) throw new Error("image jobs are closed for this session.");
    if (this.pending.size >= MAX_IMAGE_JOBS) {
      throw new Error(`image has ${MAX_IMAGE_JOBS} active jobs. Wait for a completion before starting another.`);
    }
    const destination = resolve(cwd, request.out);
    if ([...this.pending].some(job => job.destination === destination)) {
      throw new Error("image already has an active job for that output path. Use a new path.");
    }
    // Pending jobs are never evicted, including cancelled requests still unwinding.
    if (this.jobs.size >= MAX_HISTORY) {
      const oldest = [...this.jobs.values()].find(job => !this.pending.has(job));
      if (oldest) this.jobs.delete(oldest.id);
    }
    const job: RunningJob = { id: `image-${randomUUID()}`, out: request.out, destination,
      status: "running", controller: new AbortController() };
    this.jobs.set(job.id, job);
    this.pending.add(job);
    void Promise.resolve().then(() => {
      job.controller.signal.throwIfAborted();
      return run(job.controller.signal);
    }).then(result => this.finish(job, "completed", result), error => {
      const message = error instanceof Error ? error.message : String(error);
      this.finish(job, "failed", message);
    }).finally(() => this.pending.delete(job));
    return `Started image job ${job.id} for ${JSON.stringify(job.out)}. Continue other work; completion or failure will arrive automatically. Check with \`nek image --status ${job.id}\`.`;
  }

  has(id: string): boolean {
    return this.jobs.has(id);
  }

  status(id: string): string {
    const job = this.jobs.get(id);
    return job ? describeImageJob(job) : `Unknown image job ${JSON.stringify(id)} in this session (only the latest ${MAX_HISTORY} are retained).`;
  }

  cancel(id: string): string {
    const job = this.jobs.get(id);
    if (job?.status === "running") {
      job.status = "cancelled";
      job.result = "Cancellation requested. Already written files are not deleted; provider usage may still count.";
      job.controller.abort();
    }
    return this.status(id);
  }

  dispose(): void {
    this.closed = true;
    for (const job of this.pending) job.controller.abort();
    this.jobs.clear();
  }

  private finish(job: RunningJob, status: "completed" | "failed", result: string): void {
    if (this.closed || job.status !== "running") return;
    job.status = status;
    job.result = result;
    // Do not expose the controller or paths used only for output reservations.
    try { this.notify({ id: job.id, out: job.out, status, result }); }
    catch { job.result += " Completion notification failed; retrieve this result with --status."; }
  }
}
