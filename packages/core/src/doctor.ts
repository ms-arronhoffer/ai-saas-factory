import { runShell, hasTool } from "./tools/shell.js";
import { loadConfig } from "./config.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
  hint?: string;
}

async function version(cmd: string): Promise<string> {
  const res = await runShell(cmd, { timeoutMs: 15_000 });
  return (res.stdout || res.stderr).trim().split("\n")[0] ?? "";
}

/** Run environment preflight checks used by `factory doctor`. */
export async function runDoctor(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Node
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  results.push({
    name: "Node.js >= 22.12",
    ok: nodeMajor >= 22,
    required: true,
    detail: `v${process.versions.node}`,
    hint: "Install Node.js 22.12+ from https://nodejs.org",
  });

  // git
  const hasGit = await hasTool("git");
  results.push({ name: "git", ok: hasGit, required: true, detail: hasGit ? await version("git --version") : "not found", hint: "Install Git" });

  // GitHub CLI + auth + copilot scope
  const hasGh = await hasTool("gh");
  results.push({ name: "GitHub CLI (gh)", ok: hasGh, required: true, detail: hasGh ? await version("gh --version") : "not found", hint: "Install from https://cli.github.com" });
  if (hasGh) {
    const auth = await runShell("gh auth status", { timeoutMs: 20_000 });
    const authText = auth.stdout + auth.stderr;
    const loggedIn = /Logged in to/i.test(authText);
    results.push({ name: "gh authenticated", ok: loggedIn, required: true, detail: loggedIn ? "logged in" : "not logged in", hint: "Run: gh auth login" });
    const hasCopilotScope = /'copilot'|\bcopilot\b/.test(authText);
    results.push({
      name: "gh 'copilot' token scope",
      ok: hasCopilotScope,
      required: true,
      detail: hasCopilotScope ? "present" : "missing",
      hint: "Run: gh auth refresh --scopes copilot",
    });
  }

  // Copilot CLI (bundled by the SDK, but nice to confirm)
  const hasCopilot = await hasTool("copilot");
  results.push({ name: "Copilot CLI", ok: hasCopilot, required: false, detail: hasCopilot ? "found" : "will be provided by the SDK", hint: "npm i -g @github/copilot (optional)" });

  // Python + Docker (for generated apps and scanners)
  const hasPython = (await hasTool("python")) || (await hasTool("python3"));
  results.push({ name: "Python 3", ok: hasPython, required: false, detail: hasPython ? await version("python --version") : "not found", hint: "Needed to run/test generated FastAPI apps" });
  const hasDocker = await hasTool("docker");
  results.push({ name: "Docker", ok: hasDocker, required: false, detail: hasDocker ? await version("docker --version") : "not found", hint: "Needed for docker-compose, deterministic verify, Trivy + live-URL DAST (ZAP)" });

  // Optional scanners
  for (const tool of ["semgrep", "bandit", "pip-audit", "gitleaks", "trivy", "syft", "checkov"]) {
    const ok = await hasTool(tool);
    results.push({ name: `scanner: ${tool}`, ok, required: false, detail: ok ? "installed" : "not installed", hint: `security stage will skip ${tool} if absent` });
  }

  // Optional deploy tooling for the ephemeral deploy + live smoke (true DoD).
  const cfgCloud = (() => {
    try {
      return loadConfig().cloud;
    } catch {
      return "azure";
    }
  })();
  if (cfgCloud === "azure") {
    const hasAzd = await hasTool("azd");
    results.push({ name: "azd (Azure Developer CLI)", ok: hasAzd, required: false, detail: hasAzd ? await version("azd version") : "not found", hint: "Needed for FACTORY_DEPLOY=true on Azure: https://aka.ms/azd" });
  } else if (cfgCloud === "aws") {
    const hasCopilotAws = await hasTool("copilot");
    const hasSam = await hasTool("sam");
    const hasAws = await hasTool("aws");
    results.push({ name: "AWS deploy tooling", ok: hasCopilotAws || hasSam || hasAws, required: false, detail: [hasCopilotAws ? "copilot" : "", hasSam ? "sam" : "", hasAws ? "aws" : ""].filter(Boolean).join(", ") || "none", hint: "Install AWS Copilot, SAM, or set FACTORY_DEPLOY_CMD for FACTORY_DEPLOY=true" });
  }

  // Config load
  try {
    const cfg = loadConfig();
    results.push({ name: "config files", ok: true, required: true, detail: `stack default: ${cfg.stacks.default}; gates: ${cfg.gates.join(",")}` });
  } catch (err) {
    results.push({ name: "config files", ok: false, required: true, detail: String(err), hint: "check config/*.json" });
  }

  return results;
}
