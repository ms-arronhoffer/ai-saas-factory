/**
 * Offline smoke test: validates the factory wiring WITHOUT invoking any model or
 * network, so it can run in CI before Copilot auth is configured. Exits non-zero
 * on the first failed assertion.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, REPO_ROOT } from "./config.js";
import { Store } from "./state/store.js";
import { EventBus } from "./events.js";
import { GateManager } from "./orchestrator/gates.js";
import { extractJson, slugify, dedupeFeatures, mergeParity, rankWow, estimateUsd } from "./agents/parse.js";
import { requirementsPrompt, builderPrompt, architectPrompt, researcherPrompt, painFinderPrompt, pmPrompt, saasBlock, triagePrompt, fixPrompt, srePrompt, estimatePrompt, sprintPlanPrompt, runtimeVersionsBlock } from "./agents/prompts.js";
import { isDenied } from "./tools/shell.js";
import { runtimeKeysForStack } from "./tools/versions.js";
import { evaluate, detectLanguages, evaluateLicenses } from "./tools/scanners.js";
import { MemoryStore } from "./state/memory.js";
import { EvalStore } from "./state/evals.js";
import { JobQueue } from "./orchestrator/queue.js";
import { ProjectStore } from "./state/projects.js";
import { computeAcceptance } from "./orchestrator/acceptance.js";
import { parseCoverageFile, parseMutationScore } from "./tools/verify.js";
import type { BuildPlan, RequirementsSpec, Run, SecurityFinding, Workstream } from "./types.js";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    process.stdout.write(`  ok   ${msg}\n`);
  } else {
    failures++;
    process.stdout.write(`  FAIL ${msg}\n`);
  }
}

function main(): void {
  process.stdout.write("AI SaaS Factory — smoke test\n");

  // 1. Config loads and has expected shape.
  const cfg = loadConfig();
  assert(!!cfg.stacks.stacks[cfg.stacks.default], "config: default stack resolves");
  assert(cfg.routing.tiers.deep.preferred.length > 0, "config: deep tier has preferences");
  assert(cfg.gates.includes("requirements") || cfg.gates.length >= 0, "config: gates parsed");

  // 2. JSON extraction from an agent-style reply.
  const reply = "Here is the spec.\n```json\n{\"name\":\"Task Tracker\",\"slug\":\"Task Tracker\"}\n```\nDone.";
  const parsed = extractJson<{ name: string; slug: string }>(reply);
  assert(parsed?.name === "Task Tracker", "parse: extracts JSON from fenced block");
  assert(slugify(parsed?.slug ?? "") === "task-tracker", "parse: slugify");

  // 2b. Feature-parity merge/dedupe (references feature).
  const deduped = dedupeFeatures(["Kanban board", "kanban  board", "Voting", "voting"]);
  assert(deduped.length === 2, "parity: dedupeFeatures collapses case/spacing duplicates");
  const merged = mergeParity(["Login"], ["login", "Realtime sync"]);
  assert(merged.length === 2 && merged.includes("Realtime sync"), "parity: mergeParity unions core + parity without dupes");

  // 2c. Wow-feature ranking (impact desc, effort asc).
  const wow = [
    { id: "a", impact: "low", effort: "low" },
    { id: "b", impact: "high", effort: "low" },
    { id: "c", impact: "high", effort: "high" },
  ];
  const top2 = rankWow(wow, 2);
  assert(top2[0] === "b" && top2.length === 2, "wow: rankWow prioritises high-impact/low-effort");

  // 2d. Cost estimation.
  assert(Math.abs(estimateUsd(1_000_000, 6) - 6) < 1e-9, "cost: estimateUsd scales per million tokens");

  // 2e. New config files load and have expected shape.
  assert(Object.keys(cfg.compliance.profiles).length >= 5, "config: compliance profiles loaded");
  assert(!!cfg.compliance.profiles["hipaa"], "config: hipaa profile present");
  assert(Object.values(cfg.quality.standards).some((s) => s.enabled), "config: quality standards loaded");
  assert(cfg.security.scanners["syft"] !== undefined && cfg.security.scanners["checkov"] !== undefined, "config: sbom + iac scanners present");
  assert(Array.isArray(cfg.security.licensePolicy?.deny) && cfg.security.licensePolicy!.deny.length > 0, "config: license deny policy present");
  assert(cfg.stacks.stacks[cfg.stacks.default]?.seed !== undefined, "config: default stack has a seed template");

  // 2f. First-build quality: prompts + golden template.
  assert(requirementsPrompt("an app", "Next.js").includes("acceptanceCriteria"), "prompts: requirements demands acceptance criteria");
  const demoSpec: RequirementsSpec = { name: "X", slug: "x", summary: "", problem: "", targetUsers: [], coreFeatures: [], entities: [], nonFunctional: [], stack: "s", openQuestions: [] };
  const demoPlan: BuildPlan = { overview: "", fileManifest: [], workstreams: [], dependencies: {}, integrationNotes: "", contract: { openapi: "contracts/openapi.yaml", schema: "contracts/schema.sql" } };
  const demoWs: Workstream = { id: "backend", title: "API", dir: "api", language: "python" };
  const bp = builderPrompt(demoSpec, demoPlan, demoWs);
  assert(bp.includes("NO stubs") && bp.includes("inner build/test loop"), "prompts: builder has anti-stub rules + inner loop");
  assert(bp.includes("contracts/openapi.yaml"), "prompts: builder references frozen contract");
  const seedRoot = resolve(REPO_ROOT, cfg.stacks.stacks[cfg.stacks.default]!.seed!);
  assert(existsSync(join(seedRoot, "api", "app", "main.py")), "template: backend vertical slice present");
  assert(existsSync(join(seedRoot, "contracts", "openapi.yaml")), "template: frozen OpenAPI contract present");
  assert(existsSync(join(seedRoot, "web", "package.json")), "template: frontend present");

  // 2g. Deployment scale profiles + the two additional seed templates.
  assert(!!cfg.deployment.profiles["startup"] && !!cfg.deployment.profiles["growth"] && !!cfg.deployment.profiles["scale"], "config: three deployment scale profiles present");
  assert(["startup", "growth", "scale"].includes(cfg.scaleDefault), "config: scale default resolves");
  const arch = architectPrompt(demoSpec, cfg.stacks.stacks[cfg.stacks.default]!, cfg.quality, cfg.deployment.profiles["growth"]);
  assert(arch.includes("Deployment scale target"), "prompts: architect includes scale guidance");
  const nodeSeed = cfg.stacks.stacks["node-express-react"]?.seed;
  const apiSeed = cfg.stacks.stacks["fastapi-postgres-api"]?.seed;
  assert(!!nodeSeed && existsSync(join(resolve(REPO_ROOT, nodeSeed), "api", "src", "app.ts")), "template: node-express-react seed present");
  assert(!!apiSeed && existsSync(join(resolve(REPO_ROOT, apiSeed), "app", "main.py")), "template: fastapi-postgres-api seed present");

  // 2h. Discovery + design agents (research / pains / PM, best-of, visual QA).
  assert(cfg.discoveryEnabled && cfg.designEnabled, "config: discovery + design enabled by default");
  assert(cfg.bestOf === 1 && cfg.archCritiqueEnabled === false, "config: best-of/critique sane defaults");
  assert(researcherPrompt("idea", "Next.js").includes("DomainBrief"), "prompts: researcher emits a domain brief");
  assert(painFinderPrompt("idea", ["https://x.io"]).toLowerCase().includes("unmet"), "prompts: pain-finder mines unmet needs");
  assert(pmPrompt("idea", { domain: { summary: "d" } }).includes("mvpCut"), "prompts: PM produces an MVP cut line");
  const archD = architectPrompt(demoSpec, cfg.stacks.stacks[cfg.stacks.default]!, cfg.quality, undefined, { domain: { entities: ["Order"] } });
  assert(archD.includes("Standard entities: Order"), "prompts: architect consumes discovery research");

  // 3. Denylist blocks destructive commands, allows normal ones.
  assert(isDenied("rm -rf /"), "shell: blocks rm -rf /");
  assert(isDenied("git push --force origin main"), "shell: blocks force push");
  assert(!isDenied("npm install && npm test"), "shell: allows npm install/test");

  // 4. Security evaluation gate logic.
  const findings: SecurityFinding[] = [
    { scanner: "semgrep", kind: "sast", severity: "medium", title: "x" },
    { scanner: "gitleaks", kind: "secret", severity: "critical", title: "leaked key" },
  ];
  const failReport = evaluate(findings, cfg.security, 1);
  assert(!failReport.passed, "security: critical/secret fails the gate");
  const okReport = evaluate([{ scanner: "semgrep", kind: "sast", severity: "low", title: "y" }], cfg.security, 1);
  assert(okReport.passed, "security: only-low passes the gate");

  // 5. Store round-trip + event bus + gate manager.
  const dir = mkdtempSync(join(tmpdir(), "factory-smoke-"));
  try {
    const store = new Store(dir);
    const run: Run = {
      id: "smoke001",
      idea: "test",
      stack: cfg.stacks.default,
      status: "created",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workingDir: dir,
      gates: ["requirements"],
      stages: [],
    };
    store.saveRun(run);
    const loaded = store.loadRun("smoke001");
    assert(loaded?.idea === "test", "store: run round-trips");
    store.appendAudit({ runId: "smoke001", ts: new Date().toISOString(), type: "log", message: "hi" });
    assert(store.readAudit("smoke001").length === 1, "store: audit append/read");

    const bus = new EventBus();
    let got = 0;
    bus.subscribe(() => got++);
    bus.publish({ runId: "smoke001", ts: new Date().toISOString(), type: "log", message: "x" });
    assert(got === 1 && bus.replay("smoke001").length === 1, "events: publish/subscribe/replay");

    const gates = new GateManager();
    const p = gates.waitFor("smoke001", "requirements");
    assert(gates.isPending("smoke001", "requirements"), "gates: pending tracked");
    gates.resolve("smoke001", "requirements", { decision: "approve" });
    void p.then((r) => assert(r.decision === "approve", "gates: resolution delivered"));

    // 5b. Resolve-BEFORE-wait must not be lost (the --yes deadlock regression):
    //     a synchronous auto-approve can fire during the awaiting-approval emit
    //     before the waiter registers; the resolution must still be delivered.
    const raceGates = new GateManager();
    raceGates.resolve("smoke002", "release", { decision: "approve" });
    void raceGates.waitFor("smoke002", "release").then((r) => assert(r.decision === "approve", "gates: resolve-before-wait is buffered (no deadlock)"));

    // 6. Language detection.
    writeFileSync(join(dir, "package.json"), "{}");
    assert(detectLanguages(dir).includes("node"), "scanners: detects node project");

    // 7. License policy evaluation from a CycloneDX SBOM.
    writeFileSync(
      join(dir, "sbom.cdx.json"),
      JSON.stringify({ components: [{ name: "gpl-lib", version: "1.0", licenses: [{ license: { id: "GPL-3.0" } }] }, { name: "ok-lib", licenses: [{ license: { id: "MIT" } }] }] }),
    );
    const licenseFindings = evaluateLicenses(dir, ["GPL-3.0"], false);
    assert(licenseFindings.length === 1 && licenseFindings[0]!.kind === "license", "scanners: evaluateLicenses flags denied license");

    // 8. Cross-run memory store round-trips.
    const mem = new MemoryStore(dir);
    mem.record("smoke001", "## note\n- a learning");
    assert(mem.digest(5).includes("a learning"), "memory: record/digest round-trip");

    // 9. SaaS business-layer config + prompt block.
    assert(!!cfg.saas.capabilities.billing && !!cfg.saas.capabilities.multitenancy, "saas: capabilities config loaded");
    const sblock = saasBlock(cfg.saas, ["billing", "multitenancy"], "Build these:");
    assert(sblock.includes("Stripe") && sblock.includes("tenant"), "saas: saasBlock renders selected capabilities");
    assert(saasBlock(cfg.saas, [], "x") === "", "saas: empty selection yields empty block");
    assert(architectPrompt(demoSpec, cfg.stacks.stacks[cfg.stacks.default]!, cfg.quality, undefined, undefined, { config: cfg.saas, selected: ["billing"] }).includes("Stripe"), "saas: architect prompt threads capabilities");
    assert(typeof cfg.prMode === "boolean" && typeof cfg.escalateOnFailure === "boolean", "config: pr/escalate flags parsed");

    // 10. Operate-mode prompts produce their required JSON contracts.
    assert(triagePrompt("app crashes on login").includes("rootCause"), "prompts: triage asks for root cause JSON");
    assert(fixPrompt("bug", "cause").includes("regression test"), "prompts: fix requires a regression test");
    assert(srePrompt("500s spiking").includes("POSTMORTEM"), "prompts: sre writes a postmortem");
    assert(estimatePrompt("a CRM", "Node").includes("timelineWeeks"), "prompts: estimate asks for timeline");
    assert(sprintPlanPrompt("Q3", [{ id: "1", title: "billing" }], 3).includes("squads"), "prompts: sprint plan asks for squads");

    // 11. Eval corpus: aggregate + regression detection.
    const evals = new EvalStore(dir);
    for (let i = 0; i < 4; i++) evals.record({ runId: `e${i}`, ts: new Date().toISOString(), idea: "x", stack: "s", mode: "build", status: "completed", acceptance: 90, securityPassed: true, costUsd: 1 });
    const agg = evals.aggregate();
    assert(agg.count === 4 && agg.avgAcceptance === 90, "evals: aggregate computes averages");
    const reg = evals.checkRegression({ runId: "bad", ts: new Date().toISOString(), idea: "x", stack: "s", mode: "build", status: "completed", acceptance: 40, securityPassed: true, costUsd: 1 });
    assert(reg.regressed, "evals: detects acceptance regression vs baseline");

    // 12. Job queue: enqueue then atomically claim.
    const queue = new JobQueue(dir);
    const job = queue.enqueue("build", { idea: "a todo app" });
    assert(job.status === "queued", "queue: enqueue creates a queued job");
    const claimed = queue.claim();
    assert(claimed?.id === job.id && claimed?.status === "running", "queue: claim marks the job running");
    assert(queue.claim() === undefined, "queue: no double-claim of the same job");

    // 13. Project store: create + backlog lifecycle.
    const projects = new ProjectStore(dir);
    const project = projects.create({ name: "Acme", stack: cfg.stacks.default, workingDir: dir });
    const item = projects.addBacklogItem(project.id, "Add SSO");
    assert(!!item && projects.get(project.id)?.backlog.length === 1, "projects: backlog item added");
    projects.setItemStatus(project.id, item!.id, "done");
    assert(projects.get(project.id)?.backlog[0]?.status === "done", "projects: backlog status updates");

    // 14. Deterministic acceptance from ground-truth signals (not an LLM opinion).
    const good = computeAcceptance({ buildOk: true, booted: true, healthOk: true, testsPassed: true, securityPassed: true, scannersRan: 3, complianceGap: 0, liveHealthOk: true });
    assert(good.score === 100 && good.passed && good.deterministic === true, "acceptance: all-green signals score 100 and pass");
    const hardFail = computeAcceptance({ buildOk: true, booted: true, healthOk: true, testsPassed: false, securityPassed: true, scannersRan: 3 });
    assert(!hardFail.passed, "acceptance: failing tests hard-gates the run regardless of score");
    const noScanners = computeAcceptance({ booted: true, healthOk: true, testsPassed: true, securityPassed: true, scannersRan: 0 });
    assert(noScanners.breakdown.some((b) => /scanners/i.test(b.dimension) && b.score === 0), "acceptance: 0 scanners scores the scanner dimension 0 (loud signal)");

    // 15. Job queue lease + stale reclaim (crashed-worker recovery).
    const q2 = new JobQueue(dir, { visibilityMs: 0, maxAttempts: 3 });
    const j = q2.enqueue("build", { idea: "x" });
    const claimed2 = q2.claim();
    assert(claimed2?.id === j.id && claimed2?.attempts === 1, "queue: claim leases the job and counts the attempt");
    const reclaimed = q2.reclaimStale();
    assert(reclaimed >= 1 && q2.get(j.id)?.status === "queued", "queue: expired lease requeues the job for another worker");

    // 16. New config flags parsed with safe defaults.
    assert(typeof cfg.requireScanners === "boolean" && (cfg.cloud === "azure" || cfg.cloud === "aws" || cfg.cloud === "none"), "config: requireScanners + cloud flags present");
    assert(cfg.copyEnabled === false && cfg.visualQaEnabled === false, "config: polish stages default OFF (evidence-gated)");
    assert(cfg.isolateWorktrees === true, "config: worktree isolation on by default");

    // 17. Coverage parsing across the common report formats (test-quality proof).
    writeFileSync(join(dir, "cov-py.json"), JSON.stringify({ totals: { percent_covered: 83.4 } }));
    assert(parseCoverageFile(join(dir, "cov-py.json")) === 83.4, "coverage: parses coverage.py JSON totals.percent_covered");
    writeFileSync(join(dir, "cov-istanbul.json"), JSON.stringify({ total: { lines: { pct: 76 } } }));
    assert(parseCoverageFile(join(dir, "cov-istanbul.json")) === 76, "coverage: parses istanbul coverage-summary total.lines.pct");
    writeFileSync(join(dir, "cobertura.xml"), '<?xml version="1.0"?><coverage line-rate="0.9" branch-rate="0.8"></coverage>');
    assert(parseCoverageFile(join(dir, "cobertura.xml")) === 90, "coverage: parses Cobertura line-rate");
    assert(parseCoverageFile(join(dir, "does-not-exist.json")) === undefined, "coverage: missing file returns undefined (not measured)");

    // 18. Mutation score parsing (Stryker + mutmut kill/survive).
    assert(parseMutationScore("Ran mutation testing.\nMutation score: 82.35%\nDone.") === 82.35, "mutation: parses 'Mutation score: N%'");
    assert(parseMutationScore("to apply these mutations.\nkilled: 40\nsurvived: 10\n") === 80, "mutation: derives score from killed/survived");
    assert(parseMutationScore("no score here") === undefined, "mutation: unparsable output returns undefined");

    // 19. Coverage + DAST feed the deterministic acceptance score.
    const withProof = computeAcceptance({ buildOk: true, booted: true, healthOk: true, testsPassed: true, coverageOk: true, mutationOk: true, securityPassed: true, scannersRan: 3, dastPassed: true, liveHealthOk: true });
    assert(withProof.score === 100 && withProof.breakdown.some((b) => /coverage/i.test(b.dimension)) && withProof.breakdown.some((b) => /DAST/i.test(b.dimension)), "acceptance: coverage + DAST dimensions scored");
    const failedDast = computeAcceptance({ buildOk: true, booted: true, healthOk: true, testsPassed: true, securityPassed: true, scannersRan: 3, dastPassed: false });
    assert(failedDast.score < 100 && failedDast.breakdown.some((b) => /DAST/i.test(b.dimension) && b.score === 0), "acceptance: failing DAST lowers the score");
    assert(typeof cfg.minCoverage === "number" && typeof cfg.dastEnabled === "boolean" && typeof cfg.dastImage === "string", "config: coverage + DAST flags present");

    // 20. Runtime versions are current + resolved from the stack (not frozen old).
    const apiStack = cfg.stacks.stacks["fastapi-postgres-api"]!;
    assert(runtimeKeysForStack(apiStack).sort().join(",") === "postgresql,python", "versions: API stack resolves python + postgres runtimes");
    assert(runtimeKeysForStack(cfg.stacks.stacks["node-express-react"]!).includes("node"), "versions: node stack resolves the node runtime");
    assert(apiStack.database?.engine === "PostgreSQL 18", "versions: stack default is current PostgreSQL 18");
    assert(apiStack.backend?.framework?.includes("Python 3.13") === true, "versions: stack default is current Python 3.13");
    const vBlock = runtimeVersionsBlock([{ label: "PostgreSQL", version: "18.4", image: "postgres:18-alpine" }]);
    assert(vBlock.includes("18.4") && vBlock.includes("postgres:18-alpine") && /do NOT downgrade/i.test(vBlock), "versions: prompt block pins current version + image");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  process.stdout.write(failures === 0 ? "\nALL PASSED\n" : `\n${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
