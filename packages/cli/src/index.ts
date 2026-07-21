#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Command } from "commander";
import pc from "picocolors";
import { Factory, runDoctor, type FactoryEvent, type Run, type StageName } from "@ai-saas-factory/core";

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  return rl.question(question).finally(() => rl.close());
}

/** Commander collector for repeatable options (e.g. --ref a --ref b). */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/** Resolve an operate target string into a project id, repo, or local path. */
function resolveTarget(factory: Factory, target: string): { projectId?: string; repoUrl?: string; workingDir?: string } {
  if (factory.projects.get(target)) return { projectId: target };
  if (/^[\w.-]+\/[\w.-]+$/.test(target)) return { repoUrl: target };
  return { workingDir: target };
}

/** Pretty-print factory events to the terminal and drive interactive gates. */
function attachPrinter(factory: Factory, opts: { autoApprove: boolean }): void {
  factory.bus.subscribe((e: FactoryEvent) => {
    switch (e.type) {
      case "stage.start":
        stdout.write(pc.bold(pc.cyan(`\n▶ ${e.stage}\n`)));
        break;
      case "stage.end":
        stdout.write(pc.green(`✓ ${e.stage}${e.data && (e.data as { summary?: string }).summary ? pc.dim(` — ${(e.data as { summary?: string }).summary}`) : ""}\n`));
        break;
      case "task.start":
        stdout.write(pc.dim(`  · ${e.message}\n`));
        break;
      case "task.end":
        stdout.write((e.level === "error" ? pc.red : pc.dim)(`  ${e.level === "error" ? "✗" : "•"} ${e.message}\n`));
        break;
      case "agent.tool":
        stdout.write(pc.dim(pc.magenta(`    ${e.message}\n`)));
        break;
      case "security.report":
        stdout.write(pc.yellow(`  🔒 ${e.message}\n`));
        break;
      case "discovery.report":
        stdout.write(pc.cyan(`  🔎 discovery — ${e.message}\n`));
        break;
      case "compliance.report":
        stdout.write((e.level === "warn" ? pc.yellow : pc.green)(`  📋 ${e.message}\n`));
        break;
      case "verify.report":
        stdout.write((e.level === "warn" ? pc.yellow : pc.green)(`  🚀 verify: ${e.message}\n`));
        break;
      case "acceptance.report":
        stdout.write((e.level === "warn" ? pc.yellow : pc.green)(pc.bold(`  🏁 ${e.message}\n`)));
        break;
      case "log":
        stdout.write((e.level === "error" ? pc.red : e.level === "warn" ? pc.yellow : pc.dim)(`  ${e.message}\n`));
        break;
      case "stage.awaiting_approval":
        void handleGate(factory, e.runId, e.stage as StageName, opts.autoApprove);
        break;
      case "run.done":
        stdout.write((e.level === "error" ? pc.red : e.level === "warn" ? pc.yellow : pc.green)(pc.bold(`\n${e.message}\n`)));
        break;
      default:
        break;
    }
  });
}

async function handleGate(factory: Factory, runId: string, stage: StageName, autoApprove: boolean): Promise<void> {
  const run = factory.getRun(runId);
  if (stage === "requirements" && run?.requirements) {
    const r = run.requirements;
    stdout.write(pc.bold(`\n── Requirements for "${r.name}" ──\n`));
    stdout.write(`${pc.dim(r.summary)}\n`);
    stdout.write(pc.bold("Features:\n") + r.coreFeatures.map((f) => `  - ${f}`).join("\n") + "\n");
    if (r.featureParity && r.featureParity.length) {
      stdout.write(pc.bold(pc.cyan("Parity checklist (from references):\n")) + r.featureParity.map((f) => `  ✓ ${f}`).join("\n") + "\n");
    }
    if (r.openQuestions.length) stdout.write(pc.yellow("Open questions:\n") + r.openQuestions.map((q) => `  ? ${q}`).join("\n") + "\n");
    if (r.complianceProfiles && r.complianceProfiles.length) {
      stdout.write(pc.bold(pc.cyan("Compliance profiles: ")) + r.complianceProfiles.join(", ") + pc.dim(` (${(r.complianceControls ?? []).length} controls)\n`));
    }
    if (r.wowFeatures && r.wowFeatures.length) {
      const selected = new Set(r.wowSelected ?? []);
      stdout.write(pc.bold(pc.magenta("\n✨ Proposed 'wow' features (differentiators peers lack):\n")));
      r.wowFeatures.forEach((w, i) => {
        const mark = selected.has(w.id) ? pc.green("[x]") : pc.dim("[ ]");
        stdout.write(`  ${mark} ${pc.bold(String(i + 1))}. ${w.title} ${pc.dim(`(impact:${w.impact}/effort:${w.effort})`)}\n      ${pc.dim(w.description)}\n`);
      });
      stdout.write(pc.dim(`  pre-selected: ${[...selected].join(", ") || "none"}\n`));
    }
  }
  if (stage === "release" && run) {
    stdout.write(pc.bold(`\n── Ready to publish "${run.requirements?.slug}" to GitHub (${factory.config.repoVisibility}) ──\n`));
  }

  if (autoApprove) {
    stdout.write(pc.green(`  auto-approving gate: ${stage}\n`));
    factory.resolveGate(runId, stage, { decision: "approve" });
    return;
  }

  const prompt = stage === "requirements"
    ? pc.bold(`\nGate [${stage}] — [a]pprove / [w] choose wow features / [r]evise / [x] reject? `)
    : pc.bold(`\nGate [${stage}] — [a]pprove / [x] reject? `);
  const answer = (await ask(prompt)).trim().toLowerCase();
  if (answer === "x" || answer === "reject") {
    factory.resolveGate(runId, stage, { decision: "reject" });
  } else if ((answer === "r" || answer === "revise") && stage === "requirements") {
    const notes = await ask("Revision notes: ");
    factory.resolveGate(runId, stage, { decision: "revise", notes });
  } else if (answer === "w" && stage === "requirements" && run?.requirements?.wowFeatures?.length) {
    const wow = run.requirements.wowFeatures;
    const raw = (await ask("Wow features to include — numbers (e.g. 1,3), 'all', or 'none': ")).trim().toLowerCase();
    let wowSelected: string[];
    if (raw === "all") wowSelected = wow.map((w) => w.id);
    else if (raw === "none" || raw === "") wowSelected = [];
    else wowSelected = raw.split(/[,\s]+/).map((n) => wow[Number(n) - 1]?.id).filter((x): x is string => !!x);
    factory.resolveGate(runId, stage, { decision: "approve", wowSelected });
  } else {
    factory.resolveGate(runId, stage, { decision: "approve" });
  }
}

function statusColor(status: Run["status"]): (s: string) => string {
  switch (status) {
    case "completed":
      return pc.green;
    case "failed":
      return pc.red;
    case "cancelled":
      return pc.yellow;
    case "awaiting_approval":
      return pc.magenta;
    default:
      return pc.cyan;
  }
}

const program = new Command();
program.name("factory").description("Local AI multi-agent factory for building & shipping SaaS apps").version("0.1.0");

program
  .command("doctor")
  .description("Check environment prerequisites")
  .action(async () => {
    const results = await runDoctor();
    let missingRequired = 0;
    for (const r of results) {
      const mark = r.ok ? pc.green("✓") : r.required ? pc.red("✗") : pc.yellow("○");
      stdout.write(`${mark} ${r.name.padEnd(28)} ${pc.dim(r.detail)}\n`);
      if (!r.ok) {
        if (r.required) missingRequired++;
        if (r.hint) stdout.write(pc.dim(`    ↳ ${r.hint}\n`));
      }
    }
    stdout.write(missingRequired === 0 ? pc.green("\nEnvironment ready.\n") : pc.red(`\n${missingRequired} required check(s) failed.\n`));
    process.exit(missingRequired === 0 ? 0 : 1);
  });

program
  .command("new")
  .description("Create and run a new SaaS build from an idea")
  .argument("<idea...>", "the SaaS idea to build")
  .option("-s, --stack <id>", "stack id (see config/stack-defaults.json)")
  .option("-r, --ref <url>", "URL of a comparable app to reach feature parity with (repeatable)", collect, [])
  .option("-c, --compliance <profiles>", "comma-separated compliance profiles (pci-dss,hipaa,soc2,gdpr,iso27001)")
  .option("--scale <tier>", "deployment scale profile: startup | growth | scale")
  .option("--saas <caps>", "business-layer capabilities: billing,multitenancy,growth,support,deepQa,provenance,continuousDelivery")
  .option("-y, --yes", "auto-approve all gates (fully autonomous)", false)
  .action(async (ideaParts: string[], opts: { stack?: string; ref?: string[]; compliance?: string; scale?: string; saas?: string; yes?: boolean }) => {
    const idea = ideaParts.join(" ");
    const factory = new Factory();
    attachPrinter(factory, { autoApprove: !!opts.yes });
    const refs = opts.ref ?? [];
    const compliance = (opts.compliance ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const saas = (opts.saas ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const scale = opts.scale ?? factory.config.scaleDefault;
    stdout.write(
      pc.bold(`\nAI SaaS Factory\n`) +
        pc.dim(`idea: ${idea}\nstack: ${opts.stack ?? factory.config.stacks.default}\nscale: ${scale}\n${refs.length ? `references: ${refs.join(", ")}\n` : ""}${compliance.length ? `compliance: ${compliance.join(", ")}\n` : ""}${saas.length ? `saas: ${saas.join(", ")}\n` : ""}`),
    );
    const run = await factory.build(idea, opts.stack, refs, compliance, scale, saas);
    if (run.repoUrl) stdout.write(pc.green(pc.bold(`\nRepository: ${run.repoUrl}\n`)));
    if (run.acceptance) stdout.write(pc.bold(`acceptance: ${run.acceptance.score}/100\n`));
    if (run.cost) stdout.write(pc.dim(`cost: ~$${run.cost.estimatedUsd.toFixed(2)} (${run.cost.totalTokens} tokens, ${run.cost.taskCount} tasks)\n`));
    stdout.write(pc.dim(`workspace: ${run.workingDir}\nrun id: ${run.id}\n`));
    process.exit(run.status === "completed" ? 0 : 1);
  });

program
  .command("resume")
  .description("Resume an interrupted run (skips completed stages)")
  .argument("<id>", "run id")
  .option("-y, --yes", "auto-approve all gates", false)
  .action(async (id: string, opts: { yes?: boolean }) => {
    const factory = new Factory();
    attachPrinter(factory, { autoApprove: !!opts.yes });
    const run = await factory.resume(id);
    stdout.write(pc.dim(`\nrun ${run.id}: ${run.status}\n`));
    process.exit(run.status === "completed" ? 0 : 1);
  });

program
  .command("iterate")
  .description("Apply a follow-up change to an existing run and push it")
  .argument("<id>", "run id")
  .argument("<instruction...>", "the change to make")
  .action(async (id: string, parts: string[]) => {
    const factory = new Factory();
    attachPrinter(factory, { autoApprove: true });
    const run = await factory.iterate(id, parts.join(" "));
    stdout.write(pc.dim(`\nrun ${run.id}: ${run.status}\n`));
    process.exit(run.status === "completed" ? 0 : 1);
  });

program
  .command("list")
  .description("List recent runs")
  .action(() => {
    const factory = new Factory();
    const runs = factory.listRuns();
    if (runs.length === 0) {
      stdout.write(pc.dim("no runs yet\n"));
      return;
    }
    for (const r of runs.slice(0, 25)) {
      stdout.write(`${statusColor(r.status)(r.status.padEnd(18))} ${pc.bold(r.id)} ${pc.dim(r.createdAt)} ${r.idea.slice(0, 60)}\n`);
    }
  });

program
  .command("status")
  .description("Show a run's stage status")
  .argument("<id>", "run id")
  .action((id: string) => {
    const factory = new Factory();
    const run = factory.getRun(id);
    if (!run) {
      stdout.write(pc.red(`run ${id} not found\n`));
      process.exit(1);
    }
    stdout.write(pc.bold(`\nRun ${run.id} — ${statusColor(run.status)(run.status)}\n`) + pc.dim(`${run.idea}\n\n`));
    stdout.write(pc.dim(`stack: ${run.stack}${run.scale ? `  ·  scale: ${run.scale}` : ""}\n\n`));
    for (const s of run.stages) {
      const mark = s.status === "completed" ? pc.green("✓") : s.status === "failed" ? pc.red("✗") : s.status === "running" ? pc.cyan("▶") : s.status === "awaiting_approval" ? pc.magenta("⏸") : pc.dim("·");
      stdout.write(`  ${mark} ${s.name.padEnd(14)} ${pc.dim(s.status)}${s.summary ? pc.dim(` — ${s.summary.slice(0, 60)}`) : ""}\n`);
    }
    if (run.complianceProfiles?.length) stdout.write(pc.dim(`\ncompliance: ${run.complianceProfiles.join(", ")}`) + (run.compliance ? pc.dim(` — ${run.compliance.met} met / ${run.compliance.partial} partial / ${run.compliance.gap} gap`) : "") + "\n");
    if (run.verify) stdout.write(pc.dim(`verify: booted=${run.verify.booted}, health=${run.verify.healthOk}, smoke=${run.verify.smokePassed}\n`));
    if (run.acceptance) stdout.write(pc.bold(`acceptance: ${run.acceptance.score}/100${run.acceptance.passed ? " ✓" : ""}\n`));
    if (run.cost) stdout.write(pc.dim(`cost: ~$${run.cost.estimatedUsd.toFixed(2)} (${run.cost.totalTokens} tokens)\n`));
    if (run.repoUrl) stdout.write(pc.green(`\n${run.repoUrl}\n`));
  });

program
  .command("approve")
  .description("Resolve a pending approval gate for a run")
  .argument("<id>", "run id")
  .argument("<stage>", "stage name (requirements|release)")
  .option("--reject", "reject and cancel the run", false)
  .option("--revise <notes>", "send the stage back for revision with notes")
  .action((id: string, stage: string, opts: { reject?: boolean; revise?: string }) => {
    const factory = new Factory();
    const decision = opts.reject ? "reject" : opts.revise ? "revise" : "approve";
    const ok = factory.resolveGate(id, stage as StageName, { decision, notes: opts.revise });
    stdout.write(ok ? pc.green(`gate ${stage} for run ${id}: ${decision}\n`) : pc.red(`no pending gate for run ${id} at stage ${stage} (is the run active in this process?)\n`));
    if (!ok) stdout.write(pc.dim("Note: gates are resolved in the process running the build. Use the web dashboard for cross-process approvals.\n"));
  });

program
  .command("operate")
  .description("Operate on an existing repo: fix a bug, self-heal (beta), or ship a feature")
  .argument("<target>", "GitHub repo (owner/name), a registered project id, or a local path")
  .argument("<task...>", "bug report / incident signals / feature description")
  .option("-k, --kind <kind>", "fix | heal | feature", "fix")
  .option("--pr", "open a pull request instead of pushing to main", false)
  .action(async (target: string, parts: string[], opts: { kind?: string; pr?: boolean }) => {
    const factory = new Factory();
    attachPrinter(factory, { autoApprove: true });
    const kind = (opts.kind ?? "fix") as "fix" | "heal" | "feature";
    const resolved = resolveTarget(factory, target);
    const run = await factory.operate(resolved, kind, parts.join(" "), { prMode: !!opts.pr });
    if (run.repoUrl) stdout.write(pc.green(pc.bold(`\n${run.repoUrl}\n`)));
    stdout.write(pc.dim(`\nrun ${run.id}: ${run.status}\n`));
    process.exit(run.status === "completed" ? 0 : 1);
  });

program
  .command("fix")
  .description("Bug intake from a GitHub issue: reproduce, fix, open a PR")
  .argument("<repo>", "GitHub repo (owner/name)")
  .argument("<issue>", "issue number")
  .option("--no-pr", "push to main instead of opening a PR")
  .action(async (repo: string, issue: string, opts: { pr?: boolean }) => {
    const factory = new Factory();
    attachPrinter(factory, { autoApprove: true });
    const run = await factory.fixIssue(repo, Number(issue), { prMode: opts.pr !== false });
    if (run.repoUrl) stdout.write(pc.green(pc.bold(`\n${run.repoUrl}\n`)));
    stdout.write(pc.dim(`\nrun ${run.id}: ${run.status}\n`));
    process.exit(run.status === "completed" ? 0 : 1);
  });

program
  .command("estimate")
  .description("Estimate an idea's effort/cost/timeline without building (beta)")
  .argument("<idea...>", "the SaaS idea to scope")
  .option("-s, --stack <id>", "stack id")
  .action(async (parts: string[], opts: { stack?: string }) => {
    const factory = new Factory();
    attachPrinter(factory, { autoApprove: true });
    const { estimate } = await factory.estimate(parts.join(" "), opts.stack);
    stdout.write(pc.bold("\nEstimate:\n") + JSON.stringify(estimate, null, 2) + "\n");
  });

program
  .command("projects")
  .description("List, register, or add backlog items to durable projects")
  .argument("[action]", "list | register | backlog", "list")
  .option("-n, --name <name>", "project name (register)")
  .option("-r, --repo <owner/name>", "GitHub repo to clone (register)")
  .option("-s, --stack <id>", "stack id (register)")
  .option("-p, --project <id>", "project id (backlog)")
  .option("-t, --title <title>", "backlog item title (backlog)")
  .action(async (action: string, opts: { name?: string; repo?: string; stack?: string; project?: string; title?: string }) => {
    const factory = new Factory();
    if (action === "register") {
      if (!opts.name) { stdout.write(pc.red("--name is required\n")); process.exit(1); }
      const project = await factory.registerProject({ name: opts.name, ...(opts.repo ? { repoUrl: opts.repo } : {}), ...(opts.stack ? { stack: opts.stack } : {}) });
      stdout.write(pc.green(`registered project ${project.id} (${project.name}) at ${project.workingDir}\n`));
      return;
    }
    if (action === "backlog") {
      if (!opts.project || !opts.title) { stdout.write(pc.red("--project and --title are required\n")); process.exit(1); }
      const item = factory.projects.addBacklogItem(opts.project, opts.title);
      stdout.write(item ? pc.green(`added backlog item ${item.id}\n`) : pc.red("project not found\n"));
      return;
    }
    const projects = factory.projects.list();
    if (projects.length === 0) { stdout.write(pc.dim("no projects yet — `factory projects register --name <n> --repo <owner/name>`\n")); return; }
    for (const p of projects) {
      const todo = p.backlog.filter((b) => b.status === "todo").length;
      stdout.write(`${pc.bold(p.id)} ${p.name.padEnd(24)} ${pc.dim(p.stack)} ${pc.dim(p.repoUrl ?? "(local)")} ${pc.cyan(`${todo} todo`)}\n`);
    }
  });

program
  .command("sprint")
  .description("Plan and ship the top backlog items of a project as a sprint (beta)")
  .argument("<projectId>", "project id")
  .option("-m, --max <n>", "max items to ship")
  .option("--pr", "open PRs instead of pushing", false)
  .action(async (projectId: string, opts: { max?: string; pr?: boolean }) => {
    const factory = new Factory();
    attachPrinter(factory, { autoApprove: true });
    const { plan, runs } = await factory.sprint(projectId, { ...(opts.max ? { max: Number(opts.max) } : {}), prMode: !!opts.pr });
    stdout.write(pc.bold("\nSprint plan:\n") + JSON.stringify(plan, null, 2) + "\n");
    stdout.write(pc.dim(`\nshipped ${runs.filter((r) => r.status === "completed").length}/${runs.length} item(s)\n`));
  });

program
  .command("evals")
  .description("Show the evaluation corpus aggregate and recent runs")
  .action(() => {
    const factory = new Factory();
    const store = factory.orchestrator.evalStore();
    const all = store.all();
    if (all.length === 0) { stdout.write(pc.dim("no eval records yet\n")); return; }
    const agg = store.aggregate();
    stdout.write(pc.bold("\nEval corpus\n"));
    stdout.write(pc.dim(`runs: ${agg.count}  ·  pass: ${(agg.passRate * 100).toFixed(0)}%  ·  avg acceptance: ${agg.avgAcceptance.toFixed(0)}  ·  security pass: ${(agg.securityPassRate * 100).toFixed(0)}%  ·  avg cost: $${agg.avgCostUsd.toFixed(2)}\n\n`));
    for (const r of all.slice(-15).reverse()) {
      stdout.write(`${statusColor(r.status)(r.status.padEnd(12))} ${pc.bold(r.runId)} ${pc.dim(r.mode.padEnd(8))} ${r.acceptance != null ? `acc ${String(r.acceptance).padStart(3)}` : "acc   -"} ${r.costUsd != null ? pc.dim(`$${r.costUsd.toFixed(2)}`) : ""} ${pc.dim(r.idea.slice(0, 40))}\n`);
    }
  });

program
  .command("worker")
  .description("Drain the job queue (run in N terminals/containers for scale)")
  .option("--once", "process a single job then exit", false)
  .action(async (opts: { once?: boolean }) => {
    const factory = new Factory();
    attachPrinter(factory, { autoApprove: true });
    stdout.write(pc.bold("factory worker started — polling job queue\n"));
    if (opts.once) {
      const job = await factory.processNextJob();
      stdout.write(job ? pc.dim(`job ${job.id} (${job.kind}): ${job.status}\n`) : pc.dim("no queued jobs\n"));
      return;
    }
    for (;;) {
      const job = await factory.processNextJob();
      if (job) stdout.write(pc.dim(`job ${job.id} (${job.kind}): ${job.status}\n`));
      else await new Promise((r) => setTimeout(r, 2000));
    }
  });

program
  .command("serve")
  .description("Start the local web dashboard")
  .action(async () => {
    const { startServer } = await import("@ai-saas-factory/web");
    await startServer();
  });

program.parseAsync(process.argv);
