import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig, type FactoryConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { EventBus, globalBus } from "./events.js";
import { Store } from "./state/store.js";
import { ProjectStore } from "./state/projects.js";
import { JobQueue } from "./orchestrator/queue.js";
import { CopilotRuntime } from "./copilot/client.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { GateManager, globalGates, type GateResolution } from "./orchestrator/gates.js";
import { gitClone, readIssue } from "./tools/git.js";
import type { Run, StageName, Project, Job } from "./types.js";

/**
 * High-level facade wiring together config, state, the Copilot runtime, the
 * event bus and the orchestrator. Both the CLI and the web server construct one
 * of these (sharing the process-global bus + gate manager).
 */
export class Factory {
  readonly config: FactoryConfig;
  readonly log: Logger;
  readonly bus: EventBus;
  readonly gates: GateManager;
  readonly store: Store;
  readonly projects: ProjectStore;
  readonly queue: JobQueue;
  readonly runtime: CopilotRuntime;
  readonly orchestrator: Orchestrator;

  constructor(options: { bus?: EventBus; gates?: GateManager; config?: FactoryConfig } = {}) {
    this.config = options.config ?? loadConfig();
    this.log = createLogger("factory");
    this.bus = options.bus ?? globalBus;
    this.gates = options.gates ?? globalGates;
    mkdirSync(this.config.dataDir, { recursive: true });
    mkdirSync(this.config.workspacesDir, { recursive: true });
    this.store = new Store(this.config.dataDir);
    this.projects = new ProjectStore(this.config.dataDir);
    this.queue = new JobQueue(this.config.dataDir, { visibilityMs: this.config.jobVisibilityMs });
    this.runtime = new CopilotRuntime(this.config, this.log, this.bus);
    this.orchestrator = new Orchestrator(this.config, this.runtime, this.store, this.bus, this.gates, this.log);
  }

  /** Create a run and drive it to completion. */
  async build(idea: string, stackId?: string, referenceUrls?: string[], complianceProfiles?: string[], scale?: string, saas?: string[]): Promise<Run> {
    const run = this.orchestrator.createRun(idea, stackId, referenceUrls, complianceProfiles, scale, saas);
    try {
      return await this.orchestrator.execute(run);
    } finally {
      await this.runtime.stopAll();
    }
  }

  /** Start a run and return immediately (execution continues in background). */
  startBuild(idea: string, stackId?: string, referenceUrls?: string[], complianceProfiles?: string[], scale?: string, saas?: string[]): Run {
    const run = this.orchestrator.createRun(idea, stackId, referenceUrls, complianceProfiles, scale, saas);
    void this.orchestrator
      .execute(run)
      .catch((err) => this.log.error(`run ${run.id} crashed: ${String(err)}`))
      .finally(() => {
        /* runtime is stopped when the process exits for the server case */
      });
    return run;
  }

  /** Resume an interrupted run (completed stages are skipped). */
  async resume(runId: string): Promise<Run> {
    const run = this.store.loadRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    try {
      return await this.orchestrator.resume(run);
    } finally {
      await this.runtime.stopAll();
    }
  }

  /** Apply a follow-up change to an existing run and push it. */
  async iterate(runId: string, instruction: string): Promise<Run> {
    const run = this.store.loadRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    try {
      return await this.orchestrator.iterate(run, instruction);
    } finally {
      await this.runtime.stopAll();
    }
  }

  resolveGate(runId: string, stage: StageName, resolution: GateResolution): boolean {
    return this.gates.resolve(runId, stage, resolution);
  }

  listRuns(): Run[] {
    return this.store.listRuns();
  }

  getRun(id: string): Run | undefined {
    return this.store.loadRun(id);
  }

  /* --------------------------- day-2 operations --------------------------- */

  /**
   * Register a durable project pointing at a repo (persistent-project mode).
   * If a repoUrl is given it is cloned into a stable working directory.
   */
  async registerProject(opts: { name: string; stack?: string; repoUrl?: string; owner?: string }): Promise<Project> {
    const stack = opts.stack ?? this.config.stacks.default;
    const workingDir = resolve(this.config.workspacesDir, "projects", slug(opts.name));
    mkdirSync(resolve(this.config.workspacesDir, "projects"), { recursive: true });
    if (opts.repoUrl && !existsSync(resolve(workingDir, ".git"))) {
      await gitClone(opts.repoUrl, workingDir);
    } else {
      mkdirSync(workingDir, { recursive: true });
    }
    return this.projects.create({ name: opts.name, stack, workingDir, ...(opts.repoUrl ? { repoUrl: opts.repoUrl } : {}), ...(opts.owner ? { owner: opts.owner } : {}) });
  }

  /**
   * Operate on an existing repository or registered project: fix a bug, self-heal
   * from operational signals, or ship a feature. Lands via PR or push.
   */
  async operate(target: { projectId?: string; repoUrl?: string; workingDir?: string; stack?: string }, kind: "fix" | "heal" | "feature", task: string, opts: { prMode?: boolean; diagnosis?: string } = {}): Promise<Run> {
    let workingDir = target.workingDir;
    let stack = target.stack ?? this.config.stacks.default;
    let hasRemote = false;
    let projectId = target.projectId;

    if (target.projectId) {
      const project = this.projects.get(target.projectId);
      if (!project) throw new Error(`project ${target.projectId} not found`);
      workingDir = project.workingDir;
      stack = project.stack;
      hasRemote = Boolean(project.repoUrl);
    } else if (target.repoUrl) {
      workingDir = resolve(this.config.workspacesDir, "operate", slug(target.repoUrl) + "-" + Date.now().toString(36));
      await gitClone(target.repoUrl, workingDir);
      hasRemote = true;
    } else if (workingDir) {
      hasRemote = existsSync(resolve(workingDir, ".git"));
    } else {
      throw new Error("operate requires a projectId, repoUrl, or workingDir");
    }

    try {
      return await this.orchestrator.operate({
        workingDir: workingDir!,
        stack,
        kind,
        task,
        prMode: opts.prMode ?? this.config.prMode,
        hasRemote,
        ...(opts.diagnosis ? { diagnosis: opts.diagnosis } : {}),
        ...(projectId ? { projectId } : {}),
      });
    } finally {
      await this.runtime.stopAll();
    }
  }

  /** Bug intake from a GitHub issue → reproduce → fix → PR. */
  async fixIssue(repo: string, issueNumber: number, opts: { prMode?: boolean } = {}): Promise<Run> {
    const issue = await readIssue(repo, issueNumber);
    const task = `${issue.title}\n\n${issue.body}`.slice(0, 4000);
    return this.operate({ repoUrl: repo }, "fix", task, { prMode: opts.prMode ?? true });
  }

  /** Estimate an idea's effort/cost/timeline without building. */
  async estimate(idea: string, stackId?: string): Promise<{ run: Run; estimate: unknown }> {
    try {
      return await this.orchestrator.estimate(idea, stackId);
    } finally {
      await this.runtime.stopAll();
    }
  }

  /** Plan and ship a sprint of top backlog items as parallel squads. */
  async sprint(projectId: string, opts: { max?: number; prMode?: boolean } = {}): Promise<{ plan: unknown; runs: Run[] }> {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`project ${projectId} not found`);
    const todo = project.backlog.filter((b) => b.status === "todo").slice(0, opts.max ?? this.config.maxParallel);
    if (todo.length === 0) return { plan: { goal: "backlog empty" }, runs: [] };
    const { plan } = await this.orchestrator.sprintPlan(project.name, todo.map((t) => ({ id: t.id, title: t.title })), project.workingDir);
    const runs: Run[] = [];
    try {
      // Ship items against the project's repo. PR-per-item by DEFAULT so a
      // mid-sprint failure never leaves the shared repo half-broken on main.
      const prPerItem = opts.prMode ?? true;
      for (const item of todo) {
        this.projects.setItemStatus(projectId, item.id, "in-progress");
        const run = await this.orchestrator.operate({
          workingDir: project.workingDir,
          stack: project.stack,
          kind: "feature",
          task: item.title,
          prMode: prPerItem,
          hasRemote: Boolean(project.repoUrl),
          projectId,
        });
        runs.push(run);
        this.projects.setItemStatus(projectId, item.id, run.status === "completed" ? "done" : "todo");
      }
    } finally {
      await this.runtime.stopAll();
    }
    return { plan, runs };
  }

  /* ------------------------------- queue ---------------------------------- */

  /** Enqueue a job for a worker to process (platform / horizontal scale). */
  enqueue(kind: Job["kind"], payload: Record<string, unknown>): Job {
    return this.queue.enqueue(kind, payload);
  }

  /** Process a single claimed job. Returns the job or undefined if none queued. */
  async processNextJob(): Promise<Job | undefined> {
    const job = this.queue.claim();
    if (!job) return undefined;
    // Keep the lease alive while this (potentially long) job runs so another
    // worker doesn't reclaim it; a crash stops the heartbeat and it's reclaimed.
    const beat = setInterval(() => this.queue.heartbeat(job.id), Math.max(30_000, Math.floor(this.config.jobVisibilityMs / 3)));
    try {
      let runId: string | undefined;
      if (job.kind === "build") {
        const p = job.payload as { idea: string; stack?: string; references?: string[]; compliance?: string[]; scale?: string; saas?: string[] };
        const run = await this.build(p.idea, p.stack, p.references, p.compliance, p.scale, p.saas);
        runId = run.id;
      } else if (job.kind === "fix" || job.kind === "operate") {
        const p = job.payload as { projectId?: string; repoUrl?: string; workingDir?: string; kind?: "fix" | "heal" | "feature"; task: string; prMode?: boolean };
        const run = await this.operate({ ...(p.projectId ? { projectId: p.projectId } : {}), ...(p.repoUrl ? { repoUrl: p.repoUrl } : {}), ...(p.workingDir ? { workingDir: p.workingDir } : {}) }, p.kind ?? "fix", p.task, { ...(p.prMode !== undefined ? { prMode: p.prMode } : {}) });
        runId = run.id;
      } else if (job.kind === "sprint") {
        const p = job.payload as { projectId: string; max?: number };
        const { runs } = await this.sprint(p.projectId, { ...(p.max ? { max: p.max } : {}) });
        runId = runs[runs.length - 1]?.id;
      }
      this.queue.update(job.id, { status: "done", finishedAt: new Date().toISOString(), ...(runId ? { runId } : {}) });
    } catch (err) {
      this.queue.update(job.id, { status: "failed", finishedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) });
    } finally {
      clearInterval(beat);
    }
    return this.queue.get(job.id);
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "project";
}
