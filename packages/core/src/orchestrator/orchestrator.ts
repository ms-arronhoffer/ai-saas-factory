import { mkdirSync, existsSync, cpSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { FactoryConfig, StackDef } from "../config.js";
import { REPO_ROOT } from "../config.js";
import type { Logger } from "../logger.js";
import type { EventBus } from "../events.js";
import type { Store } from "../state/store.js";
import { MemoryStore } from "../state/memory.js";
import { EvalStore } from "../state/evals.js";
import type { AgentRuntime } from "../copilot/client.js";
import type {
  Run,
  Stage,
  StageName,
  Task,
  Workstream,
  RequirementsSpec,
  BuildPlan,
  ReferenceFeatureSet,
  WowFeature,
  ComplianceControl,
  ComplianceReport,
  VerifyReport,
  AcceptanceScore,
  AcceptanceSignals,
  DeployReport,
  CostReport,
  DiscoveryArtifacts,
  FactoryEvent,
} from "../types.js";
import { GateManager, type GateResolution } from "./gates.js";
import { mapLimit } from "./concurrency.js";
import { computeAcceptance } from "./acceptance.js";
import * as prompts from "../agents/prompts.js";
import { extractJson, slugify, mergeParity, dedupeFeatures, rankWow, estimateUsd } from "../agents/parse.js";
import { runScanners, evaluate } from "../tools/scanners.js";
import { runVerification } from "../tools/verify.js";
import { deployAndSmoke } from "../tools/deploy.js";
import { resolveRuntimes, runtimeKeysForStack } from "../tools/versions.js";
import { initAndCommit, commitAll, createRepoAndPush, pushCurrent, createBranch, openPullRequest, ensureGit, checkoutBranch, addWorktree, mergeBranch, abortMerge, removeWorktree, createRepoOnly, pushBranch } from "../tools/git.js";

const PIPELINE: StageName[] = ["discovery", "requirements", "architect", "build", "integrate", "test", "verify", "security", "delivery", "release"];

export class Orchestrator {
  private readonly memory: MemoryStore;
  private readonly evals: EvalStore;
  /** Task ids already reused during the current stage (task-level resume). */
  private readonly reusedTaskIds = new Set<string>();
  /** Wall-clock deadline per run id (ms epoch); set when execution starts. */
  private readonly deadlines = new Map<string, number>();

  constructor(
    private readonly config: FactoryConfig,
    private readonly runtime: AgentRuntime,
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly gates: GateManager,
    private readonly log: Logger,
  ) {
    this.memory = new MemoryStore(config.dataDir);
    this.evals = new EvalStore(config.dataDir);
  }

  /* ----------------------------- run lifecycle ---------------------------- */

  createRun(idea: string, stackId?: string, referenceUrls?: string[], complianceProfiles?: string[], scale?: string, saas?: string[]): Run {
    const id = randomUUID().slice(0, 8);
    const stack = stackId ?? this.config.stacks.default;
    const workingDir = resolve(this.config.workspacesDir, id);
    mkdirSync(workingDir, { recursive: true });

    // Golden seed: copy the stack's seed template into the workspace for a
    // deterministic starting point (agents refine it rather than start empty).
    const stackDef = this.config.stacks.stacks[stack];
    if (stackDef?.seed) {
      const seedDir = resolve(REPO_ROOT, stackDef.seed);
      if (existsSync(seedDir)) {
        try {
          cpSync(seedDir, workingDir, { recursive: true });
        } catch (err) {
          this.log.warn(`seed copy failed: ${String(err)}`);
        }
      }
    }

    const gates = this.config.gates.filter((g): g is StageName => (PIPELINE as string[]).includes(g));
    const refs = (referenceUrls ?? []).map((u) => u.trim()).filter(Boolean);
    const profiles = (complianceProfiles ?? this.config.complianceDefault)
      .map((p) => p.trim().toLowerCase())
      .filter((p) => this.config.compliance.profiles[p]);
    const scaleId = (scale ?? this.config.scaleDefault).toLowerCase();
    const resolvedScale = this.config.deployment.profiles[scaleId] ? scaleId : this.config.deployment.default;
    const saasSel = (saas ?? this.config.saasDefault).map((s) => s.trim().toLowerCase()).filter((s) => this.config.saas.capabilities[s]);
    // PR-first: when enabled, all generated code lives on a branch off an initial
    // scaffold commit so release can open a reviewable PR instead of pushing main.
    const branch = this.config.prMode ? "factory/build" : undefined;
    const run: Run = {
      id,
      idea,
      stack,
      status: "created",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workingDir,
      gates,
      scale: resolvedScale,
      mode: "build",
      ...(branch ? { branch } : {}),
      ...(refs.length ? { referenceUrls: refs } : {}),
      ...(profiles.length ? { complianceProfiles: profiles } : {}),
      ...(saasSel.length ? { saas: saasSel } : {}),
      stages: PIPELINE.map((name) => ({
        name,
        status: "pending",
        requiresApproval: gates.includes(name),
        tasks: [],
      })),
    };
    // Initialise git now so we have a scaffold baseline; branch for PR-first.
    this.store.saveRun(run);
    this.emit(run, { type: "run.created", message: `run ${id} created`, data: { idea, stack, referenceUrls: refs, complianceProfiles: profiles, scale: resolvedScale, saas: saasSel, prMode: this.config.prMode } });
    return run;
  }

  /** Init git in the workspace with a scaffold commit; branch for PR-first. */
  private async initWorkspaceGit(run: Run, branch: string | undefined): Promise<void> {
    try {
      await ensureGit(run.workingDir, "chore: scaffold — generated by AI SaaS Factory");
      if (branch) await checkoutBranch(run.workingDir, branch);
    } catch (err) {
      this.log.warn(`workspace git init failed: ${String(err)}`);
    }
  }

  private scaleProfile(run: Run) {
    return run.scale ? this.config.deployment.profiles[run.scale] : undefined;
  }

  /** Resolve the selected SaaS business-layer capabilities for a run, if any. */
  private saasFor(run: Run): { config: FactoryConfig["saas"]; selected: string[] } | undefined {
    const selected = (run.saas ?? []).filter((k) => this.config.saas.capabilities[k]);
    if (selected.length === 0) return undefined;
    return { config: this.config.saas, selected };
  }

  private emit(run: Run, partial: Omit<FactoryEvent, "runId" | "ts">): void {
    const event: FactoryEvent = { runId: run.id, ts: new Date().toISOString(), ...partial };
    this.store.appendAudit(event);
    this.bus.publish(event);
  }

  private setStatus(run: Run, status: Run["status"]): void {
    run.status = status;
    this.store.saveRun(run);
    this.emit(run, { type: "run.status", message: status });
  }

  private stage(run: Run, name: StageName): Stage {
    return run.stages.find((s) => s.name === name)!;
  }

  private stackDef(run: Run): StackDef {
    return this.config.stacks.stacks[run.stack] ?? this.config.stacks.stacks[this.config.stacks.default]!;
  }

  /** Drive the whole pipeline. Resolves when the run reaches a terminal state. */
  async execute(run: Run): Promise<Run> {
    this.setStatus(run, "running");
    if (this.config.maxRunSeconds > 0) this.deadlines.set(run.id, Date.now() + this.config.maxRunSeconds * 1000);
    try {
      await this.runtime.start(run.workingDir);

      // Establish the git baseline (scaffold commit + PR-first branch) before work.
      await this.initWorkspaceGit(run, run.branch);

      // Pre-flight budget gate: estimate cost up front and refuse to start if it
      // already blows the USD cap (cheap insurance against runaway builds).
      await this.preflight(run);

      // Each stage skips itself if already completed, so a run can be resumed
      // after a restart (see resume()).
      await this.stageDiscovery(run);
      await this.stageRequirements(run);
      await this.stageArchitect(run);
      await this.stageBuild(run);
      await this.stageIntegrate(run);
      await this.stageTest(run);
      if (this.config.verifyEnabled) await this.stageVerify(run);
      await this.stageSecurity(run);
      if (this.config.deliveryEnabled) await this.stageDelivery(run);
      await this.stageRelease(run);

      if ((run.cost?.totalTokens ?? 0) === 0 && (run.cost?.taskCount ?? 0) > 0) {
        this.emit(run, { type: "log", level: "error", message: "token usage read 0 across the whole run — cost/budget tracking was DISABLED (SDK usage shape drift?)" });
      }
      this.recordMemory(run);
      this.recordEval(run);
      this.setStatus(run, "completed");
      this.emit(run, { type: "run.done", message: "run completed", data: { repoUrl: run.repoUrl, acceptance: run.acceptance?.score } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "__CANCELLED__") {
        this.setStatus(run, "cancelled");
        this.emit(run, { type: "run.done", level: "warn", message: "run cancelled by user" });
      } else if (message === "__BUDGET__") {
        run.error = "budget exceeded";
        this.setStatus(run, "failed");
        this.emit(run, { type: "run.done", level: "error", message: "run aborted: budget exceeded" });
      } else {
        run.error = message;
        this.setStatus(run, "failed");
        this.emit(run, { type: "run.done", level: "error", message: `run failed: ${message}` });
        this.log.error(`run ${run.id} failed: ${message}`);
        if (process.env.FACTORY_TRACE && err instanceof Error && err.stack) this.log.error(err.stack);
      }
    }
    return run;
  }

  /** Pre-flight budget gate: estimate cost, gate on maxUsd before building. */
  private async preflight(run: Run): Promise<void> {
    const caps: string[] = [];
    if (this.config.maxUsd > 0) caps.push(`$${this.config.maxUsd}`);
    if (this.config.maxTokens > 0) caps.push(`${this.config.maxTokens} tok`);
    if (this.config.maxRunSeconds > 0) caps.push(`${this.config.maxRunSeconds}s`);
    if (caps.length) this.emit(run, { type: "log", message: `budget caps: ${caps.join(", ")}` });

    if (!this.config.preflightEstimate || this.config.maxUsd <= 0) return;
    try {
      const stack = this.stackDef(run);
      const res = await this.runtime.runAgent({
        runId: run.id,
        taskId: "preflight",
        stage: "discovery",
        role: "estimator",
        model: this.runtime.router.forRole("estimator").id,
        systemMessage: prompts.systemFor("estimator"),
        prompt: prompts.estimatePrompt(run.idea, stack.label),
        workingDir: run.workingDir,
        timeoutMs: 120_000,
      });
      this.accrueCost(run, "discovery", res.usage);
      const est = extractJson<{ costUsd?: { low?: number } }>(res.content);
      const low = est?.costUsd?.low;
      if (typeof low === "number" && low > this.config.maxUsd) {
        this.emit(run, { type: "log", level: "error", message: `preflight estimate $${low} exceeds cap $${this.config.maxUsd} — aborting before build` });
        throw new Error("__BUDGET__");
      }
      if (typeof low === "number") this.emit(run, { type: "log", message: `preflight estimate ~$${low} (cap $${this.config.maxUsd})` });
    } catch (err) {
      if (err instanceof Error && err.message === "__BUDGET__") throw err;
      /* preflight is best-effort; a failed estimate should not block the build */
    }
  }

  private recordMemory(run: Run): void {
    if (!run.requirements) return;
    const wow = (run.requirements.wowFeatures ?? []).filter((w) => (run.requirements!.wowSelected ?? []).includes(w.id)).map((w) => w.title);
    const note = [
      `## ${run.requirements.name} (run ${run.id}, ${run.createdAt.slice(0, 10)})`,
      `- Stack: ${run.stack}`,
      `- Summary: ${run.requirements.summary}`,
      wow.length ? `- Wow features shipped: ${wow.join("; ")}` : "",
      run.complianceProfiles?.length ? `- Compliance: ${run.complianceProfiles.join(", ")}` : "",
      run.acceptance ? `- Acceptance score: ${run.acceptance.score}/100` : "",
      run.repoUrl ? `- Repo: ${run.repoUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      this.memory.record(run.id, note);
    } catch {
      /* memory is best-effort */
    }
  }

  /** Append a scored row to the eval corpus and flag regressions vs baseline. */
  private recordEval(run: Run): void {
    const lastSec = run.security?.[(run.security?.length ?? 0) - 1];
    const sig = run.acceptance?.signals;
    const rec = {
      runId: run.id,
      ts: new Date().toISOString(),
      idea: run.idea.slice(0, 200),
      stack: run.stack,
      mode: run.mode ?? "build",
      status: run.status,
      ...(run.acceptance ? { acceptance: run.acceptance.score, deterministic: run.acceptance.deterministic ?? false } : {}),
      ...(lastSec ? { securityPassed: lastSec.passed } : {}),
      ...(run.verify ? { verifyBooted: run.verify.booted, verifyHealth: run.verify.healthOk } : {}),
      ...(run.verify?.testsPassed !== undefined ? { testsPassed: run.verify.testsPassed } : {}),
      ...(run.verify?.coveragePct !== undefined ? { coveragePct: run.verify.coveragePct } : {}),
      ...(run.verify?.mutationScore !== undefined ? { mutationScore: run.verify.mutationScore } : {}),
      ...(sig ? { scannersRan: sig.scannersRan } : {}),
      ...(run.deploy?.liveHealthOk !== undefined ? { liveHealthOk: run.deploy.liveHealthOk } : {}),
      ...(run.deploy?.dast ? { dastPassed: run.deploy.dast.passed } : {}),
      ...(run.cost ? { costUsd: run.cost.estimatedUsd, tokens: run.cost.totalTokens } : {}),
    };
    try {
      const check = this.evals.checkRegression(rec);
      this.evals.record(rec);
      if (check.regressed) {
        this.emit(run, { type: "log", level: "warn", message: `eval regression: ${check.reasons.join("; ")}`, data: check });
      }
    } catch {
      /* eval corpus is best-effort */
    }
  }

  /* ------------------------------- gates ---------------------------------- */

  private async gateIfNeeded(run: Run, stage: Stage): Promise<GateResolution | undefined> {
    if (!stage.requiresApproval) return undefined;
    stage.status = "awaiting_approval";
    this.setStatus(run, "awaiting_approval");
    this.store.saveRun(run);
    // Register the waiter BEFORE announcing the gate. The CLI printer handles
    // stage.awaiting_approval synchronously and, under --yes, resolves the gate
    // during the emit — so the waiter must already exist or the resolution is
    // lost and the run deadlocks. (GateManager also buffers as a backstop.)
    const resolutionPromise = this.gates.waitFor(run.id, stage.name);
    this.emit(run, { type: "stage.awaiting_approval", stage: stage.name, message: `awaiting approval: ${stage.name}` });
    const resolution = await resolutionPromise;
    this.emit(run, { type: "gate.resolved", stage: stage.name, message: `gate ${stage.name}: ${resolution.decision}` });
    if (resolution.decision === "reject") throw new Error("__CANCELLED__");
    this.setStatus(run, "running");
    return resolution;
  }

  /* ---------------------------- stage runners ----------------------------- */

  private beginStage(run: Run, name: StageName): Stage {
    const stage = this.stage(run, name);
    // Reset the per-stage reuse ledger so task-level resume matches within it.
    this.reusedTaskIds.clear();
    stage.status = "running";
    stage.startedAt = new Date().toISOString();
    run.currentStage = name;
    this.store.saveRun(run);
    this.emit(run, { type: "stage.start", stage: name, message: `stage ${name} started` });
    return stage;
  }

  private endStage(run: Run, stage: Stage, summary?: string): void {
    stage.status = "completed";
    stage.finishedAt = new Date().toISOString();
    if (summary) stage.summary = summary;
    this.store.saveRun(run);
    this.emit(run, { type: "stage.end", stage: stage.name, message: `stage ${stage.name} completed`, data: { summary } });
  }

  private newTask(run: Run, stage: Stage, partial: Omit<Task, "id" | "status">): Task {
    // Task-level resume: if this stage already has a COMPLETED task with the
    // same role+title (from a prior partial run), reuse it instead of re-paying
    // for expensive work already done.
    const prior = stage.tasks.find(
      (t) => t.status === "completed" && t.role === partial.role && t.title === partial.title && !this.reusedTaskIds.has(t.id),
    );
    if (prior) {
      this.reusedTaskIds.add(prior.id);
      this.emit(run, { type: "task.end", stage: stage.name, taskId: prior.id, message: `${prior.role} reused (resumed): ${prior.title}` });
      return prior;
    }
    const task: Task = { id: randomUUID().slice(0, 8), status: "pending", ...partial };
    stage.tasks.push(task);
    this.store.saveRun(run);
    return task;
  }

  private async runTask(run: Run, stage: Stage, task: Task, systemMessage: string, prompt: string, workingDir: string): Promise<string> {
    // Resumed/reused task: return its captured output without re-running.
    if (task.status === "completed" && task.summary !== undefined) {
      return task.summary;
    }
    // Wall-clock run budget: abort before starting another expensive turn.
    const deadline = this.deadlines.get(run.id);
    if (deadline && Date.now() > deadline) {
      this.emit(run, { type: "log", stage: stage.name, level: "error", message: `wall-clock budget exceeded (${this.config.maxRunSeconds}s)` });
      throw new Error("__BUDGET__");
    }
    const model = this.runtime.router.forRole(task.role);
    task.model = model.id;
    task.status = "running";
    task.startedAt = new Date().toISOString();
    this.store.saveRun(run);
    this.emit(run, { type: "task.start", stage: stage.name, taskId: task.id, message: `${task.role}: ${task.title} [${model.id}]` });
    try {
      const result = await this.runtime.runAgent({
        runId: run.id,
        taskId: task.id,
        stage: stage.name,
        role: task.role,
        model: model.id,
        reasoningEffort: model.reasoningEffort,
        systemMessage,
        prompt,
        workingDir,
        timeoutMs: this.config.maxTaskSeconds > 0 ? this.config.maxTaskSeconds * 1000 : undefined,
      });
      task.status = "completed";
      task.finishedAt = new Date().toISOString();
      task.summary = result.content.slice(0, 4000);
      this.accrueCost(run, stage.name, result.usage);
      const taskTokens = result.usage.inputTokens + result.usage.outputTokens;
      if (this.config.maxTokensPerTask > 0 && taskTokens > this.config.maxTokensPerTask) {
        this.emit(run, { type: "log", stage: stage.name, taskId: task.id, level: "warn", message: `task exceeded per-task token ceiling: ${taskTokens} > ${this.config.maxTokensPerTask}` });
      }
      this.store.saveRun(run);
      this.emit(run, { type: "task.end", stage: stage.name, taskId: task.id, message: `${task.role} done (${result.toolCalls} tool calls)` });
      return result.content;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Self-improvement: escalate a failed task once to the deep model before
      // giving up (skip control-flow signals like cancel/budget).
      const deep = this.runtime.router.forTier("deep");
      const escalatable = this.config.escalateOnFailure && message !== "__CANCELLED__" && message !== "__BUDGET__" && model.id !== deep.id;
      if (escalatable) {
        this.emit(run, { type: "log", stage: stage.name, level: "warn", message: `${task.role} failed on ${model.id}; escalating to ${deep.id}` });
        try {
          const retry = await this.runtime.runAgent({
            runId: run.id,
            taskId: task.id,
            stage: stage.name,
            role: task.role,
            model: deep.id,
            reasoningEffort: deep.reasoningEffort,
            systemMessage,
            prompt,
            workingDir,
          });
          task.status = "completed";
          task.finishedAt = new Date().toISOString();
          task.model = deep.id;
          task.summary = retry.content.slice(0, 4000);
          this.accrueCost(run, stage.name, retry.usage);
          this.store.saveRun(run);
          this.emit(run, { type: "task.end", stage: stage.name, taskId: task.id, message: `${task.role} recovered on ${deep.id} (${retry.toolCalls} tool calls)` });
          return retry.content;
        } catch {
          /* fall through to failure below */
        }
      }
      task.status = "failed";
      task.finishedAt = new Date().toISOString();
      task.error = message;
      this.store.saveRun(run);
      this.emit(run, { type: "task.end", stage: stage.name, taskId: task.id, level: "error", message: `${task.role} failed: ${task.error}` });
      throw err;
    }
  }

  /** Accumulate token/cost usage and enforce the run budget. */
  private accrueCost(run: Run, stageName: StageName, usage: { inputTokens: number; outputTokens: number }): void {
    const cost: CostReport = run.cost ?? { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0, byStage: {}, taskCount: 0, overBudget: false };
    const tokens = usage.inputTokens + usage.outputTokens;
    cost.inputTokens += usage.inputTokens;
    cost.outputTokens += usage.outputTokens;
    cost.totalTokens += tokens;
    cost.taskCount += 1;
    cost.estimatedUsd = estimateUsd(cost.totalTokens, this.config.usdPerMillionTokens);
    const s = cost.byStage[stageName] ?? { tokens: 0, usd: 0 };
    s.tokens += tokens;
    s.usd = estimateUsd(s.tokens, this.config.usdPerMillionTokens);
    cost.byStage[stageName] = s;

    const overTokens = this.config.maxTokens > 0 && cost.totalTokens > this.config.maxTokens;
    const overUsd = this.config.maxUsd > 0 && cost.estimatedUsd > this.config.maxUsd;
    cost.overBudget = overTokens || overUsd;
    run.cost = cost;
    this.emit(run, { type: "cost.update", stage: stageName, message: `~$${cost.estimatedUsd.toFixed(3)} / ${cost.totalTokens} tok`, data: cost });
    if (cost.overBudget) {
      this.emit(run, { type: "log", stage: stageName, level: "error", message: `budget exceeded (tokens=${cost.totalTokens}, ~$${cost.estimatedUsd.toFixed(2)})` });
      throw new Error("__BUDGET__");
    }
  }

  /** True if a stage has already completed (used for resume()). */
  private done(run: Run, name: StageName): boolean {
    return this.stage(run, name).status === "completed";
  }

  private async stageDiscovery(run: Run): Promise<void> {
    if (this.done(run, "discovery")) return;
    const stage = this.beginStage(run, "discovery");
    if (!this.config.discoveryEnabled) {
      this.endStage(run, stage, "disabled");
      return;
    }
    const discovery: DiscoveryArtifacts = {};

    // 1. Domain expert research (primed with cross-run memory / RAG).
    const memoryDigest = this.memory.digest(4);
    const rTask = this.newTask(run, stage, { stage: "discovery", role: "researcher", title: "Domain research", workingDir: run.workingDir });
    const rContent = await this.runTask(run, stage, rTask, prompts.systemFor("researcher"), prompts.researcherPrompt(run.idea, this.stackDef(run).label, memoryDigest), run.workingDir);
    discovery.domain = extractJson<DiscoveryArtifacts["domain"]>(rContent) ?? undefined;

    // 2. Pain-point / jobs-to-be-done (mines reference apps for unmet needs).
    const pTask = this.newTask(run, stage, { stage: "discovery", role: "painfinder", title: "Pains & jobs-to-be-done", workingDir: run.workingDir });
    const pContent = await this.runTask(run, stage, pTask, prompts.systemFor("painfinder"), prompts.painFinderPrompt(run.idea, run.referenceUrls), run.workingDir);
    discovery.pains = extractJson<DiscoveryArtifacts["pains"]>(pContent) ?? undefined;

    // 3. Product-manager prioritisation (MoSCoW + MVP cut line + metrics).
    const mTask = this.newTask(run, stage, { stage: "discovery", role: "pm", title: "MVP prioritisation", workingDir: run.workingDir });
    const mContent = await this.runTask(run, stage, mTask, prompts.systemFor("pm"), prompts.pmPrompt(run.idea, discovery), run.workingDir);
    discovery.backlog = extractJson<DiscoveryArtifacts["backlog"]>(mContent) ?? undefined;

    run.discovery = discovery;
    this.store.saveRun(run);
    this.emit(run, {
      type: "discovery.report",
      stage: "discovery",
      message: `research: ${discovery.domain?.entities?.length ?? 0} entities · ${discovery.pains?.pains?.length ?? 0} pains · ${discovery.backlog?.must?.length ?? 0} MVP items`,
      data: discovery,
    });
    await commitAllSafe(run.workingDir);
    this.endStage(run, stage, discovery.backlog?.mvpCut?.slice(0, 120));
  }

  private async stageRequirements(run: Run): Promise<void> {
    if (this.done(run, "requirements")) return;
    const stage = this.beginStage(run, "requirements");
    const stack = this.stackDef(run);
    let notes: string | undefined;

    // Deterministically derive compliance controls from the selected profiles.
    const complianceControls: ComplianceControl[] = (run.complianceProfiles ?? []).flatMap((p) => {
      const profile = this.config.compliance.profiles[p];
      return (profile?.controls ?? []).map((c) => ({ ...c, profile: p }));
    });
    if (complianceControls.length) {
      this.emit(run, { type: "log", stage: "requirements", message: `applying ${complianceControls.length} compliance control(s) from: ${(run.complianceProfiles ?? []).join(", ")}` });
    }

    // Optional: analyse comparable apps to derive a feature-parity checklist.
    let parity: string[] = [];
    if (run.referenceUrls && run.referenceUrls.length > 0) {
      const analysisTask = this.newTask(run, stage, { stage: "requirements", role: "analyst", title: `Analyse ${run.referenceUrls.length} reference app(s)`, workingDir: run.workingDir });
      const analysisContent = await this.runTask(
        run,
        stage,
        analysisTask,
        prompts.systemFor("analyst"),
        prompts.referenceAnalysisPrompt(run.referenceUrls),
        run.workingDir,
      );
      const analysis = extractJson<{ sources?: ReferenceFeatureSet[]; featureParity?: string[] }>(analysisContent);
      const sources = analysis?.sources ?? [];
      parity = dedupeFeatures(analysis?.featureParity ?? sources.flatMap((s) => s.features ?? []));
      run.requirements = undefined;
      this.emit(run, { type: "log", stage: "requirements", message: `derived ${parity.length} parity capability(ies) from references` });
      // Stash on the run so it survives even before the spec exists.
      (run as Run & { _parity?: string[]; _refSources?: ReferenceFeatureSet[] })._parity = parity;
      (run as Run & { _refSources?: ReferenceFeatureSet[] })._refSources = sources;
      this.store.saveRun(run);
    }

    // Interrogate the (often vague) one-line idea into a precise brief with
    // explicit assumptions, so builders target the true end-state instead of
    // silently guessing. Under --yes it self-answers and records the decisions;
    // an attended human can override them via the requirements "revise" gate.
    if (this.config.interrogatorEnabled) {
      try {
        const clarifyTask = this.newTask(run, stage, { stage: "requirements", role: "interrogator", title: "Interrogate & sharpen the brief", workingDir: run.workingDir });
        const clarifyContent = await this.runTask(run, stage, clarifyTask, prompts.systemFor("interrogator"), prompts.interrogatorPrompt(run.idea, stack.label, run.discovery), run.workingDir);
        const clarify = extractJson<{ refinedBrief?: string; decisions?: { question: string; decision: string; rationale?: string; needsHuman?: boolean }[]; outOfScope?: string[] }>(clarifyContent);
        if (clarify) {
          const decisions = clarify.decisions ?? [];
          const lines: string[] = [];
          if (clarify.refinedBrief) lines.push(`Sharpened brief: ${clarify.refinedBrief}`);
          if (decisions.length) {
            lines.push("Decisions to build to (assumptions; a human may override these via 'revise'):");
            for (const d of decisions) lines.push(`- ${d.question} → ${d.decision}${d.needsHuman ? " [confirm]" : ""}`);
          }
          if (clarify.outOfScope?.length) lines.push(`Explicitly out of scope: ${clarify.outOfScope.join("; ")}`);
          if (lines.length) notes = lines.join("\n");
          const needConfirm = decisions.filter((d) => d.needsHuman).length;
          this.emit(run, { type: "log", stage: "requirements", message: `interrogator: ${decisions.length} decision(s) resolved${needConfirm ? `, ${needConfirm} flagged for a human to confirm` : ""}` });
        }
      } catch (err) {
        this.emit(run, { type: "log", stage: "requirements", level: "warn", message: `interrogator skipped (${err instanceof Error ? err.message : String(err)})` });
      }
    }

    // Loop supports the "revise" gate decision.
    for (;;) {
      const task = this.newTask(run, stage, { stage: "requirements", role: "requirements", title: "Gather requirements", workingDir: run.workingDir });
      const content = await this.runTask(
        run,
        stage,
        task,
        prompts.systemFor("requirements"),
        prompts.requirementsPrompt(run.idea, stack.label, notes, parity, run.discovery),
        run.workingDir,
      );
      const spec = extractJson<RequirementsSpec>(content);
      if (!spec) throw new Error("requirements agent did not return a valid JSON spec");
      spec.slug = spec.slug ? slugify(spec.slug) : slugify(spec.name);
      spec.stack = run.stack;
      if (run.referenceUrls?.length) {
        const sources = (run as Run & { _refSources?: ReferenceFeatureSet[] })._refSources ?? [];
        spec.referenceUrls = run.referenceUrls;
        spec.referenceFeatures = sources;
        spec.featureParity = parity;
        // Guarantee parity capabilities are present in the core feature list.
        spec.coreFeatures = mergeParity(spec.coreFeatures ?? [], parity);
      }
      run.requirements = spec;
      if (complianceControls.length) {
        spec.complianceProfiles = run.complianceProfiles;
        spec.complianceControls = complianceControls;
      }
      this.store.saveRun(run);
      if (this.config.wowEnabled) {
        await this.proposeWowFeatures(run, stage, spec);
      }

      const resolution = await this.gateIfNeeded(run, stage);
      if (resolution?.decision === "revise") {
        notes = resolution.notes ?? "Please revise per reviewer feedback.";
        stage.status = "running";
        continue;
      }
      // Apply the user's wow-feature selection from the gate, if provided.
      if (resolution?.wowSelected && run.requirements) {
        const available = new Set((run.requirements.wowFeatures ?? []).map((w) => w.id));
        run.requirements.wowSelected = resolution.wowSelected.filter((id) => available.has(id));
        this.store.saveRun(run);
      }
      break;
    }
    const wowCount = run.requirements?.wowSelected?.length ?? 0;
    this.endStage(run, stage, `${run.requirements?.summary ?? ""}${wowCount ? ` (+${wowCount} wow feature[s])` : ""}`);
  }

  /** Run the innovator agent, store proposals, and auto-select the top features. */
  private async proposeWowFeatures(run: Run, stage: Stage, spec: RequirementsSpec): Promise<void> {
    const task = this.newTask(run, stage, { stage: "requirements", role: "innovator", title: "Ideate differentiating 'wow' features", workingDir: run.workingDir });
    const content = await this.runTask(run, stage, task, prompts.systemFor("innovator"), prompts.wowIdeationPrompt(spec, run.discovery?.pains?.unmetNeeds), run.workingDir);
    const parsed = extractJson<{ wowFeatures?: WowFeature[] }>(content);
    const wow = (parsed?.wowFeatures ?? [])
      .filter((w) => w && w.title)
      .map((w, i) => ({
        id: w.id ? slugify(w.id) : slugify(`${w.title}-${i}`),
        title: w.title,
        description: w.description ?? "",
        rationale: w.rationale ?? "",
        impact: (w.impact ?? "medium") as WowFeature["impact"],
        effort: (w.effort ?? "medium") as WowFeature["effort"],
      }));
    spec.wowFeatures = wow;
    spec.wowSelected = rankWow(wow, this.config.wowAutoSelect);
    run.requirements = spec;
    this.store.saveRun(run);
    this.emit(run, {
      type: "log",
      stage: "requirements",
      message: `proposed ${wow.length} wow feature(s); pre-selected ${spec.wowSelected.length}`,
      data: { wowFeatures: wow, wowSelected: spec.wowSelected },
    });
  }

  /** Resolve current stable runtime versions once per run (offline-safe). */
  private async ensureRuntimeVersions(run: Run, stack: StackDef): Promise<void> {
    if (run.runtimeVersions && run.runtimeVersions.length > 0) return;
    const keys = runtimeKeysForStack(stack);
    if (keys.length === 0) return;
    try {
      const resolved = await resolveRuntimes(keys, { offline: this.config.offline, log: this.log });
      run.runtimeVersions = resolved;
      this.store.saveRun(run);
      const note = resolved.map((r) => `${r.label} ${r.version}${r.source === "fallback" ? " (fallback)" : ""}`).join(", ");
      this.emit(run, { type: "log", stage: "architect", message: `current stable runtimes: ${note}` });
    } catch (err) {
      this.emit(run, { type: "log", stage: "architect", level: "warn", message: `runtime version resolution skipped (${err instanceof Error ? err.message : String(err)})` });
    }
  }

  /** The runtime-versions prompt block for code-writing agents (empty if unresolved). */
  private runtimeHint(run: Run): string {
    return prompts.runtimeVersionsBlock(run.runtimeVersions);
  }

  private async stageArchitect(run: Run): Promise<void> {
    if (this.done(run, "architect")) return;
    const stage = this.beginStage(run, "architect");
    const stack = this.stackDef(run);
    await this.ensureRuntimeVersions(run, stack);
    const memoryDigest = this.memory.digest(4);
    const extra = memoryDigest ? `Lessons and reusable patterns from previous factory runs (reuse where sensible):\n${memoryDigest}` : "";

    // Best-of-N: generate N candidate plans, then pick the strongest (default 1).
    const n = Math.max(1, this.config.bestOf);
    if (n > 1) this.emit(run, { type: "log", stage: "architect", message: `best-of-${n} enabled (${n}x architect cost) — keep off unless the eval corpus shows it lifts outcomes` });
    const candidates: Array<{ content: string; plan?: BuildPlan }> = [];
    for (let i = 0; i < n; i++) {
      const task = this.newTask(run, stage, { stage: "architect", role: "architect", title: n > 1 ? `Design build plan (candidate ${i + 1}/${n})` : "Design build plan", workingDir: run.workingDir });
      const content = await this.runTask(run, stage, task, prompts.systemFor("architect", extra), prompts.architectPrompt(run.requirements!, stack, this.config.quality, this.scaleProfile(run), run.discovery, this.saasFor(run), this.runtimeHint(run)), run.workingDir);
      candidates.push({ content, plan: extractJson<BuildPlan>(content) });
    }
    // The last candidate is the one materialised in the workspace; if best-of-N,
    // ask the evaluator which plan JSON is strongest and adopt it.
    let content = candidates[candidates.length - 1]!.content;
    if (n > 1) {
      const pick = this.newTask(run, stage, { stage: "architect", role: "evaluator", title: "Select best architecture", workingDir: run.workingDir });
      const idxContent = await this.runTask(
        run,
        stage,
        pick,
        prompts.systemFor("evaluator"),
        `Two or more candidate architectures were proposed for "${run.requirements!.name}". Pick the single strongest for correctness, simplicity, parallelizability and scale, then ensure the workspace scaffold + contracts match it. Candidates:\n\n${candidates.map((c, i) => `### Candidate ${i + 1}\n${c.content.slice(0, 3000)}`).join("\n\n")}\n\nReconcile the workspace to your chosen candidate, then print the number you chose.`,
        run.workingDir,
      );
      const m = idxContent.match(/\b([1-9])\b/);
      const chosen = m ? Number(m[1]) - 1 : candidates.length - 1;
      if (candidates[chosen]) content = candidates[chosen]!.content;
    }

    let plan = extractJson<BuildPlan>(content);
    if (!plan || !Array.isArray(plan.workstreams) || plan.workstreams.length === 0) {
      // Fall back to the stack's declared workstreams so the pipeline proceeds.
      plan = {
        overview: content.slice(0, 2000),
        fileManifest: [],
        workstreams: stack.workstreams.map((w) => ({ ...w })),
        dependencies: {},
        integrationNotes: "Follow ARCHITECTURE.md for shared contracts.",
        contract: { openapi: "contracts/openapi.yaml", schema: "contracts/schema.sql", notes: "Implement strictly against these frozen files." },
      };
      this.emit(run, { type: "log", stage: "architect", level: "warn", message: "architect JSON missing; using stack default workstreams" });
    }
    if (!plan.contract) plan.contract = { openapi: "contracts/openapi.yaml", schema: "contracts/schema.sql" };
    run.plan = plan;

    // Optional proposer/critic debate: a critic stress-tests and revises the plan.
    if (this.config.archCritiqueEnabled) {
      const critic = this.newTask(run, stage, { stage: "architect", role: "critic", title: "Architecture critique", workingDir: run.workingDir });
      await this.runTask(run, stage, critic, prompts.systemFor("critic"), prompts.architectureCritiquePrompt(run.requirements!, plan), run.workingDir);
    }

    // Design system before the frontend is built (DESIGN.md).
    if (this.config.designEnabled) {
      const design = this.newTask(run, stage, { stage: "architect", role: "designer", title: "Design system", workingDir: run.workingDir });
      await this.runTask(run, stage, design, prompts.systemFor("designer"), prompts.designerPrompt(run.requirements!), run.workingDir);
    }

    await commitAllSafe(run.workingDir);
    await this.gateIfNeeded(run, stage);
    this.endStage(run, stage, plan.overview.slice(0, 400));
  }

  private orderWorkstreams(plan: BuildPlan): Workstream[][] {
    // Group workstreams into dependency "waves" so independent ones run in parallel.
    const remaining = new Map(plan.workstreams.map((w) => [w.id, w]));
    const done = new Set<string>();
    const waves: Workstream[][] = [];
    while (remaining.size > 0) {
      const wave: Workstream[] = [];
      for (const [id, w] of remaining) {
        const deps = plan.dependencies[id] ?? [];
        if (deps.every((d) => done.has(d) || !remaining.has(d))) wave.push(w);
      }
      if (wave.length === 0) wave.push(...remaining.values()); // break cycles
      for (const w of wave) {
        done.add(w.id);
        remaining.delete(w.id);
      }
      waves.push(wave);
    }
    return waves;
  }

  private async stageBuild(run: Run): Promise<void> {
    if (this.done(run, "build")) return;
    const stage = this.beginStage(run, "build");
    await this.ensureRuntimeVersions(run, this.stackDef(run));
    const plan = run.plan!;
    const waves = this.orderWorkstreams(plan);

    // True isolation: build each workstream in its own git worktree (a full,
    // independent checkout) so parallel builders can't clobber each other's
    // root files. Branches are merged back afterwards; conflicts are surfaced
    // (not silently lost) for the integrator to reconcile.
    const useWorktrees = this.config.isolateWorktrees && existsSync(join(run.workingDir, ".git")) && plan.workstreams.length > 1;
    const worktrees = new Map<string, { path: string; branch: string }>();

    for (const wave of waves) {
      await mapLimit(wave, this.config.maxParallel, async (ws) => {
        let dir: string;
        let wtRoot: string | undefined;
        if (useWorktrees) {
          const branch = `factory/ws-${ws.id}`;
          const path = resolve(run.workingDir, "..", `wt-${run.id}-${ws.id}`);
          try {
            await addWorktree(run.workingDir, branch, path);
            worktrees.set(ws.id, { path, branch });
            wtRoot = path;
            dir = ws.dir && ws.dir !== "." ? join(path, ws.dir) : path;
          } catch (err) {
            this.emit(run, { type: "log", stage: "build", level: "warn", message: `worktree for ${ws.id} failed (${String(err)}); building in shared tree` });
            dir = ws.dir && ws.dir !== "." ? join(run.workingDir, ws.dir) : run.workingDir;
          }
        } else {
          dir = ws.dir && ws.dir !== "." ? join(run.workingDir, ws.dir) : run.workingDir;
        }
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const task = this.newTask(run, stage, { stage: "build", role: "builder", title: `Build: ${ws.title}`, workstreamId: ws.id, workingDir: dir });
        await this.runTask(run, stage, task, prompts.systemFor("builder"), prompts.builderPrompt(run.requirements!, plan, ws, this.config.quality, this.saasFor(run), this.runtimeHint(run)), dir);
        // Commit inside the worktree so its branch carries the changes.
        if (wtRoot) {
          try {
            await commitAll(wtRoot, `build(${ws.id}): ${ws.title}`.slice(0, 72));
          } catch {
            /* nothing to commit is fine */
          }
        }
      });
    }

    // Merge each workstream branch back into the build branch.
    if (useWorktrees) {
      for (const ws of plan.workstreams) {
        const info = worktrees.get(ws.id);
        if (!info) continue;
        const { ok, conflicts } = await mergeBranch(run.workingDir, info.branch, `merge workstream ${ws.id}`);
        if (!ok) {
          await abortMerge(run.workingDir);
          this.emit(run, { type: "log", stage: "build", level: "warn", message: `merge ${conflicts ? "conflict" : "failed"} for ${ws.id} — left for integrator to reconcile` });
        }
      }
      for (const [, info] of worktrees) {
        try {
          await removeWorktree(run.workingDir, info.branch, info.path);
        } catch {
          /* cleanup best-effort */
        }
      }
    }

    await commitAllSafe(run.workingDir);
    this.endStage(run, stage, `${plan.workstreams.length} workstream(s) built${useWorktrees ? " (isolated worktrees)" : ""}`);
  }

  private async stageIntegrate(run: Run): Promise<void> {
    if (this.done(run, "integrate")) return;
    const stage = this.beginStage(run, "integrate");

    // Pre-integration review: catch stubs and contract drift before merging.
    // Advisory-only: a slow/failed review must not abort the run — the
    // deterministic verify harness downstream is the real quality gate.
    const reviewTask = this.newTask(run, stage, { stage: "integrate", role: "reviewer", title: "Pre-integration review", workingDir: run.workingDir });
    try {
      await this.runTask(run, stage, reviewTask, prompts.systemFor("reviewer"), prompts.reviewerPrompt(run.requirements!, run.plan!), run.workingDir);
    } catch (err) {
      reviewTask.status = "failed";
      this.emit(run, { type: "log", stage: "integrate", taskId: reviewTask.id, level: "warn", message: `pre-integration review did not finish (${err instanceof Error ? err.message : String(err)}) — proceeding to integrate; verify harness remains the gate` });
    }
    await commitAllSafe(run.workingDir);

    const task = this.newTask(run, stage, { stage: "integrate", role: "integrator", title: "Integrate workstreams", workingDir: run.workingDir });
    await this.runTask(run, stage, task, prompts.systemFor("integrator"), prompts.integratorPrompt(run.requirements!, run.plan!), run.workingDir);
    await commitAllSafe(run.workingDir);

    // Feature-parity audit against comparable apps, if references were provided.
    const parity = run.requirements?.featureParity ?? [];
    if (parity.length > 0) {
      const parityTask = this.newTask(run, stage, { stage: "integrate", role: "integrator", title: "Verify feature parity", workingDir: run.workingDir });
      const content = await this.runTask(run, stage, parityTask, prompts.systemFor("integrator"), prompts.parityVerifyPrompt(run.requirements!), run.workingDir);
      const result = extractJson<{ covered?: string[]; added?: string[]; gaps?: string[]; notes?: string }>(content);
      const gaps = result?.gaps ?? [];
      const covered = (result?.covered?.length ?? 0) + (result?.added?.length ?? 0);
      this.emit(run, {
        type: "log",
        stage: "integrate",
        level: gaps.length > 0 ? "warn" : "info",
        message: `parity: ${covered}/${parity.length} covered${gaps.length ? `, ${gaps.length} gap(s): ${gaps.join("; ")}` : ""}`,
        data: result,
      });
      await commitAllSafe(run.workingDir);
      this.endStage(run, stage, `parity ${covered}/${parity.length}${gaps.length ? ` (${gaps.length} gap[s])` : " ✓"}`);
      return;
    }
    this.endStage(run, stage);
  }

  private async stageTest(run: Run): Promise<void> {
    if (this.done(run, "test")) return;
    const stage = this.beginStage(run, "test");
    const task = this.newTask(run, stage, { stage: "test", role: "test", title: "Author and run tests", workingDir: run.workingDir });
    await this.runTask(run, stage, task, prompts.systemFor("test"), prompts.testPrompt(run.requirements!), run.workingDir);
    await commitAllSafe(run.workingDir);
    this.endStage(run, stage);
  }

  private async stageVerify(run: Run): Promise<void> {
    if (this.done(run, "verify")) return;
    const stage = this.beginStage(run, "verify");

    // 1. DETERMINISTIC harness: actually boot the app, poll health, run tests.
    //    Exit codes are the truth; the agent below only fixes what this finds.
    const recipe = this.stackDef(run).run;
    const report = await runVerification(run.workingDir, recipe, this.log.child("verify"), {
      minCoverage: this.config.minCoverage,
      mutation: this.config.mutationEnabled,
      minMutationScore: this.config.minMutationScore,
      onLog: (line) => this.emit(run, { type: "log", stage: "verify", message: line.slice(0, 300) }),
    });
    run.verify = report;
    this.store.saveRun(run);
    this.emit(run, {
      type: "verify.report",
      stage: "verify",
      level: report.smokePassed ? "info" : "warn",
      message: `booted=${report.booted}, health=${report.healthOk}${report.frontendOk !== undefined ? `, ui=${report.frontendOk}` : ""}, tests=${report.testsPassed ?? "n/a"}${report.coveragePct !== undefined ? `, cov=${report.coveragePct.toFixed(0)}%` : ""}${report.mutationScore !== undefined ? `, mut=${report.mutationScore.toFixed(0)}%` : ""} (${report.method})`,
      data: report,
    });

    // 2. If the deterministic harness found the app broken, an agent fixes it,
    //    then we re-verify deterministically to confirm the fix is real.
    const brokenButBootable = recipe?.up && !report.smokePassed && (report.booted || report.testsPassed === false);
    if (brokenButBootable) {
      const fixTask = this.newTask(run, stage, { stage: "verify", role: "verifier", title: "Fix boot/health/test failures", workingDir: run.workingDir });
      const hint = `The deterministic verify harness reported failures. Fix them so the app boots, its health endpoint returns 2xx, and the test suite passes.\n\nEvidence:\n${report.logsTail ?? report.details}`;
      await this.runTask(run, stage, fixTask, prompts.systemFor("verifier"), `${prompts.verifyPrompt(run.requirements!, this.config.visualQaEnabled)}\n\n${hint}`, run.workingDir);
      await commitAllSafe(run.workingDir);
      const report2 = await runVerification(run.workingDir, recipe, this.log.child("verify"), {
        minCoverage: this.config.minCoverage,
        mutation: this.config.mutationEnabled,
        minMutationScore: this.config.minMutationScore,
        onLog: (line) => this.emit(run, { type: "log", stage: "verify", message: line.slice(0, 300) }),
      });
      run.verify = report2;
      this.store.saveRun(run);
      this.emit(run, { type: "verify.report", stage: "verify", level: report2.smokePassed ? "info" : "warn", message: `re-verify: booted=${report2.booted}, health=${report2.healthOk}, tests=${report2.testsPassed ?? "n/a"}`, data: report2 });
    }

    // Visual QA: opt-in and only when a browser is actually available (evidence-gated).
    if (this.config.visualQaEnabled) {
      const vt = this.newTask(run, stage, { stage: "verify", role: "designer", title: "Visual design review", workingDir: run.workingDir });
      await this.runTask(run, stage, vt, prompts.systemFor("designer"), prompts.visualCritiquePrompt(run.requirements!), run.workingDir);
    }

    await commitAllSafe(run.workingDir);
    const final = run.verify;
    this.endStage(run, stage, final ? `booted=${final.booted}, health=${final.healthOk}${final.frontendOk !== undefined ? `, ui=${final.frontendOk}` : ""}, tests=${final.testsPassed ?? "n/a"}` : undefined);
  }

  private async stageSecurity(run: Run): Promise<void> {
    if (this.done(run, "security")) return;
    const stage = this.beginStage(run, "security");
    run.security = [];
    const policy = this.config.security;

    for (let iteration = 1; iteration <= policy.maxFixIterations; iteration++) {
      const { findings, skipped, ran } = await runScanners(run.workingDir, policy, this.log.child("scan"), (f) =>
        this.emit(run, { type: "log", stage: "security", message: `finding [${f.severity}] ${f.title}` }),
      );
      const report = evaluate(findings, policy, iteration);
      report.counts["scannersRan"] = ran.length;
      // Fail-closed: if NO scanners actually ran, security is NOT verified.
      if (ran.length === 0) {
        this.emit(run, {
          type: "log",
          stage: "security",
          level: this.config.requireScanners ? "error" : "warn",
          message: `0 security scanners ran (skipped: ${skipped.join(", ") || "none installed"}) — security is NOT verified${this.config.requireScanners ? " (FACTORY_REQUIRE_SCANNERS: failing gate)" : ""}`,
        });
        if (this.config.requireScanners) report.passed = false;
      }
      run.security.push(report);
      this.store.saveRun(run);
      this.emit(run, { type: "security.report", stage: "security", level: report.passed ? "info" : "warn", message: `iteration ${iteration}: ${findings.length} finding(s), ${ran.length} scanner(s) ran, passed=${report.passed}`, data: { report, skipped, ran } });

      if (report.passed && iteration > 1) break;
      if (report.passed && findings.length === 0 && !policy.llmReview.enabled) break;

      // Run a remediation sub-agent (also does an LLM security review pass).
      const task = this.newTask(run, stage, { stage: "security", role: "security", title: `Harden (pass ${iteration})`, workingDir: run.workingDir });
      await this.runTask(run, stage, task, prompts.systemFor("security"), prompts.securityFixPrompt(findings, policy.llmReview.focus, iteration), run.workingDir);
      await commitAllSafe(run.workingDir);

      if (report.passed) break; // one LLM pass done on a clean scan; stop.
    }

    // Compliance audit against the selected profiles (control-to-implementation matrix).
    if ((run.requirements?.complianceControls ?? []).length > 0) {
      const task = this.newTask(run, stage, { stage: "security", role: "compliance", title: "Compliance audit", workingDir: run.workingDir });
      const content = await this.runTask(run, stage, task, prompts.systemFor("compliance"), prompts.complianceAuditPrompt(run.requirements!), run.workingDir);
      const parsed = extractJson<{ profiles?: string[]; results?: ComplianceReport["results"] }>(content);
      const results = parsed?.results ?? [];
      const met = results.filter((r) => r.status === "met").length;
      const partial = results.filter((r) => r.status === "partial").length;
      const gap = results.filter((r) => r.status === "gap").length;
      const compliance: ComplianceReport = { profiles: run.requirements!.complianceProfiles ?? [], results, met, partial, gap, passed: gap === 0 };
      run.compliance = compliance;
      this.store.saveRun(run);
      this.emit(run, { type: "compliance.report", stage: "security", level: gap > 0 ? "warn" : "info", message: `compliance: ${met} met, ${partial} partial, ${gap} gap`, data: compliance });
      await commitAllSafe(run.workingDir);
    }

    const last = run.security[run.security.length - 1];
    this.endStage(run, stage, last ? `passed=${last.passed}, findings=${last.findings.length}` : undefined);
  }

  private async stageDelivery(run: Run): Promise<void> {
    if (this.done(run, "delivery")) return;
    const stage = this.beginStage(run, "delivery");
    await this.ensureRuntimeVersions(run, this.stackDef(run));
    const task = this.newTask(run, stage, { stage: "delivery", role: "devops", title: "CI/CD, IaC & repo hygiene", workingDir: run.workingDir });
    const summary = await this.runTask(run, stage, task, prompts.systemFor("devops"), prompts.deliveryPrompt(run.requirements!, this.config.deployEnabled, this.scaleProfile(run), this.saasFor(run), this.config.cloud, this.runtimeHint(run)), run.workingDir);
    await commitAllSafe(run.workingDir);

    // Optional ephemeral deploy + LIVE smoke: the true definition of done — a
    // real URL answered 2xx. Best-effort; never blocks the pipeline.
    if (this.config.deployEnabled && this.config.cloud !== "none") {
      const healthPath = healthPathFromUrl(this.stackDef(run).run?.healthUrl);
      const deploy = await deployAndSmoke(
        run.workingDir,
        { cloud: this.config.cloud, ...(this.config.deployCommand ? { command: this.config.deployCommand } : {}), ...(healthPath ? { healthPath } : {}), ephemeral: this.config.deployEphemeral, ...(this.config.dastEnabled ? { dast: { image: this.config.dastImage, failOn: "fail" as const } } : {}), onLog: (l) => this.emit(run, { type: "log", stage: "delivery", message: l.slice(0, 300) }) },
        this.log.child("deploy"),
      );
      run.deploy = deploy;
      this.store.saveRun(run);
      this.emit(run, { type: "deploy.report", stage: "delivery", level: deploy.deployed && deploy.liveHealthOk !== false && deploy.dast?.passed !== false ? "info" : "warn", message: `deploy(${deploy.cloud}): deployed=${deploy.deployed}, live=${deploy.liveHealthOk ?? "n/a"}${deploy.dast ? `, dast=${deploy.dast.passed ? "pass" : `fail(${deploy.dast.fails})`}` : ""}${deploy.url ? `, ${deploy.url}` : ""}`, data: deploy });
    }

    this.endStage(run, stage, summary.split("\n").find((l) => l.trim())?.slice(0, 120));
  }

  private async stageRelease(run: Run): Promise<void> {
    if (this.done(run, "release")) return;
    const stage = this.beginStage(run, "release");
    const spec = run.requirements!;

    // Microcopy/brand polish so the product feels shipped, not scaffolded.
    if (this.config.copyEnabled) {
      const copy = this.newTask(run, stage, { stage: "release", role: "copywriter", title: "Microcopy & brand polish", workingDir: run.workingDir });
      await this.runTask(run, stage, copy, prompts.systemFor("copywriter"), prompts.copywriterPrompt(spec), run.workingDir);
    }

    // Prepare the repo contents.
    const task = this.newTask(run, stage, { stage: "release", role: "release", title: "Prepare repository", workingDir: run.workingDir });
    const summary = await this.runTask(run, stage, task, prompts.systemFor("release"), prompts.releasePrompt(spec), run.workingDir);

    // Definition-of-done: score from GROUND-TRUTH signals, not an LLM opinion.
    // The evaluator (if enabled) only writes an explanatory narrative.
    const signals = this.acceptanceSignals(run);
    let llmSummary: string | undefined;
    if (this.config.acceptanceEnabled) {
      const scoreTask = this.newTask(run, stage, { stage: "release", role: "evaluator", title: "Acceptance narrative", workingDir: run.workingDir });
      const scoreContent = await this.runTask(run, stage, scoreTask, prompts.systemFor("evaluator"), prompts.acceptancePrompt(spec), run.workingDir);
      const parsed = extractJson<{ summary?: string }>(scoreContent);
      llmSummary = parsed?.summary ?? scoreContent.split("\n").find((l) => l.trim())?.slice(0, 600);
    }
    const acceptance = computeAcceptance(signals, llmSummary);
    // Opt-in hard gates: coverage and live-URL DAST can fail the run outright.
    if (this.config.requireCoverage && signals.coverageOk === false) {
      acceptance.passed = false;
      this.emit(run, { type: "log", stage: "release", level: "error", message: `coverage below floor ${this.config.minCoverage}% (FACTORY_REQUIRE_COVERAGE: failing acceptance)` });
    }
    if (this.config.requireDast && signals.dastPassed === false) {
      acceptance.passed = false;
      this.emit(run, { type: "log", stage: "release", level: "error", message: `live-URL DAST failed (FACTORY_REQUIRE_DAST: failing acceptance)` });
    }
    run.acceptance = acceptance;
    this.store.saveRun(run);
    this.emit(run, { type: "acceptance.report", stage: "release", level: acceptance.passed ? "info" : "warn", message: `acceptance ${acceptance.score}/100 (deterministic)${acceptance.passed ? " ✓" : ""}`, data: acceptance });

    // Commit an auditable RUN_REPORT.md into the repo (proof, not "trust me").
    this.writeRunReport(run);

    // Ensure a git repo + commit exists before the push gate.
    if (!existsSync(join(run.workingDir, ".git"))) {
      await initAndCommit(run.workingDir, "Initial commit — generated by AI SaaS Factory");
    } else {
      await commitAll(run.workingDir, "Finalize release + RUN_REPORT — generated by AI SaaS Factory");
    }

    // Human approval gate immediately before the push.
    await this.gateIfNeeded(run, stage);

    const description = (summary.split("\n").find((l) => l.trim().length > 0) ?? spec.summary).slice(0, 250);
    await this.publishRepo(run, spec.slug, description);
    this.endStage(run, stage, run.prUrl ?? run.repoUrl);
  }

  /** Assemble machine-checkable acceptance signals from the run's artifacts. */
  private acceptanceSignals(run: Run): AcceptanceSignals {
    const lastSec = run.security?.[(run.security?.length ?? 0) - 1];
    const scannersRan = lastSec ? (lastSec.counts["scannersRan"] ?? 0) : 0;
    return {
      ...(run.verify?.buildOk !== undefined ? { buildOk: run.verify.buildOk } : {}),
      ...(run.verify ? { booted: run.verify.booted, healthOk: run.verify.healthOk } : {}),
      ...(run.verify?.testsPassed !== undefined ? { testsPassed: run.verify.testsPassed } : {}),
      ...(run.verify?.coverageOk !== undefined ? { coverageOk: run.verify.coverageOk } : {}),
      ...(run.verify?.mutationOk !== undefined ? { mutationOk: run.verify.mutationOk } : {}),
      ...(lastSec ? { securityPassed: lastSec.passed } : {}),
      scannersRan,
      ...(run.compliance ? { complianceGap: run.compliance.gap } : {}),
      ...(run.deploy?.liveHealthOk !== undefined ? { liveHealthOk: run.deploy.liveHealthOk } : {}),
      ...(run.deploy?.dast ? { dastPassed: run.deploy.dast.passed } : {}),
    };
  }

  /** Write a deterministic, auditable RUN_REPORT.md into the workspace. */
  private writeRunReport(run: Run): void {
    try {
      const lastSec = run.security?.[(run.security?.length ?? 0) - 1];
      const a = run.acceptance;
      const lines: string[] = [
        `# Run Report — ${run.requirements?.name ?? run.idea}`,
        "",
        `- **Run id:** ${run.id}`,
        `- **Idea:** ${run.idea}`,
        `- **Stack:** ${run.stack}${run.scale ? `  ·  scale: ${run.scale}` : ""}`,
        run.saas?.length ? `- **SaaS layer:** ${run.saas.join(", ")}` : "",
        `- **Cloud:** ${this.config.cloud}`,
        `- **Generated:** ${new Date().toISOString()}`,
        "",
        "## Verification (deterministic)",
        run.verify
          ? `- booted: **${run.verify.booted}**, health: **${run.verify.healthOk}**, tests: **${run.verify.testsPassed ?? "n/a"}** (${run.verify.method})`
          : "- not run",
        run.verify?.coveragePct !== undefined ? `- coverage: **${run.verify.coveragePct.toFixed(1)}%**${run.verify.coverageOk !== undefined ? ` (floor ${run.verify.coverageOk ? "met" : "MISSED"})` : ""}` : "",
        run.verify?.mutationScore !== undefined ? `- mutation score: **${run.verify.mutationScore.toFixed(1)}%**${run.verify.mutationOk !== undefined ? ` (floor ${run.verify.mutationOk ? "met" : "MISSED"})` : ""}` : "",
        "",
        "## Security",
        lastSec ? `- passed: **${lastSec.passed}**, findings: ${lastSec.findings.length}, scanners ran: ${lastSec.counts["scannersRan"] ?? 0}` : "- not run",
        run.deploy?.dast ? `- live-URL DAST: **${run.deploy.dast.passed ? "PASS" : "FAIL"}** (${run.deploy.dast.fails} fail / ${run.deploy.dast.warnings} warn, ${run.deploy.dast.method})` : "",
        run.compliance ? `- compliance: ${run.compliance.met} met / ${run.compliance.partial} partial / ${run.compliance.gap} gap` : "",
        "",
        "## Deploy",
        run.deploy ? `- ${run.deploy.cloud}: deployed **${run.deploy.deployed}**, live health **${run.deploy.liveHealthOk ?? "n/a"}**${run.deploy.url ? `, ${run.deploy.url}` : ""}` : "- not attempted",
        "",
        "## Acceptance (from ground-truth signals)",
        a ? `- **${a.score}/100** — ${a.passed ? "PASS" : "FAIL"}` : "- not scored",
        ...(a?.breakdown ?? []).map((b) => `  - ${b.dimension}: ${b.score}${b.notes ? ` (${b.notes})` : ""}`),
        "",
        "## Cost",
        run.cost ? `- ~$${run.cost.estimatedUsd.toFixed(2)} · ${run.cost.totalTokens} tokens · ${run.cost.taskCount} tasks` : "- n/a",
        "",
        "_Generated by AI SaaS Factory._",
      ].filter((l) => l !== "");
      writeFileSync(join(run.workingDir, "RUN_REPORT.md"), lines.join("\n") + "\n", "utf8");
    } catch (err) {
      this.log.warn(`RUN_REPORT write failed: ${String(err)}`);
    }
  }

  /** Publish the repo: offline (local), PR-first (branch + PR), or push to main. */
  private async publishRepo(run: Run, slug: string, description: string): Promise<void> {
    if (this.config.offline) {
      run.repoUrl = `file://${run.workingDir}`;
      this.store.saveRun(run);
      this.emit(run, { type: "log", stage: "release", message: `offline mode — not pushing; repo at ${run.repoUrl}` });
      return;
    }
    if (run.branch) {
      // PR-first: create the repo, push the scaffold main, then push the build
      // branch and open a PR carrying the RUN_REPORT for human review.
      this.emit(run, { type: "log", stage: "release", message: `creating GitHub repo '${slug}' (PR-first, ${this.config.repoVisibility})` });
      const url = await createRepoOnly(slug, description, { owner: this.config.githubOwner, visibility: this.config.repoVisibility }, run.workingDir);
      run.repoUrl = url;
      await pushBranch(run.workingDir, "main");
      const pr = await openPullRequest(run.workingDir, run.branch, `${run.requirements?.name ?? slug}: initial build`, prBody(run));
      run.prUrl = pr.url;
      this.store.saveRun(run);
      this.emit(run, { type: "log", stage: "release", message: `opened PR: ${pr.url}` });
      return;
    }
    this.emit(run, { type: "log", stage: "release", message: `creating GitHub repo '${slug}' (${this.config.repoVisibility})` });
    const { url } = await createRepoAndPush(run.workingDir, slug, description, {
      owner: this.config.githubOwner,
      visibility: this.config.repoVisibility,
    });
    run.repoUrl = url;
    this.store.saveRun(run);
    this.emit(run, { type: "log", stage: "release", message: `pushed to ${url}` });
  }

  /** Resume an interrupted run: completed stages are skipped automatically. */
  async resume(run: Run): Promise<Run> {
    this.emit(run, { type: "log", message: `resuming run ${run.id} from ${run.currentStage ?? "start"}` });
    return this.execute(run);
  }

  /**
   * Apply a follow-up change to an already-built run's workspace, then re-test,
   * re-scan and push to the existing repository.
   */
  async iterate(run: Run, instruction: string): Promise<Run> {
    if (!run.requirements) throw new Error("run has no requirements to iterate on");
    if (!existsSync(run.workingDir)) throw new Error("run workspace no longer exists");
    this.setStatus(run, "running");
    try {
      await this.runtime.start(run.workingDir);
      const stage = this.stage(run, "build");
      stage.status = "running";
      this.emit(run, { type: "stage.start", stage: "build", message: `iteration: ${instruction}` });

      const buildTask = this.newTask(run, stage, { stage: "build", role: "builder", title: `Iterate: ${instruction.slice(0, 48)}`, workingDir: run.workingDir });
      await this.runTask(run, stage, buildTask, prompts.systemFor("builder"), prompts.iteratePrompt(run.requirements, instruction), run.workingDir);

      const testTask = this.newTask(run, stage, { stage: "test", role: "test", title: "Re-run tests", workingDir: run.workingDir });
      await this.runTask(run, stage, testTask, prompts.systemFor("test"), prompts.testPrompt(run.requirements), run.workingDir);

      await commitAll(run.workingDir, `Iteration: ${instruction}`.slice(0, 72));
      if (existsSync(join(run.workingDir, ".git")) && run.repoUrl) {
        const log = await pushCurrent(run.workingDir);
        this.emit(run, { type: "log", stage: "release", message: `pushed iteration to ${run.repoUrl}` });
        this.log.debug(log);
      }
      this.setStatus(run, "completed");
      this.emit(run, { type: "run.done", message: "iteration completed", data: { repoUrl: run.repoUrl } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      run.error = message;
      this.setStatus(run, "failed");
      this.emit(run, { type: "run.done", level: "error", message: `iteration failed: ${message}` });
    }
    return run;
  }

  /* --------------------------- operate (day-2) ---------------------------- */

  /** Create a lightweight run for an operate-mode task on an existing repo. */
  private createOperateRun(opts: { idea: string; stack: string; workingDir: string; mode: Run["mode"]; prMode?: boolean; projectId?: string }): Run {
    const id = randomUUID().slice(0, 8);
    const run: Run = {
      id,
      idea: opts.idea,
      stack: opts.stack,
      status: "created",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workingDir: opts.workingDir,
      gates: [],
      mode: opts.mode,
      ...(opts.prMode ? { prMode: true } : {}),
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      stages: PIPELINE.map((name) => ({ name, status: "pending", requiresApproval: false, tasks: [] })),
    };
    this.store.saveRun(run);
    this.emit(run, { type: "run.created", message: `operate run ${id} (${opts.mode})`, data: { mode: opts.mode, dir: opts.workingDir } });
    return run;
  }

  /**
   * Operate on an existing repository: reproduce+fix a bug, self-heal from
   * signals, or ship a feature. Lands via a PR (prMode) or a direct push.
   */
  async operate(opts: {
    workingDir: string;
    stack: string;
    kind: "fix" | "heal" | "feature";
    task: string;
    diagnosis?: string;
    prMode?: boolean;
    hasRemote?: boolean;
    projectId?: string;
  }): Promise<Run> {
    const run = this.createOperateRun({ idea: `${opts.kind}: ${opts.task}`.slice(0, 120), stack: opts.stack, workingDir: opts.workingDir, mode: opts.kind === "feature" ? "operate" : "fix", prMode: opts.prMode, projectId: opts.projectId });
    this.setStatus(run, "running");
    try {
      await this.runtime.start(run.workingDir);
      const stage = this.beginStage(run, "build");

      if (opts.kind === "fix") {
        // Triage → diagnose → minimal fix + regression test.
        let diagnosis = opts.diagnosis ?? "";
        if (!diagnosis) {
          const t = this.newTask(run, stage, { stage: "build", role: "triage", title: "Triage bug", workingDir: run.workingDir });
          const content = await this.runTask(run, stage, t, prompts.systemFor("triage"), prompts.triagePrompt(opts.task), run.workingDir);
          const parsed = extractJson<{ rootCause?: string; reproduction?: string[]; summary?: string }>(content);
          diagnosis = parsed?.rootCause ? `${parsed.summary ?? ""}\nRoot cause: ${parsed.rootCause}\nRepro: ${(parsed.reproduction ?? []).join("; ")}` : content.slice(0, 1500);
        }
        const fix = this.newTask(run, stage, { stage: "build", role: "builder", title: "Apply fix", workingDir: run.workingDir });
        await this.runTask(run, stage, fix, prompts.systemFor("builder"), prompts.fixPrompt(opts.task, diagnosis), run.workingDir);
      } else if (opts.kind === "heal") {
        const sre = this.newTask(run, stage, { stage: "build", role: "sre", title: "SRE self-heal", workingDir: run.workingDir });
        await this.runTask(run, stage, sre, prompts.systemFor("sre"), prompts.srePrompt(opts.task), run.workingDir);
      } else {
        const spec = run.requirements ?? ({ name: "the app", stack: opts.stack, coreFeatures: [] } as unknown as RequirementsSpec);
        const feat = this.newTask(run, stage, { stage: "build", role: "builder", title: "Ship feature", workingDir: run.workingDir });
        await this.runTask(run, stage, feat, prompts.systemFor("builder"), prompts.iteratePrompt(spec, opts.task), run.workingDir);
      }

      // Re-test after the change.
      const spec = run.requirements ?? ({ name: "the app", stack: opts.stack, coreFeatures: [] } as unknown as RequirementsSpec);
      const test = this.newTask(run, stage, { stage: "test", role: "test", title: "Re-run tests", workingDir: run.workingDir });
      await this.runTask(run, stage, test, prompts.systemFor("test"), prompts.testPrompt(spec), run.workingDir);

      // Deterministically verify the change actually still boots + passes tests.
      const recipe = this.config.stacks.stacks[opts.stack]?.run;
      const verify = await runVerification(run.workingDir, recipe, this.log.child("verify"), { onLog: (l) => this.emit(run, { type: "log", stage: "test", message: l.slice(0, 300) }) });
      run.verify = verify;
      this.emit(run, { type: "verify.report", stage: "test", level: verify.smokePassed ? "info" : "warn", message: `verify: booted=${verify.booted}, tests=${verify.testsPassed ?? "n/a"}`, data: verify });
      this.endStage(run, stage, `${opts.kind} applied (tests=${verify.testsPassed ?? "n/a"})`);

      // Land the change.
      const title = `[factory ${opts.kind}] ${opts.task}`.slice(0, 80);
      if (opts.prMode && opts.hasRemote) {
        const branch = `factory/${opts.kind}-${run.id}`;
        await createBranch(run.workingDir, branch);
        await commitAll(run.workingDir, title);

        // Preview environment per PR: deploy the change to an ephemeral env and
        // let a human review a RUNNING change, not just a diff.
        let previewLine = "";
        if (this.config.deployEnabled && this.config.cloud !== "none") {
          const healthPath = healthPathFromUrl(recipe?.healthUrl);
          const preview = await deployAndSmoke(run.workingDir, { cloud: this.config.cloud, ...(this.config.deployCommand ? { command: this.config.deployCommand } : {}), ...(healthPath ? { healthPath } : {}), ephemeral: this.config.deployEphemeral, ...(this.config.dastEnabled ? { dast: { image: this.config.dastImage, failOn: "fail" as const } } : {}), onLog: (l) => this.emit(run, { type: "log", stage: "release", message: l.slice(0, 300) }) }, this.log.child("deploy"));
          run.deploy = preview;
          this.emit(run, { type: "deploy.report", stage: "release", level: preview.liveHealthOk !== false && preview.dast?.passed !== false ? "info" : "warn", message: `preview(${preview.cloud}): ${preview.url ?? "no url"} live=${preview.liveHealthOk ?? "n/a"}${preview.dast ? ` dast=${preview.dast.passed ? "pass" : "fail"}` : ""}`, data: preview });
          if (preview.url) previewLine = `\n\n**Live preview:** ${preview.url} (health ${preview.liveHealthOk ?? "n/a"}${preview.dast ? `, DAST ${preview.dast.passed ? "pass" : `fail: ${preview.dast.fails}`}` : ""})`;
        }

        const verifyLine = `\n\n**Verify:** booted=${verify.booted}, tests=${verify.testsPassed ?? "n/a"}`;
        const { url } = await openPullRequest(run.workingDir, branch, title, `Automated ${opts.kind} by AI SaaS Factory.\n\n> ${opts.task}${verifyLine}${previewLine}`);
        run.prUrl = url;
        run.repoUrl = url;
        this.emit(run, { type: "log", stage: "release", message: `opened PR: ${url}` });
      } else {
        await commitAll(run.workingDir, title);
        if (opts.hasRemote) {
          const log = await pushCurrent(run.workingDir);
          this.log.debug(log);
          this.emit(run, { type: "log", stage: "release", message: "pushed to main" });
        }
      }
      this.store.saveRun(run);
      this.setStatus(run, "completed");
      this.emit(run, { type: "run.done", message: `${opts.kind} completed`, data: { repoUrl: run.repoUrl } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      run.error = message;
      this.setStatus(run, message === "__CANCELLED__" ? "cancelled" : "failed");
      this.emit(run, { type: "run.done", level: "error", message: `${opts.kind} failed: ${message}` });
    }
    return run;
  }

  /** Produce an effort/cost/timeline estimate for an idea without building. */
  async estimate(idea: string, stackId?: string): Promise<{ run: Run; estimate: unknown }> {
    const stackKey = stackId && this.config.stacks.stacks[stackId] ? stackId : this.config.stacks.default;
    const stack = this.config.stacks.stacks[stackKey]!;
    const workingDir = resolve(this.config.workspacesDir, `estimate-${randomUUID().slice(0, 6)}`);
    mkdirSync(workingDir, { recursive: true });
    const run = this.createOperateRun({ idea, stack: stackKey, workingDir, mode: "operate" });
    this.setStatus(run, "running");
    let estimate: unknown;
    try {
      await this.runtime.start(workingDir);
      const stage = this.beginStage(run, "requirements");
      const t = this.newTask(run, stage, { stage: "requirements", role: "estimator", title: "Estimate", workingDir });
      const content = await this.runTask(run, stage, t, prompts.systemFor("estimator"), prompts.estimatePrompt(idea, stack.label), workingDir);
      estimate = extractJson(content) ?? { summary: content.slice(0, 1500) };
      this.endStage(run, stage, "estimate produced");
      this.setStatus(run, "completed");
      this.emit(run, { type: "run.done", message: "estimate completed", data: estimate });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      run.error = message;
      this.setStatus(run, "failed");
      this.emit(run, { type: "run.done", level: "error", message: `estimate failed: ${message}` });
    }
    return { run, estimate };
  }

  /** Plan a sprint: group backlog items into parallel squads. */
  async sprintPlan(name: string, items: { id: string; title: string }[], workingDir: string): Promise<{ run: Run; plan: unknown }> {
    mkdirSync(workingDir, { recursive: true });
    const run = this.createOperateRun({ idea: `sprint: ${name}`, stack: this.config.stacks.default, workingDir, mode: "sprint" });
    this.setStatus(run, "running");
    let plan: unknown;
    try {
      await this.runtime.start(workingDir);
      const stage = this.beginStage(run, "architect");
      const t = this.newTask(run, stage, { stage: "architect", role: "em", title: "Sprint plan", workingDir });
      const content = await this.runTask(run, stage, t, prompts.systemFor("em"), prompts.sprintPlanPrompt(name, items, this.config.maxParallel), workingDir);
      plan = extractJson(content) ?? { goal: content.slice(0, 800) };
      this.endStage(run, stage, "sprint planned");
      this.setStatus(run, "completed");
      this.emit(run, { type: "run.done", message: "sprint plan completed", data: plan });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      run.error = message;
      this.setStatus(run, "failed");
      this.emit(run, { type: "run.done", level: "error", message: `sprint plan failed: ${message}` });
    }
    return { run, plan };
  }

  /** Read-only access to the evaluation corpus for reporting. */
  evalStore(): EvalStore {
    return this.evals;
  }
}

/** Commit staged work, ignoring the "nothing to commit" case and git absence. */
async function commitAllSafe(dir: string): Promise<void> {
  try {
    if (!existsSync(join(dir, ".git"))) {
      await initAndCommit(dir, "checkpoint — generated by AI SaaS Factory");
    } else {
      await commitAll(dir, "checkpoint — generated by AI SaaS Factory");
    }
  } catch {
    /* checkpoint commits are best-effort */
  }
}

/** Extract the path portion of a health URL (e.g. /health) for live smoke. */
function healthPathFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).pathname || undefined;
  } catch {
    const m = url.match(/https?:\/\/[^/]+(\/.*)$/);
    return m ? m[1] : undefined;
  }
}

/** Build a PR body summarising the deterministic evidence for reviewers. */
function prBody(run: Run): string {
  const v = run.verify;
  const a = run.acceptance;
  const lines = [
    `Automated initial build by AI SaaS Factory.`,
    "",
    `> ${run.idea}`,
    "",
    "**Evidence (deterministic):**",
    v ? `- boots: ${v.booted}, health: ${v.healthOk}, tests: ${v.testsPassed ?? "n/a"}` : "- verify not run",
    a ? `- acceptance: ${a.score}/100 (${a.passed ? "PASS" : "FAIL"})` : "",
    run.deploy?.url ? `- live preview: ${run.deploy.url} (health ${run.deploy.liveHealthOk ?? "n/a"})` : "",
    "",
    "See `RUN_REPORT.md` for the full audit trail.",
  ].filter(Boolean);
  return lines.join("\n");
}
