import { mkdirSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EvalRecord } from "../types.js";

export interface EvalAggregate {
  count: number;
  passRate: number;
  avgAcceptance: number;
  avgCostUsd: number;
  securityPassRate: number;
}

export interface RegressionCheck {
  regressed: boolean;
  reasons: string[];
  current: EvalRecord;
  baseline?: EvalAggregate;
}

/**
 * Append-only evaluation corpus. Every completed run contributes a scored row,
 * so we can track quality/cost trends and flag regressions vs a rolling
 * baseline — the substrate for the factory's self-improvement loop.
 */
export class EvalStore {
  private readonly file: string;

  constructor(dataDir: string) {
    const dir = resolve(dataDir);
    mkdirSync(dir, { recursive: true });
    this.file = resolve(dir, "evals.jsonl");
  }

  record(rec: EvalRecord): void {
    appendFileSync(this.file, `${JSON.stringify(rec)}\n`, "utf8");
  }

  all(): EvalRecord[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as EvalRecord;
        } catch {
          return undefined;
        }
      })
      .filter((r): r is EvalRecord => Boolean(r));
  }

  aggregate(records = this.all()): EvalAggregate {
    const n = records.length || 1;
    const withAcc = records.filter((r) => typeof r.acceptance === "number");
    const withCost = records.filter((r) => typeof r.costUsd === "number");
    const withSec = records.filter((r) => typeof r.securityPassed === "boolean");
    return {
      count: records.length,
      passRate: records.filter((r) => r.status === "completed").length / n,
      avgAcceptance: avg(withAcc.map((r) => r.acceptance ?? 0)),
      avgCostUsd: avg(withCost.map((r) => r.costUsd ?? 0)),
      securityPassRate: withSec.length ? withSec.filter((r) => r.securityPassed).length / withSec.length : 1,
    };
  }

  /** Compare a fresh record against the baseline of prior runs. */
  checkRegression(current: EvalRecord): RegressionCheck {
    const prior = this.all().filter((r) => r.runId !== current.runId);
    if (prior.length < 3) return { regressed: false, reasons: [], current };
    const baseline = this.aggregate(prior);
    const reasons: string[] = [];
    if (typeof current.acceptance === "number" && current.acceptance + 10 < baseline.avgAcceptance) {
      reasons.push(`acceptance ${current.acceptance} well below baseline ${baseline.avgAcceptance.toFixed(0)}`);
    }
    if (current.securityPassed === false && baseline.securityPassRate > 0.8) {
      reasons.push("security gate failed against a mostly-passing baseline");
    }
    if (typeof current.costUsd === "number" && baseline.avgCostUsd > 0 && current.costUsd > baseline.avgCostUsd * 2) {
      reasons.push(`cost $${current.costUsd.toFixed(2)} more than 2x baseline $${baseline.avgCostUsd.toFixed(2)}`);
    }
    return { regressed: reasons.length > 0, reasons, current, baseline };
  }
}

function avg(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
