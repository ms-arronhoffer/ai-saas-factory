import type { AcceptanceScore, AcceptanceSignals } from "../types.js";

interface Dim {
  dimension: string;
  weight: number;
  value: boolean | undefined; // undefined = not measured (excluded from scoring)
  note?: string;
}

/**
 * Compute an acceptance score from GROUND-TRUTH signals (build/test/scan/boot/
 * health), not an LLM's opinion. Unmeasured dimensions are excluded and the
 * remainder is renormalised, so the score never fabricates nor unfairly
 * penalises. Hard-gates fail the run outright when a measured critical signal is
 * false. The LLM's role is reduced to writing the summary, not deciding.
 */
export function computeAcceptance(signals: AcceptanceSignals, llmSummary?: string): AcceptanceScore {
  const complianceApplies = typeof signals.complianceGap === "number";
  const dims: Dim[] = [
    { dimension: "Build", weight: 15, value: signals.buildOk },
    { dimension: "Boots", weight: 15, value: signals.booted },
    { dimension: "Health check", weight: 15, value: signals.healthOk },
    { dimension: "Tests pass", weight: 20, value: signals.testsPassed },
    { dimension: "Test coverage floor", weight: 10, value: signals.coverageOk },
    { dimension: "Mutation score floor", weight: 5, value: signals.mutationOk },
    { dimension: "Security gate", weight: 20, value: signals.securityPassed },
    {
      dimension: "Security scanners ran",
      weight: 5,
      value: signals.scannersRan > 0,
      note: signals.scannersRan > 0 ? `${signals.scannersRan} scanner(s) ran` : "NO scanners ran — security NOT verified",
    },
    { dimension: "Live-URL DAST", weight: 10, value: signals.dastPassed },
    { dimension: "Compliance", weight: 5, value: complianceApplies ? signals.complianceGap === 0 : undefined },
    { dimension: "Live deploy health", weight: 5, value: signals.liveHealthOk },
  ];

  let earned = 0;
  let possible = 0;
  const breakdown: AcceptanceScore["breakdown"] = [];
  for (const d of dims) {
    if (d.value === undefined) {
      breakdown.push({ dimension: d.dimension, score: 0, notes: d.note ?? "not measured" });
      continue;
    }
    possible += d.weight;
    if (d.value) earned += d.weight;
    breakdown.push({ dimension: d.dimension, score: d.value ? 100 : 0, ...(d.note ? { notes: d.note } : {}) });
  }
  const score = possible > 0 ? Math.round((earned / possible) * 100) : 0;

  // Hard gates: a measured critical failure fails the run regardless of score.
  const hardFail =
    signals.booted === false ||
    signals.testsPassed === false ||
    signals.securityPassed === false ||
    signals.buildOk === false;
  const passed = score >= 70 && !hardFail;

  const summary =
    (llmSummary ? `${llmSummary.trim()}\n\n` : "") +
    `Deterministic score ${score}/100 from ${possible} measured points. ${hardFail ? "HARD GATE FAILED." : passed ? "Meets definition of done." : "Below threshold."}`;

  return { score, passed, breakdown, summary, deterministic: true, signals };
}
