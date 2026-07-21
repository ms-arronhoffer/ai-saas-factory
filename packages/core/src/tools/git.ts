import { runShell } from "./shell.js";

export interface GitHubTarget {
  owner?: string;
  visibility: "private" | "public" | "internal";
}

/** Initialise a git repo in dir and make the first commit. */
export async function initAndCommit(dir: string, message: string): Promise<void> {
  await runShell("git init -b main", { cwd: dir });
  await runShell("git add -A", { cwd: dir });
  // Use -c so we do not require global identity to be configured.
  await runShell(
    `git -c user.name="AI SaaS Factory" -c user.email="factory@local" commit -m ${quote(message)}`,
    { cwd: dir },
  );
}

/** Stage everything and create an additional commit. Returns false if nothing to commit. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await runShell("git add -A", { cwd: dir });
  const status = await runShell("git status --porcelain", { cwd: dir });
  if (status.stdout.trim() === "") return false;
  await runShell(
    `git -c user.name="AI SaaS Factory" -c user.email="factory@local" commit -m ${quote(message)}`,
    { cwd: dir },
  );
  return true;
}

/** Push the current branch to origin/main. Returns the combined git output. */
export async function pushCurrent(dir: string): Promise<string> {
  const res = await runShell("git push origin HEAD:main", { cwd: dir, timeoutMs: 120_000 });
  return res.stdout + res.stderr;
}

/** Push a specific local branch to origin (same name). */
export async function pushBranch(dir: string, branch: string): Promise<string> {
  const res = await runShell(`git push -u origin ${quote(branch)}`, { cwd: dir, timeoutMs: 120_000 });
  return res.stdout + res.stderr;
}

/**
 * Create a GitHub repo from the local dir and push main using the gh CLI.
 * Requires `gh auth login`. Returns the repository URL.
 */
export async function createRepoAndPush(
  dir: string,
  repoName: string,
  description: string,
  target: GitHubTarget,
): Promise<{ url: string; log: string }> {
  const nameArg = target.owner ? `${target.owner}/${repoName}` : repoName;
  const visFlag = `--${target.visibility}`;
  const cmd = `gh repo create ${quote(nameArg)} ${visFlag} --source=. --remote=origin --push --description ${quote(description)}`;
  const res = await runShell(cmd, { cwd: dir, timeoutMs: 180_000 });
  const log = res.stdout + res.stderr;
  if (res.code !== 0) {
    throw new Error(`gh repo create failed (exit ${res.code}):\n${log}`);
  }
  const url = extractRepoUrl(log) ?? (await resolveRepoUrl(dir));
  return { url, log };
}

function extractRepoUrl(log: string): string | undefined {
  const m = log.match(/https:\/\/github\.com\/[^\s]+/);
  return m ? m[0].replace(/\.git$/, "") : undefined;
}

async function resolveRepoUrl(dir: string): Promise<string> {
  const res = await runShell("git remote get-url origin", { cwd: dir });
  return res.stdout.trim().replace(/\.git$/, "");
}

/** Clone a repo (via gh so auth is inherited) into destDir. Returns the path. */
export async function gitClone(repo: string, destDir: string): Promise<string> {
  const res = await runShell(`gh repo clone ${quote(repo)} ${quote(destDir)}`, { timeoutMs: 180_000 });
  if (res.code !== 0) {
    throw new Error(`gh repo clone failed (exit ${res.code}):\n${res.stdout + res.stderr}`);
  }
  return destDir;
}

/** Create and check out a new branch. */
export async function createBranch(dir: string, branch: string): Promise<void> {
  await runShell(`git checkout -b ${quote(branch)}`, { cwd: dir });
}

/**
 * Push the current branch and open a pull request via gh. Returns the PR URL.
 * Enables human-in-the-loop review instead of pushing straight to main.
 */
export async function openPullRequest(
  dir: string,
  branch: string,
  title: string,
  body: string,
): Promise<{ url: string; log: string }> {
  await runShell(`git push -u origin ${quote(branch)}`, { cwd: dir, timeoutMs: 120_000 });
  const res = await runShell(
    `gh pr create --title ${quote(title)} --body ${quote(body)} --head ${quote(branch)}`,
    { cwd: dir, timeoutMs: 120_000 },
  );
  const log = res.stdout + res.stderr;
  if (res.code !== 0) {
    throw new Error(`gh pr create failed (exit ${res.code}):\n${log}`);
  }
  const url = extractRepoUrl(log) ?? "";
  return { url, log };
}

/** Read a GitHub issue's title + body for bug-intake → fix flows. */
export async function readIssue(repo: string, number: number): Promise<{ title: string; body: string }> {
  const res = await runShell(
    `gh issue view ${number} --repo ${quote(repo)} --json title,body`,
    { timeoutMs: 60_000 },
  );
  if (res.code !== 0) {
    throw new Error(`gh issue view failed (exit ${res.code}):\n${res.stdout + res.stderr}`);
  }
  const parsed = JSON.parse(res.stdout) as { title?: string; body?: string };
  return { title: parsed.title ?? `Issue #${number}`, body: parsed.body ?? "" };
}

/** Ensure a git repo exists in dir with at least one commit. Returns true if newly created. */
export async function ensureGit(dir: string, message: string): Promise<boolean> {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  if (existsSync(join(dir, ".git"))) return false;
  await initAndCommit(dir, message);
  return true;
}

/** Check out a new branch off the current HEAD (no-op if already on it). */
export async function checkoutBranch(dir: string, branch: string): Promise<void> {
  const cur = await runShell("git rev-parse --abbrev-ref HEAD", { cwd: dir });
  if (cur.stdout.trim() === branch) return;
  const res = await runShell(`git checkout -b ${quote(branch)}`, { cwd: dir });
  if (res.code !== 0) {
    // Branch may already exist; try a plain checkout.
    await runShell(`git checkout ${quote(branch)}`, { cwd: dir });
  }
}

/** Add an isolated git worktree at wtPath on a new branch. */
export async function addWorktree(dir: string, branch: string, wtPath: string): Promise<void> {
  // Remove any stale worktree/branch first so re-runs are idempotent.
  await runShell(`git worktree remove --force ${quote(wtPath)}`, { cwd: dir });
  await runShell(`git branch -D ${quote(branch)}`, { cwd: dir });
  const res = await runShell(`git worktree add -b ${quote(branch)} ${quote(wtPath)}`, { cwd: dir });
  if (res.code !== 0) {
    throw new Error(`git worktree add failed (exit ${res.code}):\n${res.stdout + res.stderr}`);
  }
}

/** Merge a worktree branch back into the current branch. Returns conflict state. */
export async function mergeBranch(dir: string, branch: string, message: string): Promise<{ ok: boolean; conflicts: boolean }> {
  const res = await runShell(`git merge --no-ff -m ${quote(message)} ${quote(branch)}`, { cwd: dir });
  if (res.code === 0) return { ok: true, conflicts: false };
  const conflicts = /conflict/i.test(res.stdout + res.stderr);
  return { ok: false, conflicts };
}

/** Abort an in-progress merge, restoring the working tree. */
export async function abortMerge(dir: string): Promise<void> {
  await runShell("git merge --abort", { cwd: dir });
}

/** Remove a worktree and delete its branch (best-effort cleanup). */
export async function removeWorktree(dir: string, branch: string, wtPath: string): Promise<void> {
  await runShell(`git worktree remove --force ${quote(wtPath)}`, { cwd: dir });
  await runShell(`git branch -D ${quote(branch)}`, { cwd: dir });
}

/** Create a GitHub repo without pushing (PR-first flows push branches after). */
export async function createRepoOnly(repoName: string, description: string, target: GitHubTarget, dir: string): Promise<string> {
  const nameArg = target.owner ? `${target.owner}/${repoName}` : repoName;
  const visFlag = `--${target.visibility}`;
  const res = await runShell(`gh repo create ${quote(nameArg)} ${visFlag} --source=. --remote=origin --description ${quote(description)}`, { cwd: dir, timeoutMs: 120_000 });
  if (res.code !== 0) throw new Error(`gh repo create failed (exit ${res.code}):\n${res.stdout + res.stderr}`);
  return (extractRepoUrl(res.stdout + res.stderr) ?? (await resolveRepoUrl(dir)));
}

/** Quote an argument for the platform shell. */
function quote(value: string): string {
  if (process.platform === "win32") {
    // PowerShell single-quote escaping: double any single quotes.
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}
