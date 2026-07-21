# AGENTS.md — working in the AI SaaS Factory codebase

This file orients an AI coding agent (or human) working **on the factory itself**.
It is not the prompt used by the factory's runtime agents (those live in
`packages/core/src/agents/prompts.ts`).

## What this project is

A TypeScript monorepo (npm workspaces, ESM, `tsc -b`) that orchestrates GitHub
Copilot SDK sessions as a multi-agent pipeline to generate, test, harden and ship
SaaS applications. See `README.md` for the product-level overview.

## Build & verify

```bash
npm install
npm run build      # tsc -b across packages/core, packages/cli, packages/web
npm run smoke      # offline wiring test (no model/network) — must stay green
npm run doctor     # environment preflight
```

There is no bundler. Each package emits `dist/` next to its `src/`.

## Architecture map

| Area | File | Responsibility |
|------|------|----------------|
| Types | `packages/core/src/types.ts` | Run/Stage/Task/Spec/Plan/Event domain model |
| Config | `packages/core/src/config.ts` | Loads `config/*.json` + env into `FactoryConfig` |
| Copilot runtime | `packages/core/src/copilot/client.ts` | One CLI runtime per working dir; runs single agent turns |
| Model routing | `packages/core/src/copilot/models.ts` | Discovers models, maps role→tier→model id |
| Orchestrator | `packages/core/src/orchestrator/orchestrator.ts` | Drives the 10 build stages (discovery→release) plus operate/fix/heal/estimate/sprint-plan flows, gates, worktree-isolated parallel build, deterministic verify, security fail-closed, ground-truthed acceptance, ephemeral deploy, RUN_REPORT, PR-first publish, budget caps, model escalation, task-level resume, eval recording |
| Verify harness | `packages/core/src/tools/verify.ts` | Deterministic boot + health-poll + test-suite run (exit codes are truth) |
| Deploy provider | `packages/core/src/tools/deploy.ts` | Ephemeral deploy + live-URL smoke for Azure (azd) / AWS (copilot/sam) |
| Acceptance | `packages/core/src/orchestrator/acceptance.ts` | `computeAcceptance(signals)` — score from ground-truth, not an LLM opinion |
| Gates | `packages/core/src/orchestrator/gates.ts` | Human approval synchronisation |
| Job queue | `packages/core/src/orchestrator/queue.ts` | File-backed queue with atomic claim + lease/heartbeat/stale-reclaim |
| Agent prompts | `packages/core/src/agents/prompts.ts` | Role system messages + per-stage user prompts + parity/wow/compliance/quality/saas blocks + triage/fix/sre/em/estimate + cloud-aware delivery |
| Tools | `packages/core/src/tools/{shell,git,scanners,verify,deploy}.ts` | Guarded shell, git/gh (push, clone, branch, PR, worktrees, issue), scanners, deterministic verify, cloud deploy |
| State | `packages/core/src/state/{store,memory,projects,evals}.ts` | JSON run store + JSONL audit + cross-run memory + durable projects + eval corpus under `.factory/` |
| Testing | `packages/core/src/testing/mock-runtime.ts` + `pipeline.smoke.ts` | Injectable canned runtime + offline end-to-end pipeline test |
| Events | `packages/core/src/events.ts` | Process-wide event bus with replay buffer |
| CLI | `packages/cli/src/index.ts` | `doctor`/`new`/`resume`/`iterate`/`list`/`status`/`approve`/`serve` + `operate`/`fix`/`estimate`/`projects`/`sprint`/`evals`/`worker` |
| Web | `packages/web/src/server.ts` + `public/` | Express REST + SSE + static dashboard + jobs/projects/evals APIs + GitHub webhook + in-process worker |
| Config | `config/*.json` | model-routing, security-policy, compliance-profiles, quality-standards, deployment-profiles, saas-capabilities, stack-defaults (incl. `run` verify recipe) |
| Seeds | `templates/<stack>/` | Golden seed scaffolds copied into each new workspace |

The `nextjs-fastapi-postgres` seed is a **working vertical slice** (FastAPI auth +
`items` CRUD + tests + Dockerfiles + `contracts/openapi.yaml` + `contracts/schema.sql`)
that builders extend. Keep it runnable and keep the contract, models and frontend
client in sync when editing it.

## Conventions

- **ESM everywhere**: relative imports use explicit `.js` extensions (compiled
  output). Keep this when adding files.
- **The SDK is preview**: interact with `@github/copilot-sdk` only through the
  loose local interface in `copilot/client.ts`. Do not spread SDK types across
  the codebase; keep the boundary thin so version drift stays contained.
- **Dependency-light**: core has a single runtime dependency (the SDK). Prefer
  Node built-ins (`node:crypto`, `node:fs`, `node:child_process`) over new deps.
- **Determinism for gating**: security/quality gates are computed by our own
  tool wrappers (`tools/scanners.ts`), not by trusting model output. Preserve
  this — the model *fixes*, our code *decides*.
- **Safety**: never remove or weaken the shell denylist in `tools/shell.ts`.
  Any new autonomous command path must route through `runShell`.
- **State shape changes**: update `types.ts` and keep `smoke.ts` assertions in
  sync; `npm run smoke` must pass.

## Adding a pipeline stage

1. Add the stage name to `StageName` and the `PIPELINE` array in the orchestrator.
2. Add a role + system persona in `agents/prompts.ts` and a prompt builder.
3. Add a `stageXxx(run)` method and call it in `execute()`.
4. If it can gate, add it to the default `FACTORY_GATES` documentation.

## Things not to do

- Don't add a database/native module (kept intentionally file-based).
- Don't bypass the event bus for progress reporting — the CLI and web UI both
  depend on it.
- Don't hardcode model IDs; add them to `config/model-routing.json` preferences.
