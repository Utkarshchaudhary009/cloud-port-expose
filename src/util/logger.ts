export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REDACTED_KEY_PATTERNS = [
  "token",
  "secret",
  "authorization",
  "cookie",
  "password",
  "api_key",
  "api-key",
  "apikey",
  "bearer",
];

function isSensitiveKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return REDACTED_KEY_PATTERNS.some((pattern) => lowered.includes(pattern));
}

function redact(value: unknown, key?: string): unknown {
  if (key !== undefined && isSensitiveKey(key)) {
    return "[redacted]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, k);
    }
    return out;
  }
  return value;
}

export type LogSink = (line: string) => void;

const defaultSink: LogSink = (line) => {
  console.error(line);
};

export interface LoggerOptions {
  subsystem: string;
  level?: LogLevel | undefined;
  sink?: LogSink;
  bindings?: Record<string, unknown>;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(options: LoggerOptions): Logger {
  const minLevel = LEVEL_ORDER[options.level ?? "info"];
  const sink = options.sink ?? defaultSink;
  const emit = (level: LogLevel, message: string, context?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < minLevel) {
      return;
    }
    const line = redact({
      ts: new Date().toISOString(),
      level,
      subsystem: options.subsystem,
      msg: message,
      ...options.bindings,
      ...context,
    });
    try {
      sink(JSON.stringify(line));
    } catch {
      sink(
        JSON.stringify({
          ts: new Date().toISOString(),
          level,
          subsystem: options.subsystem,
          msg: message,
        }),
      );
    }
  };
  return {
    debug: (msg, ctx) => emit("debug", msg, ctx),
    info: (msg, ctx) => emit("info", msg, ctx),
    warn: (msg, ctx) => emit("warn", msg, ctx),
    error: (msg, ctx) => emit("error", msg, ctx),
    child: (bindings) =>
      createLogger({
        subsystem: options.subsystem,
        level: options.level,
        sink,
        bindings: { ...options.bindings, ...bindings },
      }),
  };
}
