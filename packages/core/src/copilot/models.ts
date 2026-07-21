import type { ModelRoutingConfig } from "../config.js";
import type { AgentRole, ModelTier } from "../types.js";
import type { Logger } from "../logger.js";

export interface ResolvedModel {
  id: string;
  tier: ModelTier;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
}

/**
 * Resolves factory agent roles to concrete Copilot model IDs. Because the exact
 * IDs for "Claude Opus 4.8" / "Sonnet 5.0" vary by entitlement and change over
 * time, we discover the available models from the SDK at startup and match them
 * against the ordered preference list in config/model-routing.json.
 */
export class ModelRouter {
  private available: string[] = [];
  private readonly resolved = new Map<ModelTier, ResolvedModel>();

  constructor(
    private readonly routing: ModelRoutingConfig,
    private readonly log: Logger,
    private readonly overrides: { deep?: string; fast?: string } = {},
  ) {}

  /**
   * Discover available models from the client. The SDK exposes model discovery;
   * we call it defensively and fall back to configured defaults on any error.
   */
  async initialize(client: unknown): Promise<void> {
    this.available = await this.discover(client);
    if (this.available.length > 0) {
      this.log.info(`discovered ${this.available.length} model(s): ${this.available.join(", ")}`);
    } else {
      this.log.warn("could not discover models from SDK; using configured fallbacks");
    }
    this.resolveTier("deep", this.overrides.deep);
    this.resolveTier("fast", this.overrides.fast);
  }

  private async discover(client: unknown): Promise<string[]> {
    const c = client as { listModels?: () => Promise<unknown> | unknown };
    if (typeof c?.listModels !== "function") return [];
    try {
      const raw = await c.listModels();
      const list = Array.isArray(raw) ? raw : [];
      return list
        .map((m) => {
          if (typeof m === "string") return m;
          const obj = m as { id?: string; name?: string; model?: string };
          return obj.id ?? obj.model ?? obj.name;
        })
        .filter((id): id is string => typeof id === "string");
    } catch (err) {
      this.log.warn(`listModels() failed: ${String(err)}`);
      return [];
    }
  }

  private resolveTier(tier: ModelTier, override?: string): void {
    const cfg = this.routing.tiers[tier];
    let chosen: string | undefined = override;

    if (!chosen && this.available.length > 0) {
      chosen = cfg.preferred.find((p) => this.available.includes(p));
      if (!chosen) {
        // Loose match: same family prefix (e.g. "claude-opus").
        const family = cfg.preferred[0]?.split(/[-.]/).slice(0, 2).join("-");
        if (family) chosen = this.available.find((a) => a.startsWith(family));
      }
    }
    if (!chosen) chosen = cfg.preferred[0]; // let the SDK validate if discovery failed
    chosen = chosen ?? cfg.fallback;

    this.resolved.set(tier, { id: chosen, tier, reasoningEffort: cfg.reasoningEffort });
    this.log.info(`model tier '${tier}' -> ${chosen}`);
  }

  forRole(role: AgentRole): ResolvedModel {
    const tier = (this.routing.roles[role] ?? "fast") as ModelTier;
    const r = this.resolved.get(tier);
    if (r) return r;
    const cfg = this.routing.tiers[tier];
    return { id: cfg.fallback, tier, reasoningEffort: cfg.reasoningEffort };
  }

  /** The strongest (deep-tier) model, used to escalate a failed/weak task. */
  forTier(tier: ModelTier): ResolvedModel {
    const r = this.resolved.get(tier);
    if (r) return r;
    const cfg = this.routing.tiers[tier];
    return { id: cfg.fallback, tier, reasoningEffort: cfg.reasoningEffort };
  }

  snapshot(): Record<string, string> {
    return {
      deep: this.resolved.get("deep")?.id ?? "?",
      fast: this.resolved.get("fast")?.id ?? "?",
    };
  }
}
