/** Extract the last fenced ```json block (or a bare JSON object) from agent text. */
export function extractJson<T>(text: string): T | undefined {
  const fenceRe = /```json\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let last: string | undefined;
  while ((match = fenceRe.exec(text)) !== null) {
    last = match[1];
  }
  const candidate = last ?? firstBalancedObject(text);
  if (!candidate) return undefined;
  try {
    return JSON.parse(candidate.trim()) as T;
  } catch {
    return undefined;
  }
}

/** Find the first balanced {...} region as a fallback when no fence is present. */
function firstBalancedObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Kebab-case a string into something safe for a repo/directory name. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "saas-app";
}

/** Case-insensitively dedupe a list of feature strings, preserving first-seen order. */
export function dedupeFeatures(features: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of features) {
    const f = raw.trim();
    if (!f) continue;
    const key = f.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/**
 * Merge the spec's own core features with the parity checklist so the union of
 * required capabilities is guaranteed to be represented in coreFeatures.
 */
export function mergeParity(coreFeatures: string[], parity: string[]): string[] {
  return dedupeFeatures([...coreFeatures, ...parity]);
}

/**
 * Rank wow features by (impact desc, effort asc) and return the ids of the top n.
 * Deterministic: ties keep original order.
 */
export function rankWow<T extends { id: string; impact?: string; effort?: string }>(features: T[], n: number): string[] {
  const weight = (v: string | undefined, high: number, mid: number, low: number): number => {
    switch ((v ?? "medium").toLowerCase()) {
      case "high":
        return high;
      case "low":
        return low;
      default:
        return mid;
    }
  };
  return features
    .map((f, i) => ({ f, i, score: weight(f.impact, 3, 2, 1) * 10 - weight(f.effort, 3, 2, 1) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, Math.max(0, n))
    .map((x) => x.f.id);
}

/** Estimate USD cost from a token count using a blended per-million-token price. */
export function estimateUsd(tokens: number, usdPerMillionTokens: number): number {
  return (tokens / 1_000_000) * usdPerMillionTokens;
}
