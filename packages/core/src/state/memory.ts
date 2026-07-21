import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * Lightweight cross-run memory. After each run the factory appends a short note
 * (product, stack, notable decisions, reusable components) to a markdown file.
 * A digest of recent notes is injected into the architect prompt so later runs
 * build on earlier learnings.
 */
export class MemoryStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = resolve(dataDir, "memory");
    mkdirSync(this.dir, { recursive: true });
  }

  record(runId: string, note: string): void {
    const path = join(this.dir, `${runId}.md`);
    writeFileSync(path, note.trim() + "\n", "utf8");
  }

  /** Return a digest of the most recent N run notes (newest first). */
  digest(limit = 5): string {
    if (!existsSync(this.dir)) return "";
    const files = readdirSync(this.dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ f, path: join(this.dir, f) }))
      .sort((a, b) => (a.path < b.path ? 1 : -1))
      .slice(0, limit);
    if (files.length === 0) return "";
    return files
      .map(({ path }) => {
        try {
          return readFileSync(path, "utf8").trim();
        } catch {
          return "";
        }
      })
      .filter(Boolean)
      .join("\n\n");
  }
}
