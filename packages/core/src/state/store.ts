import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Run, FactoryEvent } from "../types.js";

/**
 * File-backed store for run state and audit log. One JSON document per run under
 * <dataDir>/runs/<id>.json, written atomically (temp file + rename). An append-
 * only audit log per run lives at <dataDir>/audit/<id>.jsonl. This keeps the
 * factory dependency-free and easy to inspect; the interface can be swapped for
 * SQLite later without touching callers.
 */
export class Store {
  private readonly runsDir: string;
  private readonly auditDir: string;

  constructor(dataDir: string) {
    this.runsDir = resolve(dataDir, "runs");
    this.auditDir = resolve(dataDir, "audit");
    mkdirSync(this.runsDir, { recursive: true });
    mkdirSync(this.auditDir, { recursive: true });
  }

  private runPath(id: string): string {
    return join(this.runsDir, `${id}.json`);
  }

  saveRun(run: Run): void {
    run.updatedAt = new Date().toISOString();
    const path = this.runPath(run.id);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(run, null, 2), "utf8");
    renameSync(tmp, path);
  }

  loadRun(id: string): Run | undefined {
    const path = this.runPath(id);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as Run;
  }

  listRuns(): Run[] {
    if (!existsSync(this.runsDir)) return [];
    const runs: Run[] = [];
    for (const file of readdirSync(this.runsDir)) {
      if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
      try {
        runs.push(JSON.parse(readFileSync(join(this.runsDir, file), "utf8")) as Run);
      } catch {
        // skip malformed/partial files
      }
    }
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  appendAudit(event: FactoryEvent): void {
    const path = join(this.auditDir, `${event.runId}.jsonl`);
    writeFileSync(path, JSON.stringify(event) + "\n", { flag: "a" });
  }

  readAudit(runId: string): FactoryEvent[] {
    const path = join(this.auditDir, `${runId}.jsonl`);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as FactoryEvent);
  }
}
