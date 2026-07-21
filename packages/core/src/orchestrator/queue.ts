import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Job, JobKind, JobStatus } from "../types.js";

/**
 * A persistent, file-backed job queue that lets the factory run as a platform:
 * builds/operate tasks are enqueued and drained by one or more workers, giving
 * horizontal scale (run `factory worker` in N terminals or containers).
 */
export class JobQueue {
  private readonly dir: string;
  private readonly visibilityMs: number;
  private readonly maxAttempts: number;

  constructor(dataDir: string, opts: { visibilityMs?: number; maxAttempts?: number } = {}) {
    this.dir = resolve(dataDir, "jobs");
    this.visibilityMs = opts.visibilityMs ?? 1_800_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    mkdirSync(this.dir, { recursive: true });
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private write(job: Job): void {
    const p = this.path(job.id);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(job, null, 2), "utf8");
    renameSync(tmp, p);
  }

  enqueue(kind: JobKind, payload: Record<string, unknown>): Job {
    const job: Job = {
      id: randomUUID().slice(0, 8),
      kind,
      status: "queued",
      payload,
      createdAt: new Date().toISOString(),
    };
    this.write(job);
    return job;
  }

  get(id: string): Job | undefined {
    const p = this.path(id);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf8")) as Job;
  }

  list(status?: JobStatus): Job[] {
    if (!existsSync(this.dir)) return [];
    const out: Job[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
      try {
        const job = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Job;
        if (!status || job.status === status) out.push(job);
      } catch {
        /* skip */
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  update(id: string, patch: Partial<Job>): Job | undefined {
    const job = this.get(id);
    if (!job) return undefined;
    Object.assign(job, patch);
    this.write(job);
    return job;
  }

  /**
   * Atomically claim the oldest queued job. Uses a rename-based lock so
   * multiple workers on the same host don't grab the same job.
   */
  claim(): Job | undefined {
    // First, reclaim any jobs whose lease has expired (crashed/stalled workers).
    this.reclaimStale();
    for (const job of this.list("queued")) {
      const src = this.path(job.id);
      const lock = `${src}.lock`;
      try {
        renameSync(src, lock);
      } catch {
        continue; // another worker won the race
      }
      const now = Date.now();
      job.status = "running";
      job.startedAt = new Date().toISOString();
      job.heartbeatAt = now;
      job.leaseUntil = now + this.visibilityMs;
      job.attempts = (job.attempts ?? 0) + 1;
      // Write the running state back to the canonical path and drop the lock.
      writeFileSync(src, JSON.stringify(job, null, 2), "utf8");
      try {
        rmSync(lock, { force: true });
      } catch {
        /* lock already gone */
      }
      return job;
    }
    return undefined;
  }

  /** Extend the lease on a running job (call periodically while processing). */
  heartbeat(id: string): void {
    const job = this.get(id);
    if (!job || job.status !== "running") return;
    job.heartbeatAt = Date.now();
    job.leaseUntil = Date.now() + this.visibilityMs;
    this.write(job);
  }

  /**
   * Requeue jobs whose lease has expired (a worker crashed mid-processing), or
   * fail them permanently once they exhaust their attempt budget. Returns the
   * number of jobs affected.
   */
  reclaimStale(): number {
    const now = Date.now();
    let affected = 0;
    for (const job of this.list("running")) {
      if ((job.leaseUntil ?? 0) > now) continue;
      affected++;
      if ((job.attempts ?? 0) >= this.maxAttempts) {
        this.update(job.id, { status: "failed", finishedAt: new Date().toISOString(), error: `lease expired after ${job.attempts} attempt(s)` });
      } else {
        this.update(job.id, { status: "queued", leaseUntil: undefined as unknown as number, heartbeatAt: undefined as unknown as number });
      }
    }
    return affected;
  }
}
