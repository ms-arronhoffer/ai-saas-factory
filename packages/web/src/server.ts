import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import express, { type Request, type Response } from "express";
import { Factory, type FactoryEvent, type StageName } from "@ai-saas-factory/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "..", "public");

export async function startServer(): Promise<void> {
  const factory = new Factory();
  const app = express();
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  // --- REST -----------------------------------------------------------------
  app.get("/api/doctor", async (_req: Request, res: Response) => {
    const { runDoctor } = await import("@ai-saas-factory/core");
    res.json(await runDoctor());
  });

  app.get("/api/stacks", (_req: Request, res: Response) => {
    const stacks = Object.entries(factory.config.stacks.stacks).map(([id, def]) => ({
      id,
      label: def.label,
      hasTemplate: !!def.seed,
      languages: def.languages,
      frontend: def.frontend?.["framework"],
      backend: def.backend?.["framework"],
      database: def.database?.["engine"],
      workstreams: def.workstreams.map((w) => ({ id: w.id, title: w.title })),
    }));
    const compliance = Object.entries(factory.config.compliance.profiles).map(([id, def]) => ({ id, label: def.label }));
    const scales = Object.entries(factory.config.deployment.profiles).map(([id, def]) => ({ id, label: def.label, summary: def.summary }));
    const saas = Object.entries(factory.config.saas.capabilities).map(([id, def]) => ({ id, label: def.label }));
    res.json({ defaultStack: factory.config.stacks.default, defaultScale: factory.config.scaleDefault, visibility: factory.config.repoVisibility, gates: factory.config.gates, stacks, compliance, scales, saas });
  });

  app.get("/api/runs", (_req: Request, res: Response) => {
    res.json(factory.listRuns().map(summarize));
  });

  app.get("/api/runs/:id", (req: Request, res: Response) => {
    const run = factory.getRun(String(req.params.id));
    if (!run) return res.status(404).json({ error: "not found" });
    res.json(run);
  });

  app.post("/api/runs", (req: Request, res: Response) => {
    const { idea, stack, references, compliance, scale, saas } = req.body as { idea?: string; stack?: string; references?: string[]; compliance?: string[]; scale?: string; saas?: string[] };
    if (!idea || idea.trim().length < 3) return res.status(400).json({ error: "idea is required" });
    const refs = Array.isArray(references) ? references.map((r) => String(r).trim()).filter(Boolean) : [];
    const profiles = Array.isArray(compliance) ? compliance.map((c) => String(c).trim()).filter(Boolean) : [];
    const caps = Array.isArray(saas) ? saas.map((c) => String(c).trim()).filter(Boolean) : [];
    const run = factory.startBuild(idea.trim(), stack, refs, profiles, scale, caps);
    res.status(201).json(summarize(run));
  });

  app.post("/api/runs/:id/iterate", (req: Request, res: Response) => {
    const { instruction } = req.body as { instruction?: string };
    if (!instruction || instruction.trim().length < 3) return res.status(400).json({ error: "instruction is required" });
    void factory.iterate(String(req.params.id), instruction.trim()).catch(() => {});
    res.status(202).json({ ok: true });
  });

  app.post("/api/runs/:id/resume", (req: Request, res: Response) => {
    void factory.resume(String(req.params.id)).catch(() => {});
    res.status(202).json({ ok: true });
  });

  app.post("/api/runs/:id/gate/:stage", (req: Request, res: Response) => {
    const { decision, notes, wowSelected } = req.body as { decision?: "approve" | "reject" | "revise"; notes?: string; wowSelected?: string[] };
    if (!decision) return res.status(400).json({ error: "decision is required" });
    const ok = factory.resolveGate(String(req.params.id), req.params.stage as StageName, {
      decision,
      notes,
      ...(Array.isArray(wowSelected) ? { wowSelected } : {}),
    });
    res.status(ok ? 200 : 409).json({ ok });
  });

  // --- Platform: jobs, projects, evals, webhooks ----------------------------
  app.get("/api/jobs", (req: Request, res: Response) => {
    const status = typeof req.query.status === "string" ? (req.query.status as never) : undefined;
    res.json(factory.queue.list(status));
  });

  app.post("/api/jobs", (req: Request, res: Response) => {
    const { kind, payload } = req.body as { kind?: string; payload?: Record<string, unknown> };
    if (!kind || !["build", "operate", "fix", "sprint"].includes(kind)) return res.status(400).json({ error: "kind must be build|operate|fix|sprint" });
    const job = factory.enqueue(kind as never, payload ?? {});
    res.status(201).json(job);
  });

  app.get("/api/projects", (_req: Request, res: Response) => {
    res.json(factory.projects.list());
  });

  app.post("/api/projects", async (req: Request, res: Response) => {
    const { name, repoUrl, stack, owner } = req.body as { name?: string; repoUrl?: string; stack?: string; owner?: string };
    if (!name) return res.status(400).json({ error: "name is required" });
    try {
      const project = await factory.registerProject({ name, ...(repoUrl ? { repoUrl } : {}), ...(stack ? { stack } : {}), ...(owner ? { owner } : {}) });
      res.status(201).json(project);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/evals", (_req: Request, res: Response) => {
    const store = factory.orchestrator.evalStore();
    res.json({ aggregate: store.aggregate(), records: store.all().slice(-50).reverse() });
  });

  // GitHub webhook: an opened issue becomes a queued fix job (intake integration).
  app.post("/api/webhooks/github", (req: Request, res: Response) => {
    const body = req.body as { action?: string; issue?: { number?: number; title?: string; body?: string }; repository?: { full_name?: string } };
    const repo = body.repository?.full_name;
    const issue = body.issue;
    if (body.action === "opened" && repo && issue?.number) {
      const task = `${issue.title ?? `Issue #${issue.number}`}\n\n${issue.body ?? ""}`.slice(0, 4000);
      const job = factory.enqueue("fix", { repoUrl: repo, kind: "fix", task, prMode: true });
      return res.status(202).json({ queued: job.id });
    }
    res.status(200).json({ ignored: true });
  });

  // --- SSE ------------------------------------------------------------------
  app.get("/api/events", (req: Request, res: Response) => {
    const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`retry: 3000\n\n`);

    // Replay recent history so a late-connecting browser catches up.
    for (const e of factory.bus.replay(runId)) send(res, e);

    const unsubscribe = factory.bus.subscribe((e: FactoryEvent) => {
      if (!runId || e.runId === runId) send(res, e);
    });
    const keepAlive = setInterval(() => res.write(`: ping\n\n`), 15_000);

    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  const { webPort: port, webHost: host } = factory.config;
  await new Promise<void>((resolveListen) => {
    app.listen(port, host, () => {
      process.stdout.write(`\nAI SaaS Factory dashboard → http://${host}:${port}\n`);
      resolveListen();
    });
  });

  // Background worker: drain queued jobs (enqueued via the API or webhooks).
  let draining = false;
  setInterval(() => {
    if (draining) return;
    draining = true;
    void factory
      .processNextJob()
      .catch(() => {})
      .finally(() => {
        draining = false;
      });
  }, 3000);
}

function send(res: Response, event: FactoryEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function summarize(run: ReturnType<Factory["listRuns"]>[number]) {
  return {
    id: run.id,
    idea: run.idea,
    stack: run.stack,
    status: run.status,
    createdAt: run.createdAt,
    currentStage: run.currentStage,
    repoUrl: run.repoUrl,
    prUrl: run.prUrl,
    scale: run.scale,
    complianceProfiles: run.complianceProfiles,
    acceptance: run.acceptance?.score,
    acceptanceDeterministic: run.acceptance?.deterministic,
    verify: run.verify ? { booted: run.verify.booted, healthOk: run.verify.healthOk, testsPassed: run.verify.testsPassed } : undefined,
    deploy: run.deploy ? { cloud: run.deploy.cloud, deployed: run.deploy.deployed, url: run.deploy.url, liveHealthOk: run.deploy.liveHealthOk } : undefined,
    cost: run.cost ? { usd: run.cost.estimatedUsd, tokens: run.cost.totalTokens } : undefined,
    stages: run.stages.map((s) => ({ name: s.name, status: s.status })),
  };
}

// Run directly: `node packages/web/dist/server.js`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server.js")) {
  startServer().catch((err) => {
    process.stderr.write(String(err) + "\n");
    process.exit(1);
  });
}
