# AI SaaS Factory

A **local, multi-agent software factory** that turns a plain-language idea into a
security-hardened SaaS application and pushes it to a new GitHub repository —
autonomously, using the **GitHub Copilot SDK** to drive Claude models
(Opus for deep reasoning, Sonnet for high-volume code generation).

```
idea ─▶ requirements ─▶ architect ─▶ ⛓ parallel build ─▶ integrate ─▶ test ─▶ verify ─▶ security harden ─▶ delivery ─▶ release to GitHub
            (gate)                                                                                                          (gate)
```

## Discovery, design & quality agents

Ahead of and alongside the core build, specialist agents raise product quality:

- **Discovery stage** (front of pipeline, `FACTORY_DISCOVERY`): a **domain
  researcher** (writes `DOMAIN.md` — standard entities, regulations, integrations,
  table-stakes), a **pain-point / JTBD finder** (writes `PAINS.md`, mines the
  reference apps for *unmet needs* that become `wow` candidates), and a **product
  manager** (writes `BACKLOG.md` — MoSCoW + an explicit MVP cut line + success
  metrics). Their output threads into requirements, architecture and the innovator.
- **Design system** (`FACTORY_DESIGN`): a **designer** writes `DESIGN.md` (tokens,
  components, IA, required states, a11y, dark mode) *before* the frontend is built
  — the design equivalent of the frozen API contract.
- **Visual QA loop** (`FACTORY_VISUAL_QA`): after `verify` boots the app and
  captures Playwright screenshots, a designer **views the screenshots** and fixes
  the UI against usability heuristics — closing the loop code review can't.
- **Microcopy/brand** (`FACTORY_COPY`): a copywriter gives the product a coherent
  name, voice and polished in-app copy in the release stage.
- **Deepeners**: the reviewer also checks **API design + data modelling**; `verify`
  runs an **accessibility** check against the running app; `delivery` generates
  **docs** (API reference, user guide, runbook, Mermaid diagram).
- **Process** (opt-in): `FACTORY_BEST_OF=N` generates N candidate architectures and
  the evaluator picks the strongest; `FACTORY_ARCH_CRITIQUE=true` adds a
  proposer/critic debate; the researcher/architect are primed with **cross-run
  memory** (RAG over prior successful runs).


## How it works

Each pipeline stage is a specialised **agent** — a Copilot session with a role
system prompt, a routed model, an isolated working directory, and an autonomous
(but denylist-guarded) permission policy. The Copilot CLI agent behind the SDK
already provides file-editing and shell tools, so agents *actually write files
and run commands* rather than just describing changes.

| Stage | Role | Model tier | What it does |
|-------|------|-----------|--------------|
| requirements | product engineer (+ analyst + innovator) | deep (Opus) | Analyses comparable apps for a **parity checklist**, proposes **"wow" features**, applies **compliance controls**, and produces a structured spec → **human gate** |
| architect | staff architect | deep (Opus) | Copies a golden seed, scaffolds the project, defines parallel workstreams; primed with cross-run memory |
| build | full-stack engineers | fast (Sonnet) | **Parallel sub-agents**, one per workstream, threaded with parity + wow + compliance + quality standards |
| integrate | senior engineer | deep (Opus) | Merges workstreams, runs a **feature-parity audit** and fills gaps |
| test | test engineer | fast (Sonnet) | Writes and runs pytest/vitest until green |
| verify | verification engineer | fast (Sonnet) | **Boots the app** (compose up + `/health` + smoke) and fixes what doesn't run |
| security | appsec + compliance | deep (Opus) | Scanners (SAST, deps, secrets, container, **SBOM+license**, **IaC**) + LLM review + **compliance audit** → control matrix |
| delivery | DevOps engineer | deep (Opus) | Generates **CI/CD, IaC, container hardening, repo hygiene**; optional `azd up` deploy |
| release | release engineer (+ evaluator) | fast (Sonnet) | Finalises the repo, **scores against a definition of done**, then **human gate** before `gh repo create` + push |

Runs are **cost-tracked** (tokens/USD with an optional budget that aborts the run),
**resumable** (completed stages are skipped after a restart), and feed a
**cross-run memory** that primes future architecture. Use `factory iterate <id> "<change>"`
to apply a follow-up change to a shipped app and push it.

## Governance, compliance & supply chain

- **Compliance-by-design** — select profiles (`--compliance hipaa,soc2` or the
  dashboard checkboxes; profiles in `config/compliance-profiles.json`:
  PCI-DSS, HIPAA, SOC 2, GDPR, ISO 27001). Their controls are threaded into
  requirements, architecture and every builder, then **audited** in the security
  stage into a `COMPLIANCE.md` control-to-implementation matrix (met/partial/gap).
- **Supply chain** — an **SBOM** (CycloneDX via syft) is generated and its
  licenses evaluated against a deny policy; **IaC** is scanned (checkov); optional
  **DAST** (ZAP) against the running app.
- **Quality standards** (`config/quality-standards.json`) — accessibility
  (WCAG 2.2 AA), performance budgets, observability (OTel, `/health`, structured
  logs), UX polish, i18n/SEO, feature flags, testing depth and data handling are
  threaded into the architect/builder prompts so they're built in from the start.
- **Prompt-injection defense** — the analyst treats fetched reference pages as
  untrusted data and ignores any embedded instructions.

## Production-shaped on the first build

The factory is tuned so the *first* version is close to production, not a skeleton
needing many revisions:

- **Working golden templates, not empty seeds** — each new build starts from a
  runnable vertical slice ([templates/nextjs-fastapi-postgres](templates/nextjs-fastapi-postgres):
  FastAPI auth + `items` CRUD + tests + hardened Dockerfiles + docker-compose,
  Next.js frontend, all with **pinned dependencies**). Agents extend a running app.
- **Contract-first** — the architect defines and **freezes** `contracts/openapi.yaml`
  + `contracts/schema.sql` before any builder starts; every builder implements
  strictly against them, which removes the biggest source of integration churn.
- **Anti-stub builders with an inner build/test/fix loop** — builders are forbidden
  from shipping TODOs/placeholders/mocks and must install, build, test and fix
  their own workstream before handing off.
- **Testable acceptance criteria** — requirements emit Given/When/Then per feature;
  builders and the test stage build to them.
- **Pre-integration review** — a reviewer agent catches stubs and contract drift
  and fixes them before the integrator merges.

## Proof, not vibes: deterministic gates & true definition of done

The factory's quality gates are backed by real tooling, not an LLM grading its
own homework:

- **Deterministic verify** ([tools/verify.ts](packages/core/src/tools/verify.ts)) —
  actually boots the app (`docker compose up`), polls its health endpoint with
  retries, and runs the test suite. **Exit codes are the truth**; if it's broken
  an agent fixes it and the harness re-runs to confirm. The per-stack recipe
  lives in [config/stack-defaults.json](config/stack-defaults.json) (`run`).
- **Ground-truthed acceptance** ([orchestrator/acceptance.ts](packages/core/src/orchestrator/acceptance.ts)) —
  the score is computed from machine-checkable signals (build/boot/health/tests/
  coverage/mutation/security/scanners/DAST/compliance/live-health). The LLM only
  writes the narrative; it never decides pass/fail. A measured critical failure
  hard-gates the run. The eval corpus records these signals, so regression
  detection means something.
- **Test-quality gates, not just "tests pass"** — the verify harness measures
  **line coverage** (coverage.py / Istanbul / Cobertura) and, opt-in, a
  **mutation score** (do the tests actually catch injected bugs?). Set a floor
  with `FACTORY_MIN_COVERAGE` / `FACTORY_MIN_MUTATION_SCORE` and hard-gate with
  `FACTORY_REQUIRE_COVERAGE`. Passing tests that exercise nothing no longer slip
  through.
- **Live-URL DAST** ([tools/dast.ts](packages/core/src/tools/dast.ts)) — with
  `FACTORY_DAST=true`, an **OWASP ZAP baseline scan** runs against the deployed
  preview URL (the *running* app, not the source), before teardown. Its result
  feeds acceptance and can hard-gate via `FACTORY_REQUIRE_DAST`.
- **Security fails closed** — if **zero scanners actually ran**, that is a loud,
  first-class signal that flows into acceptance and the eval record; set
  `FACTORY_REQUIRE_SCANNERS=true` to fail the gate outright.
- **True definition of done — a live URL** — with `FACTORY_DEPLOY=true` the
  delivery stage does an **ephemeral deploy to Azure (`azd`) or AWS
  (Copilot/SAM)** and smoke-tests the **live** URL (2xx), then tears it down.
  Pick the cloud with `FACTORY_CLOUD=azure|aws`.
- **`RUN_REPORT.md` in every repo** — an auditable trail (verify results, scanner
  counts, deploy URL, acceptance breakdown, cost) committed into the generated
  repository and attached to the PR.
- **Cost & safety rails** — token usage is asserted non-zero (drift warns loudly);
  hard per-task token ceiling, wall-clock run budget, and an optional pre-flight
  estimate gate (`FACTORY_PREFLIGHT`) abort runaway builds early.
- **True parallel isolation** — each workstream builds in its own **git worktree**
  (`FACTORY_WORKTREES`) and is merged back, so parallel builders can't clobber
  each other's root files.
- **Proven end-to-end offline** — `npm run smoke:pipeline` drives the whole
  orchestrator with a canned mock runtime (no model/network/GitHub), and CI runs
  it on every push so refactors aren't a leap of faith.

## Beyond 0→1: a continuously-operating platform

The factory does not stop at the first push. It runs as an engineering platform
that operates apps over time, sells them as real SaaS, and improves itself:

- **PR-first everywhere** — with `FACTORY_PR_MODE=true` even a fresh build lands
  as a reviewable **pull request** off a scaffold `main` (carrying the
  `RUN_REPORT.md`), and `sprint` opens **a PR per backlog item** so a mid-sprint
  failure never leaves the shared repo half-broken. Operate/fix flows can spin up
  a **preview environment per PR** so a human reviews a *running* change.
- **Business-layer SaaS capabilities** (`--saas`, [config/saas-capabilities.json](config/saas-capabilities.json)) —
  opt into **billing** (Stripe subscriptions + entitlements), **multi-tenancy**
  (orgs/roles/tenant isolation, SSO-ready), **growth** (landing/SEO/onboarding/
  analytics/A-B), **support** (status page + changelog + in-app help), **deeper QA**
  (E2E, visual regression, load/soak, chaos), **provenance** (SBOM diff + cosign +
  SLSA), and **continuous delivery** (canary/blue-green + zero-downtime migrations +
  feature flags). Each threads guidance into the architect, builder and delivery
  agents.
- **Day-2 operations** — `operate` an existing repo to **fix** a bug (triage →
  root-cause → minimal fix + regression test), **self-heal** from operational
  signals (SRE agent + postmortem), or ship a **feature**; `fix` performs bug
  intake straight from a **GitHub issue**. Changes land via a **pull request**
  (`--pr` / `FACTORY_PR_MODE`) for human review, or a direct push.
- **Persistent projects & sprints** — register durable **projects** with a
  backlog; an **engineering-manager** agent plans a **sprint** and ships the top
  items as parallel squads against the project's repo.
- **Factory-as-platform** — a file-backed **job queue** with `worker` processes
  (horizontal scale), a REST **API**, and a **GitHub webhook** that converts new
  issues into queued fix jobs. `estimate` scopes an idea's effort/cost/timeline
  without building.
- **Self-improvement** — every run is scored into an **evaluation corpus**
  (`evals`) that tracks quality/cost trends and flags **regressions** against a
  rolling baseline; failed agent tasks **escalate** to the deep model before
  giving up (`FACTORY_ESCALATE`).
- **Interrogator** — before requirements, an agent **interrogates the vague
  one-line idea** into a precise brief, committing to the most sensible default
  for each ambiguity and recording it as an explicit assumption
  (`CLARIFICATIONS.md`). Runs unattended under `--yes`; a human can override the
  decisions via the requirements **revise** gate (`FACTORY_INTERROGATOR`).
- **Progress-based liveness** — long turns are governed by *activity*, not an
  arbitrary clock. A **stall watchdog** aborts only on genuine pathology: total
  silence for `FACTORY_STALL_INACTIVITY_SECONDS`, or the **same tool call
  looping** `FACTORY_STALL_LOOP_THRESHOLD` times. The per-task time cap
  (`FACTORY_MAX_TASK_SECONDS`) is off by default — the SDK's turn timeout does
  not even abort the agent, so healthy work is no longer killed at a time mark.
- **Current runtime versions, resolved at build time** — instead of freezing an
  old base image in a template, the factory resolves the **latest stable** major
  of each runtime (Node, Python, PostgreSQL, nginx) from
  [endoflife.date](https://endoflife.date) at run time and threads it into the
  architect/builder/devops agents, so generated apps ship on modern majors with
  floating patch tags. Falls back to pinned currents when offline.

## Deployment scale profiles

Pick a scale target and the factory shapes the **architecture** and **delivery
(IaC)** stages accordingly — without changing the app's core logic
([config/deployment-profiles.json](config/deployment-profiles.json)):

| Tier | Topology | Data | Hosting |
|------|----------|------|---------|
| **startup** | modular monolith | managed Postgres (burstable) | one Container App / App Service; cheapest |
| **growth** | monolith + optional worker | Postgres + pooling + Redis + queue | Container Apps autoscale, dev/staging/prod |
| **scale** | service/worker split, CDN | read replicas, caching, zone-redundant | multi-replica ACA/AKS, WAF, DR |

```bash
node packages/cli/dist/index.js new "..." --scale growth
```
Or choose it in the dashboard (and set the default with `FACTORY_SCALE`).

## Golden templates

Every stack in [config/stack-defaults.json](config/stack-defaults.json) now starts
from a **runnable seed** under [templates/](templates) that the agents extend
(shown with a "seeded ✓" badge in the dashboard's *Golden templates* panel):

| Stack | Template |
|-------|----------|
| `nextjs-fastapi-postgres` | Next.js + FastAPI + Postgres, auth + items CRUD |
| `node-express-react` | Express + Prisma + React (Vite), auth + items CRUD |
| `fastapi-postgres-api` | API-only FastAPI + Postgres, auth + items CRUD |

Each ships pinned deps, hardened Dockerfiles, docker-compose, passing tests, and a
frozen `contracts/openapi.yaml` + `contracts/schema.sql`. To add your own: create
`templates/<name>/` with a working vertical slice and reference it via `seed` in
`stack-defaults.json`.




## "Wow" features — elevating the app above its peers

During requirements, an **innovator** agent analyses the product (and any peer
features found via reference URLs) and proposes concrete **"wow" features** —
capabilities peers do *not* have that would make the app best-in-class. Each
proposal has an impact/effort rating and a rationale, and is written to `WOW.md`.

- The top-ranked proposals (by impact vs. effort, `FACTORY_WOW_COUNT`, default 3)
  are **pre-selected**.
- At the requirements gate you choose which to include — in the CLI press `w`
  to pick, or tick the boxes in the dashboard.
- Selected wow features are threaded into the architecture and builder prompts,
  and confirmed during the integration audit.

Disable the pass entirely with `FACTORY_WOW=false`.

## Feature parity from comparable apps

Provide one or more URLs of comparable applications and the factory will:

1. **Analyse** each reference (an analyst sub-agent fetches the page and
   reverse-engineers its user-facing feature set) and derive a deduped
   **parity checklist**.
2. **Guarantee coverage** — the checklist is merged into the requirements spec's
   core features and threaded into the architecture and every builder prompt.
3. **Audit** — after integration, a dedicated parity pass verifies each required
   capability is genuinely implemented (not stubbed) and implements anything
   missing, reporting `covered / added / gaps`.

```bash
# CLI: repeat --ref for each comparable app
node packages/cli/dist/index.js new "A retro board for agile teams" \
  --ref https://trello.com --ref https://easyretro.io
```

In the web dashboard, paste reference URLs (one per line) into the *comparable
apps* box on the new-build form. The parity checklist is shown at the
requirements approval gate.

Parallelism is driven by a dependency-aware scheduler that groups independent
workstreams into concurrent "waves" (bounded by `FACTORY_MAX_PARALLEL`), each
builder working in its own subdirectory.

## Prerequisites

- **Node.js ≥ 22.12**
- **GitHub CLI** authenticated with the Copilot scope:
  ```bash
  gh auth login
  gh auth refresh --scopes copilot
  ```
- **git**
- Optional (for running/scanning generated apps): **Python 3**, **Docker**, and
  scanners `semgrep`, `bandit`, `pip-audit`, `checkov`, `gitleaks`, `trivy`,
  `syft`. Missing scanners are skipped, not fatal.

> Prefer containers? The [Run in Docker](#run-in-docker) image bundles every
> scanner and runs the factory as a server or CLI — no local tool install needed.

Run the preflight check any time:

```bash
npm run doctor
```

## Setup

```bash
npm install
npm run build          # compiles all packages (tsc -b)
cp .env.example .env   # optional: adjust owner, visibility, concurrency, gates
```

## Usage

### CLI

```bash
# Build a SaaS app end-to-end (interactive approval gates)
node packages/cli/dist/index.js new "A team retro board with boards, cards, voting and Google login"

# Fully autonomous (auto-approve every gate)
node packages/cli/dist/index.js new "URL shortener with analytics" --yes

# Pick a stack
node packages/cli/dist/index.js new "..." --stack node-express-react

# Build with compliance profiles baked in
node packages/cli/dist/index.js new "A telehealth notes app" --compliance hipaa,soc2

# Build a real SaaS with business-layer capabilities (billing, tenancy, growth…)
node packages/cli/dist/index.js new "A project management tool" --saas billing,multitenancy,growth,support

# Build AND deploy to a live URL (choose the cloud), landing as a reviewable PR
FACTORY_DEPLOY=true FACTORY_CLOUD=azure FACTORY_PR_MODE=true node packages/cli/dist/index.js new "A URL shortener" --yes
FACTORY_DEPLOY=true FACTORY_CLOUD=aws node packages/cli/dist/index.js new "A URL shortener" --yes

# Resume an interrupted run, or ship a follow-up change
node packages/cli/dist/index.js resume <runId>
node packages/cli/dist/index.js iterate <runId> "add CSV export to the dashboard"

# Inspect
node packages/cli/dist/index.js list
node packages/cli/dist/index.js status <runId>
```

#### Day-2 operations (operate on existing repos)

```bash
# Register a durable project (clones the repo into a stable workspace)
node packages/cli/dist/index.js projects register --name Acme --repo my-org/acme

# Fix a bug / self-heal from signals / ship a feature on an existing repo
node packages/cli/dist/index.js operate my-org/acme "500s on /login after deploy" --kind heal --pr
node packages/cli/dist/index.js operate <projectId> "add dark mode toggle" --kind feature

# Bug intake from a GitHub issue → reproduce → fix → open a PR
node packages/cli/dist/index.js fix my-org/acme 42

# Groom + ship the top backlog items as a sprint of parallel squads
node packages/cli/dist/index.js projects backlog --project <projectId> --title "Add SSO"
node packages/cli/dist/index.js sprint <projectId> --max 3 --pr
```

#### Platform, planning & self-improvement

```bash
# Estimate effort/cost/timeline for an idea without building
node packages/cli/dist/index.js estimate "A CRM for solar installers"

# Run a worker to drain the job queue (start N of these for horizontal scale)
node packages/cli/dist/index.js worker

# View the evaluation corpus (quality/cost trends + regression flags)
node packages/cli/dist/index.js evals
```

### Web dashboard

```bash
npm run serve   # http://127.0.0.1:7788
```

Start builds, watch live agent activity over SSE, and resolve approval gates
from the browser. The server also exposes a platform API — `POST /api/jobs`
(enqueue build/operate/fix/sprint work), `GET/POST /api/projects`,
`GET /api/evals`, and a GitHub webhook at `POST /api/webhooks/github` that turns
newly-opened issues into queued fix jobs — and runs an in-process worker that
drains the queue.

## Run in Docker

A self-contained image runs the factory as a **standalone server** *and* as a
**one-shot CLI**, with every scanner (`semgrep`, `bandit`, `pip-audit`,
`checkov`, `gitleaks`, `trivy`, `syft`, plus `npm-audit`) baked in — nothing is
skipped. ZAP (DAST) runs as a pulled container.

Because the factory itself drives Docker (verify/deploy/ZAP), the container needs
a Docker daemon. The provided [`docker-compose.yml`](docker-compose.yml) uses the
**socket-mount** model (Linux host): app containers are built as siblings on the
host daemon, `network_mode: host` lets the verify probe reach them on
`localhost`, and an identical `/var/lib/factory` bind keeps build-context paths in
sync. A **dind** alternative (stronger isolation) is documented at the bottom of
the compose file.

**Auth** — provide one of:
- `GITHUB_TOKEN` carrying the `copilot` scope (from `gh auth refresh --scopes copilot`), or
- your host `gh` login mounted read-only (the `~/.config/gh` bind in the compose file).

The same credential covers Copilot model calls and GitHub pushes. Set
`FACTORY_OFFLINE=true` for Copilot-only runs with no push.

```bash
# Prepare host state + auth once
sudo mkdir -p /var/lib/factory
gh auth login && gh auth refresh --scopes copilot      # or: export GITHUB_TOKEN=...

# Standalone server on :7788 (dashboard + REST + webhook)
docker compose up -d --build

# One-shot build via the CLI (same image)
docker compose run --rm factory new "a pastebin API with expiring snippets" \
  --stack fastapi-postgres-api --yes

# Scale out background workers against the shared queue
docker compose --profile workers up -d --scale worker=3
```

State (`/var/lib/factory/.factory`) and generated apps
(`/var/lib/factory/workspaces`) persist on the host. Keep cloud deploy off
(`FACTORY_DEPLOY=false`) unless you also mount `azd`/AWS credentials.

## Configuration


All configuration is file- and env-driven:

- `config/model-routing.json` — role → model tier → ordered preferred model IDs.
  The router discovers available models at startup and picks the first match, so
  it adapts to whatever Opus/Sonnet versions your Copilot plan exposes.
- `config/security-policy.json` — scanners, gate thresholds, fix-loop iterations.
- `config/stack-defaults.json` — default tech stack and workstream decomposition.
- `.env` — GitHub owner/visibility, concurrency, gates, ports (see `.env.example`).

## Safety

- Autonomous shell execution is filtered by a **denylist** (`packages/core/src/tools/shell.ts`)
  that blocks destructive/exfiltration commands (`rm -rf /`, force pushes,
  `curl | sh`, fork bombs, …).
- The release push is gated behind explicit human approval by default.
- Generated repos are **private** by default.
- Secrets scanning (gitleaks/Trivy) runs before publish; only `.env.example`
  placeholders are expected in the tree.

## Project layout

```
packages/
  core/   orchestrator, Copilot runtime, model router, agents, tools, state
  cli/    commander-based command line
  web/    Express + SSE dashboard (static UI)
config/   model routing, security policy, stack defaults
```

## Offline tests

Validate the wiring without any model/network calls:

```bash
npm run smoke            # pure-function assertions (config, parse, acceptance, queue, …)
npm run smoke:pipeline   # drives the WHOLE orchestrator with a mock runtime (no model/GitHub)
npm test                 # both of the above (also run in CI on every push)
```

## License

MIT
