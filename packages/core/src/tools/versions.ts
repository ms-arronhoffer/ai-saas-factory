import type { Logger } from "../logger.js";
import type { StackDef } from "../config.js";

/**
 * Resolve the CURRENT stable version of each runtime at build time rather than
 * freezing an old number in a template. Versions age fast; a factory that ships
 * Postgres 16 / Node 22 in 2026 is shipping something stale on day one.
 *
 * Source of truth is endoflife.date (a small, cached JSON API that tracks every
 * product's release cycles + latest patch + EOL date). We pick the newest cycle
 * that is still supported, and fall back to a sane pinned value when offline or
 * if the lookup fails — so a run is never blocked on the network.
 */
export interface ResolvedRuntime {
  key: string;
  label: string;
  /** Full latest version, e.g. "18.4" or "26.5.0". */
  version: string;
  /** Major (image) tag, e.g. "18", "26", "3.13". */
  major: string;
  /** Container image reference using a floating tag so the latest patch is pulled. */
  image: string;
  /** Whether this came from the live lookup or the offline fallback. */
  source: "resolved" | "fallback";
}

interface RuntimeSpec {
  key: string;
  label: string;
  /** endoflife.date product slug. */
  product: string;
  image: (major: string) => string;
  /** Offline/failure fallback (kept current with the latest known stable). */
  fallback: { version: string; major: string };
}

/** Known runtimes the factory's stacks build on. */
const REGISTRY: Record<string, RuntimeSpec> = {
  node: {
    key: "node",
    label: "Node.js",
    product: "nodejs",
    image: (m) => `node:${m}-alpine`,
    fallback: { version: "26.5.0", major: "26" },
  },
  python: {
    key: "python",
    label: "Python",
    product: "python",
    image: (m) => `python:${m}-slim`,
    fallback: { version: "3.13.5", major: "3.13" },
  },
  postgresql: {
    key: "postgresql",
    label: "PostgreSQL",
    product: "postgresql",
    image: (m) => `postgres:${m}-alpine`,
    fallback: { version: "18.4", major: "18" },
  },
  nginx: {
    key: "nginx",
    label: "nginx",
    product: "nginx",
    image: () => `nginx:stable-alpine`,
    fallback: { version: "1.29", major: "1.29" },
  },
};

interface EolCycle {
  cycle: string;
  latest?: string;
  eol?: boolean | string;
  releaseDate?: string;
}

export interface ResolveOptions {
  offline?: boolean;
  timeoutMs?: number;
  log?: Logger;
}

/** Derive which runtimes a stack builds on, from its languages + database. */
export function runtimeKeysForStack(stack: StackDef): string[] {
  const keys = new Set<string>();
  for (const lang of stack.languages ?? []) {
    const l = lang.toLowerCase();
    if (l.includes("node") || l.includes("typescript") || l.includes("javascript")) keys.add("node");
    if (l.includes("python")) keys.add("python");
  }
  const engine = (stack.database?.engine ?? "").toLowerCase();
  if (engine.includes("postgres")) keys.add("postgresql");
  // A separately-served frontend implies a static/edge web server (nginx).
  if (stack.frontend && Object.keys(stack.frontend).length > 0) keys.add("nginx");
  return [...keys];
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Newest still-supported cycle that actually has a published latest patch. */
function pickCycle(cycles: EolCycle[]): EolCycle | undefined {
  const now = Date.now();
  const supported = cycles.filter((c) => {
    if (!c.latest) return false;
    if (c.eol === true) return false;
    if (typeof c.eol === "string" && Date.parse(c.eol) < now) return false;
    // Skip obvious pre-releases (rc/beta/alpha) that slip into `latest`.
    if (/[a-z]/i.test(c.latest) && /(rc|alpha|beta|preview)/i.test(c.latest)) return false;
    return true;
  });
  supported.sort((a, b) => parseFloat(b.cycle) - parseFloat(a.cycle));
  return supported[0];
}

async function resolveOne(spec: RuntimeSpec, opts: ResolveOptions): Promise<ResolvedRuntime> {
  const fallback: ResolvedRuntime = {
    key: spec.key,
    label: spec.label,
    version: spec.fallback.version,
    major: spec.fallback.major,
    image: spec.image(spec.fallback.major),
    source: "fallback",
  };
  if (opts.offline) return fallback;
  try {
    const data = (await fetchJson(`https://endoflife.date/api/${spec.product}.json`, opts.timeoutMs ?? 4000)) as EolCycle[];
    const pick = Array.isArray(data) ? pickCycle(data) : undefined;
    if (pick?.latest) {
      const major = String(pick.cycle);
      return { key: spec.key, label: spec.label, version: String(pick.latest), major, image: spec.image(major), source: "resolved" };
    }
  } catch (err) {
    opts.log?.debug?.(`version lookup for ${spec.product} failed (${err instanceof Error ? err.message : String(err)}); using fallback ${spec.fallback.version}`);
  }
  return fallback;
}

/** Resolve current stable versions for the given runtime keys (unknown keys ignored). */
export async function resolveRuntimes(keys: string[], opts: ResolveOptions = {}): Promise<ResolvedRuntime[]> {
  const specs = keys.map((k) => REGISTRY[k]).filter((s): s is RuntimeSpec => !!s);
  return Promise.all(specs.map((s) => resolveOne(s, opts)));
}
