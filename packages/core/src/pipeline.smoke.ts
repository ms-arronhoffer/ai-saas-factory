/**
 * Offline PIPELINE integration test. Unlike smoke.ts (pure functions), this
 * drives the whole orchestrator end-to-end with a canned MockRuntime — no model,
 * network or GitHub — proving the stages, gates, budget, deterministic verify
 * and ground-truthed acceptance actually wire together. Exits non-zero on
 * failure so CI can gate on it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "factory-pipeline-"));
// Configure a hermetic, offline run BEFORE loading config (which caches env).
process.env.FACTORY_DATA_DIR = join(tmp, "data");
process.env.FACTORY_WORKSPACES_DIR = join(tmp, "ws");
process.env.FACTORY_OFFLINE = "true";
process.env.FACTORY_GATES = "none"; // no human gates in the test (filtered out)
process.env.FACTORY_DISCOVERY = "false";
process.env.FACTORY_DESIGN = "false";
process.env.FACTORY_VISUAL_QA = "false";
process.env.FACTORY_COPY = "false";
process.env.FACTORY_VERIFY = "false"; // no docker in CI; verify harness tested separately
process.env.FACTORY_DELIVERY = "false";
process.env.FACTORY_CLOUD = "none";
process.env.FACTORY_ARCH_CRITIQUE = "false";
process.env.FACTORY_BEST_OF = "1";
process.env.FACTORY_INTERROGATOR = "true"; // sharpen the idea before requirements
// Fast, deterministic stall guards for the offline test (real defaults are larger).
process.env.FACTORY_STALL_INACTIVITY_SECONDS = "0"; // no wall-clock in mock runs
process.env.FACTORY_STALL_LOOP_THRESHOLD = "0";
// Exercise the human-approval gates with a SYNCHRONOUS auto-approver (as the
// CLI --yes printer does) so the emit-before-wait race can never regress.
process.env.FACTORY_GATES = "requirements,release";

const { loadConfig } = await import("./config.js");
const { createLogger } = await import("./logger.js");
const { EventBus } = await import("./events.js");
const { GateManager } = await import("./orchestrator/gates.js");
const { Store } = await import("./state/store.js");
const { Orchestrator } = await import("./orchestrator/orchestrator.js");
const { MockRuntime } = await import("./testing/mock-runtime.js");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  process.stdout.write(`  ${cond ? "ok  " : "FAIL"} ${msg}\n`);
  if (!cond) failures++;
}

async function main(): Promise<void> {
  process.stdout.write("AI SaaS Factory — pipeline integration test (offline)\n");
  const config = loadConfig();
  const log = createLogger("pipeline-test");
  const bus = new EventBus();
  const gates = new GateManager();
  const store = new Store(config.dataDir);
  const runtime = new MockRuntime();
  const orch = new Orchestrator(config, runtime, store, bus, gates, log);

  // Auto-approve gates the way the CLI printer does: SYNCHRONOUSLY during the
  // awaiting-approval emit. Without the gate fix this deadlocks the run.
  let gatesResolved = 0;
  bus.subscribe((e) => {
    if (e.type === "stage.awaiting_approval" && e.stage) {
      gatesResolved++;
      gates.resolve(e.runId, e.stage, { decision: "approve" });
    }
  });

  const run = orch.createRun("A tiny task tracker");
  // Guard against a gate deadlock regression: fail loudly instead of hanging.
  // A real deadlock never resolves, so a generous window still catches it fast;
  // the headroom just absorbs slow network-bound scanners (npm-audit) in CI.
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error("pipeline timed out (gate deadlock?)")), 180_000);
    t.unref();
  });
  await Promise.race([orch.execute(run), timeout]);

  assert(run.status === "completed", `run reaches completed (got ${run.status}${run.error ? `: ${run.error}` : ""})`);
  assert(gatesResolved >= 2, `human-approval gates resolved without deadlock (got ${gatesResolved})`);
  assert(!!run.requirements && run.requirements.slug === "mock-tracker", "requirements spec parsed from agent JSON");
  assert(runtime.calledRoles.includes("interrogator"), "interrogator sharpened the idea before requirements");
  assert(!!run.plan && (run.plan.workstreams?.length ?? 0) >= 1, "architect build plan parsed");
  assert(runtime.calledRoles.includes("builder"), "builder agent was invoked");
  assert(runtime.calledRoles.includes("security"), "security stage ran");
  assert(!!run.acceptance && run.acceptance.deterministic === true, "acceptance is deterministic (ground-truthed)");
  assert(typeof run.acceptance?.signals?.scannersRan === "number", "acceptance carries scanner-count signal");
  assert(!!run.repoUrl && run.repoUrl.startsWith("file://"), "offline release publishes a local repo url");
  assert((run.cost?.totalTokens ?? 0) > 0, "token usage accrued from the runtime");

  process.stdout.write(failures === 0 ? "\nPIPELINE PASSED\n" : `\n${failures} FAILURE(S)\n`);
}

main()
  .catch((err) => {
    process.stderr.write(`pipeline test crashed: ${String(err instanceof Error ? err.stack : err)}\n`);
    failures++;
  })
  .finally(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    // Set exitCode (do NOT call process.exit, which truncates buffered stdout).
    process.exitCode = failures === 0 ? 0 : 1;
  });
