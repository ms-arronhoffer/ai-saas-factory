/**
 * Core domain types for the AI SaaS Factory.
 *
 * A "run" is one end-to-end factory execution: idea -> requirements -> plan ->
 * parallel build -> integrate -> test -> security harden -> release to GitHub.
 * A run is composed of "stages"; some stages fan out into parallel "tasks"
 * (e.g. builder sub-agents, one per workstream).
 */

export type StageName =
  | "discovery"
  | "requirements"
  | "architect"
  | "build"
  | "integrate"
  | "test"
  | "verify"
  | "security"
  | "delivery"
  | "release";

export type AgentRole =
  | "researcher"
  | "painfinder"
  | "pm"
  | "interrogator"
  | "requirements"
  | "analyst"
  | "innovator"
  | "compliance"
  | "architect"
  | "critic"
  | "designer"
  | "builder"
  | "reviewer"
  | "integrator"
  | "verifier"
  | "test"
  | "security"
  | "devops"
  | "copywriter"
  | "evaluator"
  | "release"
  | "triage"
  | "sre"
  | "em"
  | "estimator";

export type ModelTier = "deep" | "fast";

export type RunStatus =
  | "created"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type StageStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "skipped";

export type TaskStatus = "pending" | "running" | "completed" | "failed";

/** A single deliverable stream that a builder sub-agent owns. */
export interface Workstream {
  id: string;
  title: string;
  /** Sub-directory of the project this workstream owns (relative). */
  dir: string;
  language: "node" | "python" | "mixed";
}

/** Feature set extracted from a single comparable/reference application. */
export interface ReferenceFeatureSet {
  url: string;
  product?: string;
  features: string[];
}

/** Front-of-pipeline discovery artifacts (research, pains, product backlog). */
export interface DiscoveryArtifacts {
  domain?: { summary?: string; entities?: string[]; regulations?: string[]; integrations?: string[]; tableStakes?: string[]; terminology?: string[] };
  pains?: { personas?: string[]; jobs?: string[]; pains?: Array<{ pain: string; severity?: string; frequency?: string }>; unmetNeeds?: string[] };
  backlog?: { must?: string[]; should?: string[]; could?: string[]; wont?: string[]; mvpCut?: string; successMetrics?: string[] };
}

/**
 * A differentiating "wow" feature proposed by the innovator agent — something
 * peers do NOT have that would elevate the app to best-in-class.
 */
export interface WowFeature {
  id: string;
  title: string;
  description: string;
  rationale: string; // why it elevates the app above peers
  impact: "high" | "medium" | "low";
  effort: "high" | "medium" | "low";
}

/** Structured requirements produced by the requirements agent (+ human gate). */
export interface RequirementsSpec {
  name: string;
  slug: string;
  summary: string;
  problem: string;
  targetUsers: string[];
  coreFeatures: string[];
  entities: Array<{ name: string; fields: string[] }>;
  nonFunctional: string[];
  stack: string;
  openQuestions: string[];
  /** Testable acceptance criteria per feature (Given/When/Then). */
  acceptanceCriteria?: Array<{ feature: string; criteria: string[] }>;
  /** Representative sample/seed data the app should ship with. */
  sampleData?: string[];
  /** URLs of comparable apps the build must reach feature parity with. */
  referenceUrls?: string[];
  /** Per-source features extracted from the reference apps. */
  referenceFeatures?: ReferenceFeatureSet[];
  /** Deduped union of must-have features required for parity with references. */
  featureParity?: string[];
  /** Differentiating features proposed by the innovator agent. */
  wowFeatures?: WowFeature[];
  /** Ids of the wow features approved for inclusion in the build. */
  wowSelected?: string[];
  /** Compliance profiles selected for this build (e.g. hipaa, soc2). */
  complianceProfiles?: string[];
  /** Controls derived from the selected compliance profiles. */
  complianceControls?: ComplianceControl[];
}

/** Build plan produced by the architect agent. */
export interface BuildPlan {
  overview: string;
  fileManifest: string[];
  workstreams: Workstream[];
  /** Ordering hints: workstream id -> ids it depends on. */
  dependencies: Record<string, string[]>;
  integrationNotes: string;
  /** Frozen contract artifacts the builders must implement against. */
  contract?: { openapi?: string; schema?: string; notes?: string };
}

export interface Task {
  id: string;
  stage: StageName;
  role: AgentRole;
  title: string;
  status: TaskStatus;
  workstreamId?: string;
  workingDir: string;
  model?: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
}

export interface Stage {
  name: StageName;
  status: StageStatus;
  requiresApproval: boolean;
  startedAt?: string;
  finishedAt?: string;
  tasks: Task[];
  summary?: string;
  error?: string;
}

export interface SecurityFinding {
  scanner: string;
  kind: "sast" | "dependency" | "secret" | "container" | "iac" | "license" | "dast" | "llm";
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  location?: string;
}

export interface SecurityReport {
  iteration: number;
  findings: SecurityFinding[];
  passed: boolean;
  counts: Record<string, number>;
}

/** A single control from a compliance profile. */
export interface ComplianceControl {
  id: string;
  title: string;
  requirement: string;
  profile: string;
}

/** Result of the compliance-audit pass: control-to-implementation matrix. */
export interface ComplianceReport {
  profiles: string[];
  results: Array<{ id: string; profile: string; title: string; status: "met" | "partial" | "gap"; evidence?: string }>;
  met: number;
  partial: number;
  gap: number;
  passed: boolean;
}

/** Result of the "app actually runs" verification stage. */
export interface VerifyReport {
  booted: boolean;
  healthOk: boolean;
  smokePassed: boolean;
  method: string;
  details: string;
  /** Deterministic evidence (exit codes / counts), when the harness ran. */
  buildOk?: boolean;
  testsPassed?: boolean;
  testExit?: number;
  commands?: Array<{ cmd: string; exit: number }>;
  logsTail?: string;
  /** True when produced by the deterministic harness, not an agent's claim. */
  deterministic?: boolean;
  /** Whether the frontend/UI URL served a 2xx/3xx response (when probed). */
  frontendOk?: boolean;
  /** Measured line coverage percentage (0-100), when a coverage recipe ran. */
  coveragePct?: number;
  /** True when coverage met the configured floor (undefined = not gated). */
  coverageOk?: boolean;
  /** Mutation score percentage (0-100), when mutation testing ran. */
  mutationScore?: number;
  /** True when the mutation score met the configured floor. */
  mutationOk?: boolean;
}

/** Result of a live-URL dynamic application security test (DAST). */
export interface DastReport {
  ran: boolean;
  passed: boolean;
  warnings: number;
  fails: number;
  method: string;
  details: string;
}

/** Result of an ephemeral cloud deploy + live smoke (the true definition of done). */
export interface DeployReport {
  attempted: boolean;
  cloud: "azure" | "aws" | "none";
  deployed: boolean;
  url?: string;
  liveHealthOk?: boolean;
  tornDown?: boolean;
  method: string;
  details: string;
  /** Dynamic security scan run against the live URL, when enabled. */
  dast?: DastReport;
}

/** Definition-of-done / acceptance scoring produced by the evaluator. */
export interface AcceptanceScore {
  score: number; // 0-100
  passed: boolean;
  breakdown: Array<{ dimension: string; score: number; notes?: string }>;
  summary: string;
  /** True when the score is derived from deterministic signals, not an LLM opinion. */
  deterministic?: boolean;
  /** The ground-truth signals the score was computed from. */
  signals?: AcceptanceSignals;
}

/** Ground-truth, machine-checkable signals that drive acceptance + evals. */
export interface AcceptanceSignals {
  buildOk?: boolean;
  booted?: boolean;
  healthOk?: boolean;
  testsPassed?: boolean;
  securityPassed?: boolean;
  scannersRan: number;
  complianceGap?: number;
  liveHealthOk?: boolean;
  /** Test coverage met the configured floor. */
  coverageOk?: boolean;
  /** Mutation score met the configured floor (test-quality proof). */
  mutationOk?: boolean;
  /** Live-URL DAST scan passed. */
  dastPassed?: boolean;
}

/** Token/cost accounting for a run. */
export interface CostReport {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  byStage: Record<string, { tokens: number; usd: number }>;
  taskCount: number;
  overBudget: boolean;
}

export interface Run {
  id: string;
  idea: string;
  stack: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  workingDir: string;
  gates: StageName[];
  referenceUrls?: string[];
  complianceProfiles?: string[];
  /** Business-layer SaaS capabilities to build in (billing, multitenancy, …). */
  saas?: string[];
  /** build (0->1), or an operate-mode task on an existing repo. */
  mode?: "build" | "operate" | "fix" | "sprint";
  /** Land changes via a pull request instead of pushing to main. */
  prMode?: boolean;
  /** Owning durable project, if any. */
  projectId?: string;
  /** Deployment scale profile: startup | growth | scale. */
  scale?: string;
  discovery?: DiscoveryArtifacts;
  requirements?: RequirementsSpec;
  plan?: BuildPlan;
  security?: SecurityReport[];
  compliance?: ComplianceReport;
  verify?: VerifyReport;
  deploy?: DeployReport;
  acceptance?: AcceptanceScore;
  /** Current stable runtime versions resolved at build time (not frozen in templates). */
  runtimeVersions?: { key: string; label: string; version: string; major: string; image: string; source: string }[];
  cost?: CostReport;
  repoUrl?: string;
  /** Branch the generated code lives on (PR-first flow); undefined = main. */
  branch?: string;
  prUrl?: string;
  stages: Stage[];
  currentStage?: StageName;
  error?: string;
}

/** Event emitted on the run's event bus and streamed to the dashboard/CLI. */
export interface FactoryEvent {
  runId: string;
  ts: string;
  type:
    | "run.created"
    | "run.status"
    | "stage.start"
    | "stage.end"
    | "stage.awaiting_approval"
    | "task.start"
    | "task.end"
    | "agent.delta"
    | "agent.tool"
    | "log"
    | "discovery.report"
    | "security.report"
    | "compliance.report"
    | "verify.report"
    | "deploy.report"
    | "acceptance.report"
    | "cost.update"
    | "gate.resolved"
    | "run.done";
  stage?: StageName;
  taskId?: string;
  level?: "info" | "warn" | "error";
  message?: string;
  data?: unknown;
}

/* -------------------------------------------------------------------------- */
/* Day-2 / platform types                                                     */
/* -------------------------------------------------------------------------- */

export interface BacklogItem {
  id: string;
  title: string;
  status: "todo" | "in-progress" | "done";
  priority: "high" | "medium" | "low";
  source: "manual" | "issue" | "analytics" | "sre" | "roadmap";
  createdAt: string;
}

/** A durable project the factory owns and operates over time. */
export interface Project {
  id: string;
  name: string;
  stack: string;
  repoUrl?: string;
  owner?: string;
  workingDir: string;
  backlog: BacklogItem[];
  createdAt: string;
  updatedAt: string;
  lastRunId?: string;
}

export type JobKind = "build" | "operate" | "fix" | "sprint";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** A unit of work in the factory job queue (enables horizontal workers). */
export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  payload: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  runId?: string;
  error?: string;
  /** Epoch ms until which a claimed job is leased; past this it can be reclaimed. */
  leaseUntil?: number;
  /** Last worker heartbeat (epoch ms) while processing. */
  heartbeatAt?: number;
  /** How many times this job has been attempted (incremented on reclaim). */
  attempts?: number;
}

/** One row in the evaluation corpus — used for regression tracking. */
export interface EvalRecord {
  runId: string;
  ts: string;
  idea: string;
  stack: string;
  mode: string;
  status: RunStatus;
  acceptance?: number;
  securityPassed?: boolean;
  verifyBooted?: boolean;
  verifyHealth?: boolean;
  testsPassed?: boolean;
  coveragePct?: number;
  mutationScore?: number;
  dastPassed?: boolean;
  scannersRan?: number;
  liveHealthOk?: boolean;
  /** True when acceptance was computed from deterministic signals. */
  deterministic?: boolean;
  costUsd?: number;
  tokens?: number;
}

