import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Project, BacklogItem } from "../types.js";

/**
 * Durable projects the factory owns and operates over time (persistent-project
 * mode). Backed by one JSON document per project under <dataDir>/projects/.
 */
export class ProjectStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = resolve(dataDir, "projects");
    mkdirSync(this.dir, { recursive: true });
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  create(partial: { name: string; stack: string; workingDir: string; repoUrl?: string; owner?: string }): Project {
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID().slice(0, 8),
      name: partial.name,
      stack: partial.stack,
      workingDir: partial.workingDir,
      ...(partial.repoUrl ? { repoUrl: partial.repoUrl } : {}),
      ...(partial.owner ? { owner: partial.owner } : {}),
      backlog: [],
      createdAt: now,
      updatedAt: now,
    };
    this.save(project);
    return project;
  }

  save(project: Project): void {
    project.updatedAt = new Date().toISOString();
    const p = this.path(project.id);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(project, null, 2), "utf8");
    renameSync(tmp, p);
  }

  get(id: string): Project | undefined {
    const p = this.path(id);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf8")) as Project;
  }

  list(): Project[] {
    if (!existsSync(this.dir)) return [];
    const out: Project[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
      try {
        out.push(JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Project);
      } catch {
        /* skip malformed */
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  addBacklogItem(id: string, title: string, source: BacklogItem["source"] = "manual", priority: BacklogItem["priority"] = "medium"): BacklogItem | undefined {
    const project = this.get(id);
    if (!project) return undefined;
    const item: BacklogItem = { id: randomUUID().slice(0, 8), title, status: "todo", priority, source, createdAt: new Date().toISOString() };
    project.backlog.push(item);
    this.save(project);
    return item;
  }

  setItemStatus(id: string, itemId: string, status: BacklogItem["status"]): void {
    const project = this.get(id);
    if (!project) return;
    const item = project.backlog.find((b) => b.id === itemId);
    if (item) {
      item.status = status;
      this.save(project);
    }
  }
}
