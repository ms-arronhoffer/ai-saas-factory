import { runShell, hasTool } from "./shell.js";
import type { Logger } from "../logger.js";
import type { DastReport } from "../types.js";

export interface DastOptions {
  /** Container image for the scan (OWASP ZAP baseline by default). */
  image?: string;
  /** "fail" = fail only on FAIL findings; "warn" = also fail on warnings. */
  failOn?: "fail" | "warn";
  /** Spider duration in minutes (kept short for CI-speed scans). */
  minutes?: number;
  timeoutMs?: number;
  onLog?: (line: string) => void;
}

/**
 * Run a dynamic application security test against a LIVE url (the deployed
 * preview environment) using the OWASP ZAP baseline scan in Docker. This is
 * real runtime security — it exercises the running app, not the source — and
 * complements the static scanners. Never throws; the report's booleans carry
 * ground truth so the pipeline can proceed.
 */
export async function runDast(url: string, opts: DastOptions, log: Logger): Promise<DastReport> {
  const image = opts.image ?? "ghcr.io/zaproxy/zaproxy:stable";
  const failOn = opts.failOn ?? "fail";
  const minutes = opts.minutes ?? 1;
  const record = (line: string) => opts.onLog?.(line);

  if (!(await hasTool("docker"))) {
    return { ran: false, passed: false, warnings: 0, fails: 0, method: `${image} (docker unavailable)`, details: "docker not available — DAST is INCONCLUSIVE, not passed" };
  }

  // zap-baseline.py spiders + runs passive scan rules; exit 0=clean, 1=fails,
  // 2=warns only, 3=error. We parse the summary counts regardless of exit code.
  const cmd = `docker run --rm -t ${image} zap-baseline.py -t ${shellQuote(url)} -m ${minutes}`;
  record(`$ ${cmd}`);
  const out: string[] = [];
  const res = await runShell(cmd, {
    timeoutMs: opts.timeoutMs ?? 600_000,
    onData: (_s, c) => {
      out.push(c);
      record(c.trimEnd());
    },
  });
  const text = out.join("");

  const fails = sumMatches(text, /FAIL-NEW:\s*(\d+)/gi) + sumMatches(text, /FAIL-INPROG:\s*(\d+)/gi);
  const warnings = sumMatches(text, /WARN-NEW:\s*(\d+)/gi) + sumMatches(text, /WARN-INPROG:\s*(\d+)/gi);
  const parsed = /FAIL-NEW:|WARN-NEW:/i.test(text);
  // If we couldn't parse a summary, fall back to the exit code (3 = error).
  const errored = res.code === 3 || (!parsed && res.code !== 0 && res.code !== 2);
  const passed = errored ? false : failOn === "warn" ? fails === 0 && warnings === 0 : fails === 0;

  log.info(`dast: fails=${fails} warnings=${warnings} passed=${passed}`);
  return {
    ran: !errored || parsed,
    passed,
    warnings,
    fails,
    method: `OWASP ZAP baseline (${image})`,
    details: errored ? `scan errored (exit ${res.code})` : `${fails} fail(s), ${warnings} warning(s); gate=${failOn}`,
  };
}

function sumMatches(text: string, re: RegExp): number {
  let total = 0;
  for (const m of text.matchAll(re)) total += Number(m[1] ?? 0);
  return total;
}

function shellQuote(value: string): string {
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
