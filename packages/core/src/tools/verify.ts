import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runShell, hasTool } from "./shell.js";
import type { Logger } from "../logger.js";
import type { VerifyReport } from "../types.js";

export interface RunRecipe {
  up?: string;
  down?: string;
  healthUrl?: string;
  /** Optional frontend/UI URL to probe so the built UI is verified as serving. */
  frontendUrl?: string;
  test?: string[];
  coverage?: Array<{ cmd: string; file: string }>;
  mutation?: string;
}

export interface VerifyOptions {
  /** Poll attempts for the health endpoint. */
  healthAttempts?: number;
  /** Delay between health polls (ms). */
  healthDelayMs?: number;
  /** Timeout per shell command (ms). */
  commandTimeoutMs?: number;
  /** Minimum line-coverage floor (0 = measure only, no gate). */
  minCoverage?: number;
  /** Run mutation testing (opt-in; needs a recipe + tooling). */
  mutation?: boolean;
  /** Minimum mutation score floor when mutation testing runs. */
  minMutationScore?: number;
  onLog?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Deterministically prove the app runs: bring it up (docker compose or the
 * stack recipe), poll its health endpoint with retries, run the test suite, and
 * tear it down — capturing real exit codes and logs. The truth is the exit
 * codes, not any agent's claim. Degrades gracefully (never throws) so the
 * pipeline can proceed; the report's booleans carry the ground truth.
 */
export async function runVerification(
  dir: string,
  recipe: RunRecipe | undefined,
  log: Logger,
  opts: VerifyOptions = {},
): Promise<VerifyReport> {
  const commands: Array<{ cmd: string; exit: number }> = [];
  const logs: string[] = [];
  const record = (line: string) => {
    logs.push(line);
    opts.onLog?.(line);
  };
  const commandTimeoutMs = opts.commandTimeoutMs ?? 300_000;

  const hasCompose = existsSync(join(dir, "docker-compose.yml")) || existsSync(join(dir, "compose.yaml")) || existsSync(join(dir, "docker-compose.yaml"));
  const upCmd = recipe?.up ?? (hasCompose ? "docker compose up -d --build" : undefined);
  const downCmd = recipe?.down ?? (hasCompose ? "docker compose down -v" : undefined);
  const dockerReady = hasCompose && (await hasTool("docker"));

  let booted = false;
  let healthOk = false;
  let buildOk: boolean | undefined;
  let testsPassed: boolean | undefined;
  let testExit: number | undefined;

  // 1. Boot the app.
  if (upCmd && dockerReady) {
    record(`$ ${upCmd}`);
    const up = await runShell(upCmd, { cwd: dir, timeoutMs: commandTimeoutMs, onData: (_s, c) => record(c.trimEnd()) });
    commands.push({ cmd: upCmd, exit: up.code });
    buildOk = up.code === 0;
    booted = up.code === 0;
    if (!booted) record(`compose up failed (exit ${up.code})`);
  } else if (upCmd && !dockerReady) {
    record("docker not available — skipping boot (verify is INCONCLUSIVE, not passed)");
  } else {
    record("no run recipe / compose file — skipping boot");
  }

  // 2. Poll the health endpoint.
  const healthUrl = recipe?.healthUrl;
  if (booted && healthUrl) {
    const attempts = opts.healthAttempts ?? 30;
    const delay = opts.healthDelayMs ?? 2000;
    for (let i = 1; i <= attempts; i++) {
      const ok = await probe(healthUrl);
      if (ok) {
        healthOk = true;
        record(`health OK: ${healthUrl} (attempt ${i})`);
        break;
      }
      if (i === attempts) record(`health FAILED after ${attempts} attempts: ${healthUrl}`);
      await sleep(delay);
    }
  }

  // 2b. Poll the frontend/UI so the built UI is verified as actually SERVING,
  //     not merely compiled. Frontend dev/prod servers can be slow to warm up.
  const frontendUrl = recipe?.frontendUrl;
  let frontendOk: boolean | undefined;
  if (booted && frontendUrl) {
    const attempts = opts.healthAttempts ?? 30;
    const delay = opts.healthDelayMs ?? 2000;
    frontendOk = false;
    for (let i = 1; i <= attempts; i++) {
      if (await probe(frontendUrl)) {
        frontendOk = true;
        record(`frontend OK: ${frontendUrl} (attempt ${i})`);
        break;
      }
      if (i === attempts) record(`frontend FAILED after ${attempts} attempts: ${frontendUrl}`);
      await sleep(delay);
    }
  }

  // 3. Run the test suite (deterministic pass/fail).
  const tests = recipe?.test ?? [];
  if (tests.length > 0) {
    testsPassed = true;
    for (const t of tests) {
      record(`$ ${t}`);
      const res = await runShell(t, { cwd: dir, timeoutMs: commandTimeoutMs, onData: (_s, c) => record(c.trimEnd()) });
      commands.push({ cmd: t, exit: res.code });
      testExit = res.code;
      if (res.code !== 0) {
        testsPassed = false;
        record(`tests FAILED (exit ${res.code}): ${t}`);
      }
    }
  }

  // 3b. TEST-QUALITY proof: coverage floor (deterministic gate on how much the
  //     tests actually exercise) and, opt-in, mutation score (do the tests
  //     actually catch injected bugs). "Tests pass" is a floor; this is depth.
  const minCoverage = opts.minCoverage ?? 0;
  let coveragePct: number | undefined;
  let coverageOk: boolean | undefined;
  const covRecipes = recipe?.coverage ?? [];
  if (covRecipes.length > 0) {
    const pcts: number[] = [];
    for (const c of covRecipes) {
      record(`$ ${c.cmd}`);
      const res = await runShell(c.cmd, { cwd: dir, timeoutMs: commandTimeoutMs, onData: (_s, l) => record(l.trimEnd()) });
      commands.push({ cmd: c.cmd, exit: res.code });
      const pct = parseCoverageFile(join(dir, c.file));
      if (pct !== undefined) {
        pcts.push(pct);
        record(`coverage(${c.file}): ${pct.toFixed(1)}%`);
      } else {
        record(`coverage(${c.file}): not produced/parsable — skipped`);
      }
    }
    if (pcts.length > 0) {
      coveragePct = pcts.reduce((a, b) => a + b, 0) / pcts.length;
      coverageOk = minCoverage > 0 ? coveragePct >= minCoverage : undefined;
      record(`coverage avg: ${coveragePct.toFixed(1)}%${minCoverage > 0 ? ` (floor ${minCoverage}% → ${coverageOk ? "PASS" : "FAIL"})` : " (report only)"}`);
    }
  }

  let mutationScore: number | undefined;
  let mutationOk: boolean | undefined;
  if (opts.mutation && recipe?.mutation) {
    record(`$ ${recipe.mutation}`);
    const res = await runShell(recipe.mutation, { cwd: dir, timeoutMs: Math.max(commandTimeoutMs, 900_000), onData: (_s, l) => record(l.trimEnd()) });
    commands.push({ cmd: recipe.mutation, exit: res.code });
    mutationScore = parseMutationScore(res.stdout + res.stderr);
    if (mutationScore !== undefined) {
      const floor = opts.minMutationScore ?? 0;
      mutationOk = floor > 0 ? mutationScore >= floor : undefined;
      record(`mutation score: ${mutationScore.toFixed(1)}%${floor > 0 ? ` (floor ${floor}% → ${mutationOk ? "PASS" : "FAIL"})` : " (report only)"}`);
    } else {
      record("mutation score not parsable — skipped");
    }
  }

  // 4. Tear down.
  if (booted && downCmd && dockerReady) {
    record(`$ ${downCmd}`);
    const down = await runShell(downCmd, { cwd: dir, timeoutMs: 120_000 });
    commands.push({ cmd: downCmd, exit: down.code });
  }

  const smokePassed = booted && (healthUrl ? healthOk : true) && (frontendUrl ? frontendOk === true : true) && (tests.length ? testsPassed === true : true);
  const method = dockerReady ? "docker-compose + health poll + test suite" : tests.length ? "test suite only (no docker)" : "no harness available";
  const logsTail = logs.slice(-40).join("\n").slice(-4000);
  log.info(`verify: booted=${booted} health=${healthOk}${frontendUrl ? ` frontend=${frontendOk}` : ""} tests=${testsPassed ?? "n/a"}`);

  return {
    booted,
    healthOk: healthUrl ? healthOk : booted,
    smokePassed,
    method,
    details: `booted=${booted}, healthOk=${healthOk}, testsPassed=${testsPassed ?? "n/a"}`,
    deterministic: true,
    ...(buildOk !== undefined ? { buildOk } : {}),
    ...(frontendOk !== undefined ? { frontendOk } : {}),
    ...(testsPassed !== undefined ? { testsPassed } : {}),
    ...(testExit !== undefined ? { testExit } : {}),
    ...(coveragePct !== undefined ? { coveragePct } : {}),
    ...(coverageOk !== undefined ? { coverageOk } : {}),
    ...(mutationScore !== undefined ? { mutationScore } : {}),
    ...(mutationOk !== undefined ? { mutationOk } : {}),
    commands,
    logsTail,
  };
}

/** GET a URL with a short timeout; true on a 2xx/3xx response. */
async function probe(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a line-coverage percentage from a coverage summary file. Supports
 * coverage.py JSON (`totals.percent_covered`), Istanbul/vitest/jest
 * `coverage-summary.json` (`total.lines.pct`), and Cobertura XML (`line-rate`).
 */
export function parseCoverageFile(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(text) as {
        totals?: { percent_covered?: number };
        total?: { lines?: { pct?: number } };
      };
      if (typeof json.totals?.percent_covered === "number") return clampPct(json.totals.percent_covered);
      if (typeof json.total?.lines?.pct === "number") return clampPct(json.total.lines.pct);
    } catch {
      return undefined;
    }
    return undefined;
  }
  // Cobertura XML: <coverage ... line-rate="0.87" ...>
  const m = text.match(/line-rate="([0-9.]+)"/);
  if (m && m[1]) return clampPct(Number(m[1]) * 100);
  return undefined;
}

/** Parse a mutation score percentage from common tool outputs (Stryker/mutmut). */
export function parseMutationScore(out: string): number | undefined {
  // Stryker: "Mutation score: 82.35%" or a summary table "All files | 82.35 |"
  const label = out.match(/mutation score[^0-9]*([0-9]+(?:\.[0-9]+)?)\s*%/i);
  if (label && label[1]) return clampPct(Number(label[1]));
  const stryker = out.match(/All files\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|/i);
  if (stryker && stryker[1]) return clampPct(Number(stryker[1]));
  // mutmut results: "killed: 40  survived: 10" → killed/(killed+survived)
  const killed = out.match(/killed[^0-9]*([0-9]+)/i);
  const survived = out.match(/survived[^0-9]*([0-9]+)/i);
  if (killed && survived) {
    const k = Number(killed[1]);
    const s = Number(survived[1]);
    if (k + s > 0) return clampPct((k / (k + s)) * 100);
  }
  return undefined;
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}
