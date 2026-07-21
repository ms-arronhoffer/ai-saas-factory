import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SecurityFinding, SecurityReport } from "../types.js";
import type { SecurityPolicyConfig } from "../config.js";
import { runShell, hasTool } from "./shell.js";
import type { Logger } from "../logger.js";

type Severity = SecurityFinding["severity"];

function normSeverity(raw: string | undefined): Severity {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("crit")) return "critical";
  if (s.includes("high") || s === "error") return "high";
  if (s.includes("med") || s === "warning" || s === "moderate") return "medium";
  if (s.includes("low")) return "low";
  return "info";
}

function safeParse<T>(text: string): T | undefined {
  try {
    // Some tools print a leading banner; grab the first JSON object/array.
    const start = text.search(/[[{]/);
    if (start < 0) return undefined;
    return JSON.parse(text.slice(start)) as T;
  } catch {
    return undefined;
  }
}

function parseSemgrep(out: string): SecurityFinding[] {
  const json = safeParse<{ results?: Array<{ check_id: string; path: string; extra?: { severity?: string; message?: string } }> }>(out);
  return (json?.results ?? []).map((r) => ({
    scanner: "semgrep",
    kind: "sast" as const,
    severity: normSeverity(r.extra?.severity),
    title: r.extra?.message ?? r.check_id,
    location: r.path,
  }));
}

function parseBandit(out: string): SecurityFinding[] {
  const json = safeParse<{ results?: Array<{ issue_severity: string; issue_text: string; filename: string; line_number: number }> }>(out);
  return (json?.results ?? []).map((r) => ({
    scanner: "bandit",
    kind: "sast" as const,
    severity: normSeverity(r.issue_severity),
    title: r.issue_text,
    location: `${r.filename}:${r.line_number}`,
  }));
}

function parseNpmAudit(out: string): SecurityFinding[] {
  const json = safeParse<{ vulnerabilities?: Record<string, { severity: string; via: unknown[] }> }>(out);
  const findings: SecurityFinding[] = [];
  for (const [name, v] of Object.entries(json?.vulnerabilities ?? {})) {
    findings.push({
      scanner: "npm-audit",
      kind: "dependency",
      severity: normSeverity(v.severity),
      title: `Vulnerable dependency: ${name}`,
      location: name,
    });
  }
  return findings;
}

function parsePipAudit(out: string): SecurityFinding[] {
  const json = safeParse<{ dependencies?: Array<{ name: string; vulns?: Array<{ id: string; fix_versions?: string[] }> }> } | Array<{ name: string; vulns?: Array<{ id: string }> }>>(out);
  const deps = Array.isArray(json) ? json : json?.dependencies ?? [];
  const findings: SecurityFinding[] = [];
  for (const d of deps) {
    for (const v of d.vulns ?? []) {
      findings.push({
        scanner: "pip-audit",
        kind: "dependency",
        severity: "high",
        title: `${d.name}: ${v.id}`,
        location: d.name,
      });
    }
  }
  return findings;
}

function parseGitleaks(dir: string): SecurityFinding[] {
  const path = join(dir, "gitleaks-report.json");
  if (!existsSync(path)) return [];
  const json = safeParse<Array<{ Description: string; File: string; RuleID: string }>>(readFileSync(path, "utf8"));
  return (json ?? []).map((r) => ({
    scanner: "gitleaks",
    kind: "secret" as const,
    severity: "critical" as const,
    title: r.Description || r.RuleID,
    location: r.File,
  }));
}

function parseTrivy(out: string): SecurityFinding[] {
  const json = safeParse<{ Results?: Array<{ Target: string; Vulnerabilities?: Array<{ Severity: string; VulnerabilityID: string; PkgName: string }>; Secrets?: Array<{ Severity: string; Title: string }>; Misconfigurations?: Array<{ Severity: string; Title: string }> }> }>(out);
  const findings: SecurityFinding[] = [];
  for (const r of json?.Results ?? []) {
    for (const v of r.Vulnerabilities ?? []) {
      findings.push({ scanner: "trivy", kind: "dependency", severity: normSeverity(v.Severity), title: `${v.PkgName}: ${v.VulnerabilityID}`, location: r.Target });
    }
    for (const s of r.Secrets ?? []) {
      findings.push({ scanner: "trivy", kind: "secret", severity: normSeverity(s.Severity), title: s.Title, location: r.Target });
    }
    for (const m of r.Misconfigurations ?? []) {
      findings.push({ scanner: "trivy", kind: "container", severity: normSeverity(m.Severity), title: m.Title, location: r.Target });
    }
  }
  return findings;
}

function parseCheckov(out: string): SecurityFinding[] {
  const json = safeParse<{ results?: { failed_checks?: Array<{ check_id: string; check_name: string; severity?: string; file_path?: string }> } }>(out);
  return (json?.results?.failed_checks ?? []).map((c) => ({
    scanner: "checkov",
    kind: "iac" as const,
    severity: normSeverity(c.severity ?? "medium"),
    title: `${c.check_id}: ${c.check_name}`,
    location: c.file_path,
  }));
}

/** Evaluate licenses from a CycloneDX SBOM (produced by syft) against the deny policy. */
export function evaluateLicenses(dir: string, deny: string[], flagUnknown: boolean): SecurityFinding[] {
  const path = join(dir, "sbom.cdx.json");
  if (!existsSync(path)) return [];
  const denySet = new Set(deny.map((d) => d.toLowerCase()));
  const json = safeParse<{ components?: Array<{ name?: string; version?: string; licenses?: Array<{ license?: { id?: string; name?: string }; expression?: string }> }> }>(readFileSync(path, "utf8"));
  const findings: SecurityFinding[] = [];
  for (const c of json?.components ?? []) {
    const ids = (c.licenses ?? [])
      .map((l) => l.license?.id ?? l.license?.name ?? l.expression)
      .filter((x): x is string => !!x);
    if (ids.length === 0 && flagUnknown) {
      findings.push({ scanner: "license", kind: "license", severity: "medium", title: `Unknown license: ${c.name}`, location: c.name });
      continue;
    }
    for (const id of ids) {
      if (denySet.has(id.toLowerCase())) {
        findings.push({ scanner: "license", kind: "license", severity: "high", title: `Disallowed license ${id}: ${c.name}${c.version ? `@${c.version}` : ""}`, location: c.name });
      }
    }
  }
  return findings;
}

const PARSERS: Record<string, (out: string, dir: string) => SecurityFinding[]> = {
  semgrep: (o) => parseSemgrep(o),
  bandit: (o) => parseBandit(o),
  "npm-audit": (o) => parseNpmAudit(o),
  "pip-audit": (o) => parsePipAudit(o),
  gitleaks: (_o, dir) => parseGitleaks(dir),
  trivy: (o) => parseTrivy(o),
  checkov: (o) => parseCheckov(o),
  syft: () => [], // SBOM only; licenses evaluated separately
  zap: () => [],
};

/** Which languages are present in the project (drives appliesTo filtering). */
export function detectLanguages(dir: string): string[] {
  const langs = new Set<string>();
  if (existsSync(join(dir, "package.json"))) langs.add("node");
  if (existsSync(join(dir, "web", "package.json"))) langs.add("node");
  if (existsSync(join(dir, "requirements.txt")) || existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "api", "requirements.txt"))) langs.add("python");
  return [...langs];
}

/**
 * Run all enabled, applicable scanners that are installed. Missing scanners are
 * skipped (reported via logger) rather than failing the run. Returns the merged
 * finding list.
 */
export async function runScanners(
  dir: string,
  policy: SecurityPolicyConfig,
  log: Logger,
  onFinding?: (f: SecurityFinding) => void,
): Promise<{ findings: SecurityFinding[]; skipped: string[]; ran: string[] }> {
  const languages = detectLanguages(dir);
  const findings: SecurityFinding[] = [];
  const skipped: string[] = [];
  const ran: string[] = [];

  for (const [name, cfg] of Object.entries(policy.scanners)) {
    if (!cfg.enabled) continue;
    if (cfg.appliesTo && !cfg.appliesTo.some((l) => languages.includes(l))) {
      log.debug(`scanner ${name} not applicable (langs: ${languages.join(",") || "none"})`);
      continue;
    }
    const bin = cfg.command.split(/\s+/)[0]!;
    if (!(await hasTool(bin))) {
      log.warn(`scanner ${name} not installed (${cfg.installHint ?? bin}); skipping`);
      skipped.push(name);
      continue;
    }
    log.info(`running scanner: ${name}`);
    const res = await runShell(cfg.command, { cwd: dir, timeoutMs: 300_000 });
    ran.push(name);
    const parser = PARSERS[name];
    const parsed = parser ? parser(res.stdout || res.stderr, dir) : [];
    for (const f of parsed) {
      findings.push(f);
      onFinding?.(f);
    }
    log.info(`scanner ${name}: ${parsed.length} finding(s)`);

    // After the SBOM scanner runs, evaluate licenses against the deny policy.
    if (name === "syft" && policy.licensePolicy) {
      const licenseFindings = evaluateLicenses(dir, policy.licensePolicy.deny, !!policy.licensePolicy.flagUnknown);
      for (const f of licenseFindings) {
        findings.push(f);
        onFinding?.(f);
      }
      if (licenseFindings.length) log.info(`license policy: ${licenseFindings.length} disallowed license(s)`);
    }
  }

  return { findings, skipped, ran };
}

/** Count findings by severity/kind and evaluate against the policy gates. */
export function evaluate(findings: SecurityFinding[], policy: SecurityPolicyConfig, iteration: number): SecurityReport {
  const counts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    counts[`kind:${f.kind}`] = (counts[`kind:${f.kind}`] ?? 0) + 1;
  }
  const critical = counts["critical"] ?? 0;
  const high = counts["high"] ?? 0;
  const secrets = findings.filter((f) => f.kind === "secret").length;
  const deniedLicenses = findings.filter((f) => f.kind === "license").length;
  const iacHigh = findings.filter((f) => f.kind === "iac" && (f.severity === "high" || f.severity === "critical")).length;

  const passed =
    critical <= policy.gates.maxCritical &&
    high <= policy.gates.maxHigh &&
    secrets <= policy.gates.maxSecrets &&
    deniedLicenses <= (policy.gates.maxDeniedLicenses ?? 0) &&
    iacHigh <= (policy.gates.maxIacHigh ?? Number.MAX_SAFE_INTEGER);

  return { iteration, findings, passed, counts };
}
