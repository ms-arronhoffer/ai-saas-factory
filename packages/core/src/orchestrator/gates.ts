import type { StageName } from "../types.js";

export type GateDecision = "approve" | "reject" | "revise";

export interface GateResolution {
  decision: GateDecision;
  notes?: string;
  /** For the requirements gate: ids of wow features the user chose to include. */
  wowSelected?: string[];
}

/**
 * Tracks human approval gates for in-flight runs. A stage that requires approval
 * awaits waitFor(); the CLI or web dashboard calls resolve() to release it.
 */
export class GateManager {
  private readonly pending = new Map<string, (r: GateResolution) => void>();
  /** Resolutions that arrived before a waiter registered (race buffer). */
  private readonly resolvedEarly = new Map<string, GateResolution>();

  private key(runId: string, stage: StageName): string {
    return `${runId}:${stage}`;
  }

  waitFor(runId: string, stage: StageName): Promise<GateResolution> {
    const k = this.key(runId, stage);
    // If a resolution already arrived (e.g. a synchronous auto-approve fired
    // during the awaiting-approval emit, before this waiter registered),
    // consume it immediately instead of blocking forever.
    const early = this.resolvedEarly.get(k);
    if (early) {
      this.resolvedEarly.delete(k);
      return Promise.resolve(early);
    }
    return new Promise((resolve) => {
      this.pending.set(k, resolve);
    });
  }

  isPending(runId: string, stage: StageName): boolean {
    return this.pending.has(this.key(runId, stage));
  }

  resolve(runId: string, stage: StageName, resolution: GateResolution): boolean {
    const k = this.key(runId, stage);
    const fn = this.pending.get(k);
    if (!fn) {
      // No waiter yet: buffer so the imminent waitFor() picks it up. This makes
      // the gate robust to the emit-before-wait ordering used by callers.
      this.resolvedEarly.set(k, resolution);
      return true;
    }
    this.pending.delete(k);
    fn(resolution);
    return true;
  }
}

/** Process-wide gate manager shared by the CLI and the embedded web server. */
export const globalGates = new GateManager();
