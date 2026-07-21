import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repository root: dist is packages/core/dist, so climb three levels. */
export const REPO_ROOT = resolve(__dirname, "..", "..", "..");
export const CONFIG_DIR = resolve(REPO_ROOT, "config");

export interface ModelTierConfig {
  description?: string;
  preferred: string[];
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  fallback: string;
}

export interface ModelRoutingConfig {
  tiers: Record<"deep" | "fast", ModelTierConfig>;
  roles: Record<string, "deep" | "fast">;
}

export interface SecurityPolicyConfig {
  maxFixIterations: number;
  gates: {
    maxCritical: number;
    maxHigh: number;
    maxSecrets: number;
    allowDependencyHigh: boolean;
    maxDeniedLicenses?: number;
    maxIacHigh?: number;
  };
  licensePolicy?: { deny: string[]; flagUnknown?: boolean };
  scanners: Record<
    string,
    {
      enabled: boolean;
      command: string;
      installHint?: string;
      appliesTo?: string[];
      kind: "sast" | "dependency" | "secret" | "container" | "iac" | "sbom" | "dast";
      severityField?: string;
    }
  >;
  llmReview: { enabled: boolean; focus: string[] };
}

export interface ComplianceControlDef {
  id: string;
  title: string;
  requirement: string;
}
export interface ComplianceProfileDef {
  label: string;
  summary: string;
  controls: ComplianceControlDef[];
}
export interface ComplianceProfilesConfig {
  profiles: Record<string, ComplianceProfileDef>;
}

export interface QualityStandardDef {
  enabled: boolean;
  label: string;
  guidance: string[];
  check?: string;
}
export interface QualityStandardsConfig {
  standards: Record<string, QualityStandardDef>;
}

export interface DeploymentProfileDef {
  label: string;
  summary: string;
  architecture: string[];
  delivery: string[];
}
export interface DeploymentProfilesConfig {
  default: string;
  profiles: Record<string, DeploymentProfileDef>;
}

export interface SaasCapabilityDef {
  label: string;
  guidance: string[];
}
export interface SaasCapabilitiesConfig {
  capabilities: Record<string, SaasCapabilityDef>;
}

export interface StackWorkstream {
  id: string;
  title: string;
  dir: string;
  language: "node" | "python" | "mixed";
}

export interface StackDef {
  label: string;
  seed?: string;
  languages: string[];
  frontend?: Record<string, string>;
  backend?: Record<string, string>;
  database?: Record<string, string>;
  infra?: Record<string, string>;
  workstreams: StackWorkstream[];
  /** Deterministic verification recipe: how to boot, health-check and test. */
  run?: {
    up?: string;
    down?: string;
    healthUrl?: string;
    /** Optional frontend/UI URL to probe so the built UI is verified as serving. */
    frontendUrl?: string;
    test?: string[];
    /** Commands that produce a machine-readable coverage summary + its path. */
    coverage?: Array<{ cmd: string; file: string }>;
    /** Command that runs mutation testing and prints a score (opt-in). */
    mutation?: string;
  };
}

export interface StackDefaultsConfig {
  default: string;
  stacks: Record<string, StackDef>;
}

function loadJson<T>(name: string): T {
  const path = resolve(CONFIG_DIR, name);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export interface FactoryConfig {
  githubOwner?: string;
  repoVisibility: "private" | "public" | "internal";
  githubToken?: string;
  maxParallel: number;
  dataDir: string;
  workspacesDir: string;
  webPort: number;
  webHost: string;
  gates: string[];
  modelDeepOverride?: string;
  modelFastOverride?: string;
  /** Propose differentiating "wow" features during requirements. */
  wowEnabled: boolean;
  /** How many top wow features to auto-select when the user does not choose. */
  wowAutoSelect: number;
  /** Default compliance profiles applied to every build (override per run). */
  complianceDefault: string[];
  /** Run the generation of CI/CD + IaC + repo hygiene in the delivery stage. */
  deliveryEnabled: boolean;
  /** Attempt an actual cloud deploy in the delivery stage (requires azd). */
  deployEnabled: boolean;
  /** Boot the app and probe /health during the verify stage. */
  verifyEnabled: boolean;
  /** Score the app against a definition-of-done in the release stage. */
  acceptanceEnabled: boolean;
  /** Run the front-of-pipeline discovery stage (research + pains + PM). */
  discoveryEnabled: boolean;
  /** Produce a design system (DESIGN.md) before the frontend is built. */
  designEnabled: boolean;
  /** Screenshot + design-critique loop after the app boots (needs Playwright). */
  visualQaEnabled: boolean;
  /** Microcopy/brand polish pass in the release stage. */
  copyEnabled: boolean;
  /** Generate N architectures and pick the best (1 = off). */
  bestOf: number;
  /** Run a proposer/critic debate on the architecture. */
  archCritiqueEnabled: boolean;
  /** Abort a run if cumulative tokens exceed this (0 = unlimited). */
  maxTokens: number;
  /** Abort a run if estimated USD exceeds this (0 = unlimited). */
  maxUsd: number;
  /** Rough USD price per 1M tokens for cost estimation (blended). */
  usdPerMillionTokens: number;
  /** OTLP endpoint for factory + CLI OpenTelemetry traces (optional). */
  otlpEndpoint?: string;
  /** Default deployment scale profile (startup|growth|scale). */
  scaleDefault: string;
  /** Default business-layer SaaS capabilities to build in. */
  saasDefault: string[];
  /** Land changes via pull requests instead of pushing to main. */
  prMode: boolean;
  /** Retry a failed agent task once with the deep model (self-improvement). */
  escalateOnFailure: boolean;
  /** Fail the security gate when zero scanners actually ran (fail-closed). */
  requireScanners: boolean;
  /** Minimum line-coverage percentage (0 = measure only, no gate). */
  minCoverage: number;
  /** Hard-fail acceptance when coverage is below the floor. */
  requireCoverage: boolean;
  /** Run mutation testing during verify (opt-in; needs a recipe + tooling). */
  mutationEnabled: boolean;
  /** Minimum mutation score percentage when mutation testing runs. */
  minMutationScore: number;
  /** Run a live-URL DAST scan against the deployed preview environment. */
  dastEnabled: boolean;
  /** Container image used for the DAST scan (OWASP ZAP baseline by default). */
  dastImage: string;
  /** Hard-fail acceptance when the live-URL DAST scan fails. */
  requireDast: boolean;
  /** Target cloud for the optional ephemeral deploy + live smoke. */
  cloud: "azure" | "aws" | "none";
  /** Override the deploy command (else derived from `cloud`). */
  deployCommand?: string;
  /** Tear the ephemeral environment down after the live smoke. */
  deployEphemeral: boolean;
  /** Skip real GitHub repo creation/push (used by offline pipeline tests). */
  offline: boolean;
  /** Isolate parallel builders in per-workstream git worktrees. */
  isolateWorktrees: boolean;
  /** Hard per-task token ceiling (0 = unlimited); flags runaway tasks. */
  maxTokensPerTask: number;
  /** Wall-clock budget for a whole run in seconds (0 = unlimited). */
  maxRunSeconds: number;
  /** Optional HARD per-task timeout in seconds (0 = rely on the stall watchdog + backstop). */
  maxTaskSeconds: number;
  /**
   * Stall watchdog: abort a turn after this many seconds with NO activity of any
   * kind (no tool call, no token, no reasoning). Progress — not elapsed time —
   * is the liveness signal. 0 disables the inactivity check.
   */
  stallInactivitySeconds: number;
  /**
   * Loop guard: abort a turn when the SAME tool call (name + args) repeats this
   * many times in a row with no other progress — the signature of a stuck agent.
   * 0 disables loop detection.
   */
  stallLoopThreshold: number;
  /** Run an interrogator that sharpens the idea into a precise brief before requirements. */
  interrogatorEnabled: boolean;
  /** Run a cheap estimate before building and gate on maxUsd. */
  preflightEstimate: boolean;
  /** Visibility timeout for a claimed job before it can be reclaimed (ms). */
  jobVisibilityMs: number;
  routing: ModelRoutingConfig;
  security: SecurityPolicyConfig;
  compliance: ComplianceProfilesConfig;
  quality: QualityStandardsConfig;
  deployment: DeploymentProfilesConfig;
  saas: SaasCapabilitiesConfig;
  stacks: StackDefaultsConfig;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

let cached: FactoryConfig | undefined;

export function loadConfig(): FactoryConfig {
  if (cached) return cached;
  const routing = loadJson<ModelRoutingConfig>("model-routing.json");
  const security = loadJson<SecurityPolicyConfig>("security-policy.json");
  const compliance = loadJson<ComplianceProfilesConfig>("compliance-profiles.json");
  const quality = loadJson<QualityStandardsConfig>("quality-standards.json");
  const deployment = loadJson<DeploymentProfilesConfig>("deployment-profiles.json");
  const saas = loadJson<SaasCapabilitiesConfig>("saas-capabilities.json");
  const stacks = loadJson<StackDefaultsConfig>("stack-defaults.json");

  cached = {
    githubOwner: env("FACTORY_GITHUB_OWNER"),
    repoVisibility: (env("FACTORY_REPO_VISIBILITY") as FactoryConfig["repoVisibility"]) ?? "private",
    githubToken: env("GITHUB_TOKEN"),
    maxParallel: Number(env("FACTORY_MAX_PARALLEL") ?? "4"),
    dataDir: resolve(REPO_ROOT, env("FACTORY_DATA_DIR") ?? ".factory"),
    workspacesDir: resolve(REPO_ROOT, env("FACTORY_WORKSPACES_DIR") ?? "workspaces"),
    webPort: Number(env("FACTORY_WEB_PORT") ?? "7788"),
    webHost: env("FACTORY_WEB_HOST") ?? "127.0.0.1",
    gates: (env("FACTORY_GATES") ?? "requirements,release").split(",").map((s) => s.trim()).filter(Boolean),
    modelDeepOverride: env("FACTORY_MODEL_DEEP"),
    modelFastOverride: env("FACTORY_MODEL_FAST"),
    wowEnabled: (env("FACTORY_WOW") ?? "true").toLowerCase() !== "false",
    wowAutoSelect: Number(env("FACTORY_WOW_COUNT") ?? "3"),
    complianceDefault: (env("FACTORY_COMPLIANCE") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    deliveryEnabled: (env("FACTORY_DELIVERY") ?? "true").toLowerCase() !== "false",
    deployEnabled: (env("FACTORY_DEPLOY") ?? "false").toLowerCase() === "true",
    verifyEnabled: (env("FACTORY_VERIFY") ?? "true").toLowerCase() !== "false",
    acceptanceEnabled: (env("FACTORY_ACCEPTANCE") ?? "true").toLowerCase() !== "false",
    discoveryEnabled: (env("FACTORY_DISCOVERY") ?? "true").toLowerCase() !== "false",
    designEnabled: (env("FACTORY_DESIGN") ?? "true").toLowerCase() !== "false",
    visualQaEnabled: (env("FACTORY_VISUAL_QA") ?? "false").toLowerCase() === "true",
    copyEnabled: (env("FACTORY_COPY") ?? "false").toLowerCase() === "true",
    bestOf: Math.max(1, Number(env("FACTORY_BEST_OF") ?? "1")),
    archCritiqueEnabled: (env("FACTORY_ARCH_CRITIQUE") ?? "false").toLowerCase() === "true",
    maxTokens: Number(env("FACTORY_MAX_TOKENS") ?? "0"),
    maxUsd: Number(env("FACTORY_MAX_USD") ?? "0"),
    usdPerMillionTokens: Number(env("FACTORY_USD_PER_MTOK") ?? "6"),
    otlpEndpoint: env("FACTORY_OTLP_ENDPOINT"),
    scaleDefault: (env("FACTORY_SCALE") ?? deployment.default).toLowerCase(),
    saasDefault: (env("FACTORY_SAAS") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    prMode: (env("FACTORY_PR_MODE") ?? "false").toLowerCase() === "true",
    escalateOnFailure: (env("FACTORY_ESCALATE") ?? "true").toLowerCase() !== "false",
    requireScanners: (env("FACTORY_REQUIRE_SCANNERS") ?? "false").toLowerCase() === "true",
    minCoverage: Number(env("FACTORY_MIN_COVERAGE") ?? "0"),
    requireCoverage: (env("FACTORY_REQUIRE_COVERAGE") ?? "false").toLowerCase() === "true",
    mutationEnabled: (env("FACTORY_MUTATION") ?? "false").toLowerCase() === "true",
    minMutationScore: Number(env("FACTORY_MIN_MUTATION_SCORE") ?? "0"),
    dastEnabled: (env("FACTORY_DAST") ?? "false").toLowerCase() === "true",
    dastImage: env("FACTORY_DAST_IMAGE") ?? "ghcr.io/zaproxy/zaproxy:stable",
    requireDast: (env("FACTORY_REQUIRE_DAST") ?? "false").toLowerCase() === "true",
    cloud: ((env("FACTORY_CLOUD") ?? "azure").toLowerCase() as FactoryConfig["cloud"]),
    deployCommand: env("FACTORY_DEPLOY_CMD"),
    deployEphemeral: (env("FACTORY_DEPLOY_EPHEMERAL") ?? "true").toLowerCase() !== "false",
    offline: (env("FACTORY_OFFLINE") ?? "false").toLowerCase() === "true",
    isolateWorktrees: (env("FACTORY_WORKTREES") ?? "true").toLowerCase() !== "false",
    maxTokensPerTask: Number(env("FACTORY_MAX_TOKENS_PER_TASK") ?? "0"),
    maxRunSeconds: Number(env("FACTORY_MAX_RUN_SECONDS") ?? "0"),
    maxTaskSeconds: Number(env("FACTORY_MAX_TASK_SECONDS") ?? "0"),
    stallInactivitySeconds: Number(env("FACTORY_STALL_INACTIVITY_SECONDS") ?? "300"),
    stallLoopThreshold: Number(env("FACTORY_STALL_LOOP_THRESHOLD") ?? "10"),
    interrogatorEnabled: (env("FACTORY_INTERROGATOR") ?? "true").toLowerCase() !== "false",
    preflightEstimate: (env("FACTORY_PREFLIGHT") ?? "false").toLowerCase() === "true",
    jobVisibilityMs: Number(env("FACTORY_JOB_VISIBILITY_MS") ?? "1800000"),
    routing,
    security,
    compliance,
    quality,
    deployment,
    saas,
    stacks,
  };
  return cached;
}
