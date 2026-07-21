import { runShell, hasTool } from "./shell.js";
import type { Logger } from "../logger.js";
import type { DeployReport } from "../types.js";
import { runDast } from "./dast.js";

export type Cloud = "azure" | "aws" | "none";

export interface DeployOptions {
  cloud: Cloud;
  /** Explicit deploy command; else derived from the cloud. */
  command?: string;
  /** Path (appended to the discovered base URL) to health-check. */
  healthPath?: string;
  /** Tear the environment down after the smoke test. */
  ephemeral?: boolean;
  /** Run a live-URL DAST scan against the deployed environment before teardown. */
  dast?: { image?: string; failOn?: "fail" | "warn" };
  commandTimeoutMs?: number;
  onLog?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Optionally deploy the app to an ephemeral cloud environment and prove it live
 * (a real URL answered 2xx) — the true definition of done. Supports Azure
 * (azd) and AWS (Copilot/SAM/configured command). Never throws; the report's
 * booleans carry ground truth so the pipeline can proceed either way.
 */
export async function deployAndSmoke(dir: string, opts: DeployOptions, log: Logger): Promise<DeployReport> {
  const cloud = opts.cloud;
  const record = (line: string) => opts.onLog?.(line);
  const commandTimeoutMs = opts.commandTimeoutMs ?? 1_800_000;

  if (cloud === "none") {
    return { attempted: false, cloud, deployed: false, method: "disabled", details: "FACTORY_CLOUD=none" };
  }

  const resolved = await resolveDeploy(cloud, opts.command, dir);
  if (!resolved) {
    return { attempted: false, cloud, deployed: false, method: "unavailable", details: `no deploy tool available for ${cloud} (need ${cloud === "azure" ? "azd" : "copilot/sam/aws"})` };
  }

  record(`$ ${resolved.command}`);
  const out: string[] = [];
  const res = await runShell(resolved.command, {
    cwd: dir,
    timeoutMs: commandTimeoutMs,
    env: cloud === "azure" ? { AZD_NON_INTERACTIVE: "true" } : {},
    onData: (_s, c) => {
      out.push(c);
      record(c.trimEnd());
    },
  });
  const stdout = out.join("");
  const deployed = res.code === 0;
  const url = extractUrl(stdout);

  let liveHealthOk: boolean | undefined;
  if (deployed && url) {
    const target = opts.healthPath ? joinUrl(url, opts.healthPath) : url;
    for (let i = 1; i <= 20; i++) {
      if (await probe(target)) {
        liveHealthOk = true;
        record(`live health OK: ${target} (attempt ${i})`);
        break;
      }
      liveHealthOk = false;
      await sleep(3000);
    }
    if (!liveHealthOk) record(`live health FAILED: ${target}`);
  }

  // Live-URL DAST: exercise the RUNNING app for real vulnerabilities (before teardown).
  let dast: DeployReport["dast"];
  if (deployed && url && opts.dast) {
    dast = await runDast(url, { ...(opts.dast.image ? { image: opts.dast.image } : {}), ...(opts.dast.failOn ? { failOn: opts.dast.failOn } : {}), onLog: opts.onLog }, log);
  }

  // Tear down the ephemeral environment.
  let tornDown: boolean | undefined;
  if (opts.ephemeral && resolved.down) {
    record(`$ ${resolved.down}`);
    const down = await runShell(resolved.down, { cwd: dir, timeoutMs: 900_000, env: cloud === "azure" ? { AZD_NON_INTERACTIVE: "true" } : {} });
    tornDown = down.code === 0;
  }

  log.info(`deploy(${cloud}): deployed=${deployed} url=${url ?? "?"} live=${liveHealthOk ?? "n/a"}`);
  return {
    attempted: true,
    cloud,
    deployed,
    ...(url ? { url } : {}),
    ...(liveHealthOk !== undefined ? { liveHealthOk } : {}),
    ...(tornDown !== undefined ? { tornDown } : {}),
    ...(dast ? { dast } : {}),
    method: resolved.command,
    details: deployed ? `exit 0${url ? `, url=${url}` : ", no URL parsed"}` : `deploy failed (exit ${res.code})`,
  };
}

async function resolveDeploy(cloud: Cloud, override: string | undefined, _dir: string): Promise<{ command: string; down?: string } | undefined> {
  if (override) return { command: override, down: undefined };
  if (cloud === "azure") {
    if (await hasTool("azd")) return { command: "azd up --no-prompt", down: "azd down --force --purge --no-prompt" };
    return undefined;
  }
  // AWS: prefer Copilot, then SAM, then require an explicit command.
  if (await hasTool("copilot")) return { command: "copilot svc deploy --all", down: "copilot app delete --yes" };
  if (await hasTool("sam")) return { command: "sam deploy --no-confirm-changeset --no-fail-on-empty-changeset", down: "sam delete --no-prompts" };
  return undefined;
}

/** Pull the first https URL out of deploy output (endpoint discovery). */
function extractUrl(text: string): string | undefined {
  const m = text.match(/https:\/\/[^\s"')]+/g);
  if (!m) return undefined;
  // Prefer an app-looking endpoint over portal/docs links.
  const preferred = m.find((u) => /azurewebsites|azurecontainerapps|amazonaws|cloudfront|elb|apprunner|execute-api/i.test(u));
  return (preferred ?? m[0]).replace(/[.,]$/, "");
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

async function probe(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
