import type { AgentRuntime, ModelRouterLike, RunAgentOptions, AgentResult } from "../copilot/client.js";
import type { AgentRole } from "../types.js";

/**
 * A canned, offline implementation of {@link AgentRuntime} for the pipeline
 * integration test. It returns deterministic per-role responses and fake token
 * usage, so the orchestrator can be driven end-to-end without any model, network
 * or GitHub — proving the wiring, gates, budget, verify and acceptance logic.
 */
export class MockRuntime implements AgentRuntime {
  readonly router: ModelRouterLike = {
    forRole: () => ({ id: "mock-model", tier: "fast", reasoningEffort: "low" }),
    forTier: (tier) => ({ id: `mock-${tier}`, tier, reasoningEffort: "low" }),
  };

  /** Roles whose canned reply was actually requested (assertable in the test). */
  readonly calledRoles: AgentRole[] = [];

  async start(): Promise<void> {
    /* no-op */
  }

  async stopAll(): Promise<void> {
    /* no-op */
  }

  async runAgent(opts: RunAgentOptions): Promise<AgentResult> {
    this.calledRoles.push(opts.role);
    return {
      content: this.responseFor(opts.role),
      toolCalls: 1,
      usage: { inputTokens: 500, outputTokens: 500 },
    };
  }

  private responseFor(role: AgentRole): string {
    switch (role) {
      case "interrogator":
        return fenced({
          refinedBrief: "A tiny single-user task tracker with create/list/complete, no sharing, email+password auth.",
          decisions: [
            { question: "Multi-user or single-user MVP?", decision: "single-user", rationale: "smallest end-to-end slice" },
            { question: "Auth model?", decision: "email + password with JWT", rationale: "standard, no third-party setup" },
          ],
          outOfScope: ["teams", "real-time sync"],
        });
      case "requirements":
        return fenced({
          name: "Mock Tracker",
          slug: "mock-tracker",
          summary: "A tiny task tracker used to exercise the factory pipeline offline.",
          problem: "People need a simple way to track tasks.",
          targetUsers: ["individuals", "small teams"],
          coreFeatures: ["create task", "list tasks", "complete task"],
          entities: ["Task", "User"],
          nonFunctional: ["responsive", "secure auth"],
          stack: "mock",
          openQuestions: [],
          acceptanceCriteria: [{ feature: "create task", criteria: ["Given a user, when they create a task, it appears in the list."] }],
        });
      case "architect":
        return fenced({
          overview: "Single-service app extending the seed.",
          fileManifest: ["api/main.py"],
          workstreams: [{ id: "app", title: "App", dir: ".", language: "mixed" }],
          dependencies: {},
          integrationNotes: "Follow ARCHITECTURE.md.",
          contract: { openapi: "contracts/openapi.yaml", schema: "contracts/schema.sql", notes: "frozen" },
        });
      case "evaluator":
        return fenced({ summary: "All core features implemented; evidence looks consistent." });
      case "analyst":
        return fenced({ sources: [], featureParity: [] });
      default:
        return `MOCK ${role}: done. Ran the relevant commands; changes look good.`;
    }
  }
}

function fenced(obj: unknown): string {
  return "Here you go:\n```json\n" + JSON.stringify(obj, null, 2) + "\n```\n";
}
