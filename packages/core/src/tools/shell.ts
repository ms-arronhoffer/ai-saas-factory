import { spawn, spawnSync } from "node:child_process";

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ShellOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Called with incremental stdout/stderr chunks for live streaming. */
  onData?: (stream: "stdout" | "stderr", chunk: string) => void;
}

/**
 * Patterns that must never be executed by the factory or its agents. These
 * guard against destructive or exfiltration commands even under autonomous
 * operation. Matched case-insensitively against the full command string.
 */
const DENYLIST: RegExp[] = [
  /rm\s+-rf\s+[~/]($|\s)/i,
  /rm\s+-rf\s+\/\s*$/i,
  /:\s*\(\s*\)\s*\{.*\}\s*;/, // fork bomb
  /mkfs\./i,
  /dd\s+if=.*of=\/dev\//i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+reset\s+--hard\b.*origin/i,
  /curl[^\n|]*\|\s*(sudo\s+)?(sh|bash)\b/i,
  /wget[^\n|]*\|\s*(sudo\s+)?(sh|bash)\b/i,
  /\bshutdown\b|\breboot\b/i,
  /\bchmod\s+-R\s+777\s+\//i,
];

export function isDenied(command: string): boolean {
  return DENYLIST.some((re) => re.test(command));
}

/**
 * The Windows shell to use. Prefers PowerShell 7+ (`pwsh`) because it supports
 * `&&`/`||` command chaining that Windows PowerShell 5.1 (`powershell.exe`) does
 * NOT — so recipe commands like `coverage run ... && coverage json` and any
 * agent-issued chained commands work the same as on bash/CI. Detected once.
 */
let cachedWinShell: string | undefined;
function resolveWinShell(): string {
  if (cachedWinShell) return cachedWinShell;
  try {
    const r = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { windowsHide: true, timeout: 5000 });
    cachedWinShell = r.status === 0 ? "pwsh" : "powershell.exe";
  } catch {
    cachedWinShell = "powershell.exe";
  }
  return cachedWinShell;
}

/**
 * Run a command through the platform shell. Rejects denylisted commands. On
 * Windows uses PowerShell; elsewhere /bin/sh.
 */
export function runShell(command: string, options: ShellOptions = {}): Promise<ShellResult> {
  if (isDenied(command)) {
    return Promise.resolve({
      code: 126,
      stdout: "",
      stderr: `Refused: command matches factory denylist -> ${command}`,
      timedOut: false,
    });
  }

  const isWin = process.platform === "win32";
  const shell = isWin ? resolveWinShell() : "/bin/sh";
  const args = isWin ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];

  return new Promise((resolvePromise) => {
    const child = spawn(shell, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : undefined;

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      options.onData?.("stdout", s);
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      options.onData?.("stderr", s);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: -1, stdout, stderr: stderr + String(err), timedOut });
    });
  });
}

/** True if a command-line tool is resolvable on PATH. */
export async function hasTool(tool: string): Promise<boolean> {
  const probe = process.platform === "win32" ? `Get-Command ${tool} -ErrorAction SilentlyContinue` : `command -v ${tool}`;
  const res = await runShell(probe, { timeoutMs: 10_000 });
  return res.code === 0 && res.stdout.trim().length > 0;
}
