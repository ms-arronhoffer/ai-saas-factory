/** Minimal leveled logger. Keeps the factory dependency-free. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: LogLevel = (process.env.FACTORY_LOG_LEVEL as LogLevel) ?? "info";

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

function ts(): string {
  return new Date().toISOString();
}

function emit(level: LogLevel, scope: string, msg: string): void {
  if (order[level] < order[threshold]) return;
  const line = `${ts()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  child(scope: string): Logger;
}

export function createLogger(scope = "factory"): Logger {
  return {
    debug: (m) => emit("debug", scope, m),
    info: (m) => emit("info", scope, m),
    warn: (m) => emit("warn", scope, m),
    error: (m) => emit("error", scope, m),
    child: (s) => createLogger(`${scope}:${s}`),
  };
}
