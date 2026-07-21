import { CopilotClient } from "@github/copilot-sdk";
import type { FactoryConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { EventBus } from "../events.js";
import type { AgentRole, StageName } from "../types.js";
import { isDenied } from "../tools/shell.js";
import { ModelRouter, type ResolvedModel } from "./models.js";

/**
 * The SDK is in preview and its exported types drift between versions, so we
 * interact with it through a deliberately loose local surface. Our own code
 * above this boundary stays fully typed.
 */
interface LooseSession {
  sendAndWait(options: { prompt: string }, timeout?: number): Promise<{ data?: { content?: string } } | undefined>;
  on(eventType: string, handler: (event: { data?: Record<string, unknown> }) => void): () => void;
  disconnect(): Promise<void>;
}
interface LooseClient {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  createSession(config: Record<string, unknown>): Promise<LooseSession>;
  listModels?: () => Promise<unknown> | unknown;
}

interface PermissionRequest {
  kind?: string;
  fullCommandText?: string;
  fileName?: string;
  toolName?: string;
}

export interface RunAgentOptions {
  runId: string;
  taskId: string;
  stage: StageName;
  role: AgentRole;
  model: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  systemMessage: string;
  prompt: string;
  workingDir: string;
  timeoutMs?: number;
}

export interface AgentResult {
  content: string;
  toolCalls: number;
  usage: { inputTokens: number; outputTokens: number };
}

/** Minimal model-routing surface the orchestrator needs (lets tests inject a mock). */
export interface ModelRouterLike {
  forRole(role: AgentRole): ResolvedModel;
  forTier(tier: "deep" | "fast"): ResolvedModel;
}

/**
 * The runtime contract the orchestrator depends on. Implemented by
 * {@link CopilotRuntime} in production and by a canned-response mock in the
 * offline pipeline integration test.
 */
export interface AgentRuntime {
  readonly router: ModelRouterLike;
  start(discoveryDir: string): Promise<void>;
  runAgent(opts: RunAgentOptions): Promise<AgentResult>;
  stopAll(): Promise<void>;
}

/**
 * Manages Copilot CLI runtimes (one per working directory, so parallel builder
 * sub-agents operate in isolated project trees) and runs single-shot agent
 * turns. The underlying CLI agent already provides file-editing and shell tools,
 * so a factory "agent" is just a session with a role system prompt + a model +
 * an autonomous permission policy.
 */
export class CopilotRuntime {
  readonly router: ModelRouter;
  private readonly clients = new Map<string, LooseClient>();
  private started = false;
  /** Whether any agent turn has ever reported non-zero token usage. */
  private sawUsage = false;

  constructor(
    private readonly config: FactoryConfig,
    private readonly log: Logger,
    private readonly bus: EventBus,
  ) {
    this.router = new ModelRouter(config.routing, log.child("models"), {
      deep: config.modelDeepOverride,
      fast: config.modelFastOverride,
    });
  }

  /** Start a discovery client and resolve model tiers. */
  async start(discoveryDir: string): Promise<void> {
    if (this.started) return;
    const client = await this.getClient(discoveryDir);
    await this.router.initialize(client);
    this.started = true;
  }

  private async getClient(workingDir: string): Promise<LooseClient> {
    const existing = this.clients.get(workingDir);
    if (existing) return existing;
    this.log.debug(`spawning Copilot runtime for ${workingDir}`);
    const client = new CopilotClient({
      workingDirectory: workingDir,
      useLoggedInUser: !this.config.githubToken,
      ...(this.config.githubToken ? { gitHubToken: this.config.githubToken } : {}),
      ...(this.config.otlpEndpoint ? { telemetry: { otlpEndpoint: this.config.otlpEndpoint } } : {}),
      logLevel: "error",
    } as never) as unknown as LooseClient;
    await client.start();
    this.clients.set(workingDir, client);
    return client;
  }

  private permissionHandler(runId: string, stage: StageName, taskId: string) {
    return (request: PermissionRequest): { kind: string; feedback?: string } => {
      if (request.kind === "shell") {
        const cmd = request.fullCommandText ?? "";
        if (isDenied(cmd)) {
          this.bus.publish({
            runId,
            ts: new Date().toISOString(),
            type: "agent.tool",
            stage,
            taskId,
            level: "warn",
            message: `blocked shell command: ${cmd}`,
          });
          return { kind: "reject", feedback: "Command blocked by factory security denylist." };
        }
      }
      return { kind: "approve-once" };
    };
  }

  async runAgent(opts: RunAgentOptions): Promise<AgentResult> {
    const client = await this.getClient(opts.workingDir);
    const session = await client.createSession({
      model: opts.model,
      streaming: true,
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      systemMessage: { content: opts.systemMessage },
      onPermissionRequest: this.permissionHandler(opts.runId, opts.stage, opts.taskId),
    });

    let toolCalls = 0;
    let deltaBuffer = "";
    const usage = { inputTokens: 0, outputTokens: 0 };
    const flush = () => {
      if (!deltaBuffer) return;
      this.bus.publish({ runId: opts.runId, ts: new Date().toISOString(), type: "agent.delta", stage: opts.stage, taskId: opts.taskId, message: deltaBuffer });
      deltaBuffer = "";
    };
    // The SDK emits a dedicated `assistant.usage` event per model API call (one
    // turn can produce several — tool-call round trips, sub-agents, retries),
    // with inputTokens/outputTokens at the top level. Accumulate the FRESH
    // billable tokens across all of them. Cache read/write tokens are reported
    // separately by the SDK and are far cheaper, so they are intentionally
    // EXCLUDED from the cost/budget figure to avoid ~10x overstatement.
    // (See @github/copilot-sdk AssistantUsageData.)
    const accrue = (data: Record<string, unknown> | undefined) => {
      if (!data) return;
      const inTok = Number(data["inputTokens"] ?? 0);
      const outTok = Number(data["outputTokens"] ?? 0);
      if (inTok > 0) usage.inputTokens += inTok;
      if (outTok > 0) usage.outputTokens += outTok;
    };

    // --- Progress-based liveness (a hard clock can't tell "working" from "stuck") ---
    // The SDK's sendAndWait timeout only stops US waiting; it does NOT abort the
    // agent. So instead of killing healthy long turns at an arbitrary time, we
    // watch the event stream: any event = progress. We abort only on genuine
    // pathology — total silence (a hang) or the same tool call looping (stuck).
    const inactivityMs = Math.max(0, (this.config.stallInactivitySeconds ?? 0) * 1000);
    const loopThreshold = Math.max(0, this.config.stallLoopThreshold ?? 0);
    const ceilingMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 90 * 60_000;
    let lastActivity = Date.now();
    let aborted: string | null = null;
    let disconnected = false;
    const safeDisconnect = async () => {
      if (disconnected) return;
      disconnected = true;
      try {
        await session.disconnect();
      } catch {
        /* ignore */
      }
    };
    const touch = () => {
      lastActivity = Date.now();
    };
    const triggerAbort = (reason: string) => {
      if (aborted) return;
      aborted = reason;
      this.log.warn(`aborting ${opts.role} turn — ${reason}`);
      this.bus.publish({ runId: opts.runId, ts: new Date().toISOString(), type: "agent.tool", stage: opts.stage, taskId: opts.taskId, level: "warn", message: `stall watchdog: ${reason}` });
      void safeDisconnect();
    };
    // Consecutive identical tool signatures ⇒ a stuck retry loop.
    let lastSig = "";
    let sigCount = 0;
    const toolSignature = (data: Record<string, unknown> | undefined): string => {
      if (!data) return "tool";
      const salient = Object.fromEntries(
        Object.entries(data).filter(([k]) => !/^(id|timestamp|ts|time|startedAt|callId|executionId)$/i.test(k)),
      );
      try {
        return JSON.stringify(salient);
      } catch {
        return String(data["toolName"] ?? "tool");
      }
    };

    const unsubs = [
      session.on("assistant.message_delta", (e) => {
        touch();
        const d = (e.data?.["deltaContent"] as string) ?? "";
        deltaBuffer += d;
        if (deltaBuffer.length > 240 || d.includes("\n")) flush();
      }),
      session.on("assistant.reasoning_delta", () => touch()),
      session.on("assistant.usage", (e) => {
        touch();
        accrue(e.data);
      }),
      session.on("tool.execution_start", (e) => {
        touch();
        toolCalls++;
        const tool = (e.data?.["toolName"] as string) ?? "tool";
        this.bus.publish({ runId: opts.runId, ts: new Date().toISOString(), type: "agent.tool", stage: opts.stage, taskId: opts.taskId, message: `→ ${tool}`, data: e.data });
        const sig = toolSignature(e.data);
        if (sig === lastSig) sigCount++;
        else {
          lastSig = sig;
          sigCount = 1;
        }
        if (loopThreshold > 0 && sigCount >= loopThreshold) {
          triggerAbort(`same tool call repeated ${sigCount}× with no other progress (stuck loop): ${tool}`);
        }
      }),
      session.on("tool.execution_progress", () => touch()),
      session.on("tool.execution_complete", () => touch()),
      session.on("session.plan_changed", () => touch()),
      session.on("session.todos_changed", () => touch()),
    ];

    // Inactivity watchdog: fire only when NOTHING has happened for the window.
    const watchdog =
      inactivityMs > 0
        ? setInterval(() => {
            if (aborted) return;
            const idle = Date.now() - lastActivity;
            if (idle > inactivityMs) {
              triggerAbort(`no activity for ${Math.round(idle / 1000)}s (hang)`);
            }
          }, 15_000)
        : undefined;
    if (watchdog && typeof (watchdog as { unref?: () => void }).unref === "function") {
      (watchdog as { unref: () => void }).unref();
    }

    try {
      const res = await session.sendAndWait({ prompt: opts.prompt }, ceilingMs);
      flush();
      const content = res?.data?.content ?? "";
      if (usage.inputTokens + usage.outputTokens > 0) {
        this.sawUsage = true;
      } else if (content.length > 0) {
        // Non-empty reply with zero tokens => the SDK usage shape likely drifted.
        // Cost/budget tracking silently degrades, so warn loudly (once).
        this.log.warn(
          `token usage capture returned 0 for a non-empty ${opts.role} reply — cost/budget tracking may be DISABLED (SDK usage shape drift?)`,
        );
      }
      return { content, toolCalls, usage };
    } catch (err) {
      // A watchdog-triggered disconnect rejects the wait; surface it as a clear
      // stall so the orchestrator can escalate (fast→deep) or fail loudly.
      if (aborted) throw new Error(`agent turn aborted by stall watchdog — ${aborted}`);
      throw err;
    } finally {
      if (watchdog) clearInterval(watchdog);
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* ignore */
        }
      }
      try {
        await safeDisconnect();
      } catch {
        /* ignore */
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [dir, client] of this.clients) {
      try {
        await client.stop();
      } catch (err) {
        this.log.warn(`error stopping runtime ${dir}: ${String(err)}`);
      }
    }
    this.clients.clear();
    this.started = false;
  }

  /** True once any agent turn has reported non-zero token usage. */
  hasSeenUsage(): boolean {
    return this.sawUsage;
  }
}
