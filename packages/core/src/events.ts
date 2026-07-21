import { EventEmitter } from "node:events";
import type { FactoryEvent } from "./types.js";

/**
 * Central event bus. The orchestrator publishes FactoryEvents; the CLI and the
 * web dashboard subscribe. A bounded ring buffer lets late subscribers (e.g. a
 * browser that connects mid-run) replay recent history.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly history: FactoryEvent[] = [];
  private readonly maxHistory: number;

  constructor(maxHistory = 2000) {
    this.maxHistory = maxHistory;
    this.emitter.setMaxListeners(0);
  }

  publish(event: FactoryEvent): void {
    this.history.push(event);
    if (this.history.length > this.maxHistory) this.history.shift();
    this.emitter.emit("event", event);
  }

  subscribe(handler: (event: FactoryEvent) => void): () => void {
    this.emitter.on("event", handler);
    return () => this.emitter.off("event", handler);
  }

  /** Replay buffered events, optionally filtered by run id. */
  replay(runId?: string): FactoryEvent[] {
    return runId ? this.history.filter((e) => e.runId === runId) : [...this.history];
  }
}

/** A single process-wide bus so CLI and embedded web server share state. */
export const globalBus = new EventBus();
