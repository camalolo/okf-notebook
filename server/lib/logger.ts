/**
 * Lightweight request-scoped logger for tracing the full chat interaction chain.
 *
 * Each chat request gets a short trace ID (e.g. `a3f9`) that is passed through
 * the agentic loop, LLM calls, and SSE events, so a single turn can be followed
 * end-to-end in journald / server logs.
 *
 * Log levels: debug < info < warn < error.
 * Set CHAT_LOG_LEVEL=debug|info|warn|error to control verbosity (default: info).
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MIN_LEVEL: LogLevel =
  (process.env.CHAT_LOG_LEVEL as LogLevel) || 'info';

const ts = () => new Date().toISOString();

/**
 * Create a logger scoped to a trace ID. All messages are prefixed with
 * `[chat:ID]` so they can be grepped from journald.
 */
export function chatLogger(traceId: string) {
  const prefix = `[chat:${traceId}]`;
  const should = (level: LogLevel) => LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];

  return {
    debug: (msg: string, ...args: unknown[]) => {
      if (should('debug')) console.debug(`${ts()} ${prefix} ${msg}`, ...args);
    },
    info: (msg: string, ...args: unknown[]) => {
      if (should('info')) console.log(`${ts()} ${prefix} ${msg}`, ...args);
    },
    warn: (msg: string, ...args: unknown[]) => {
      if (should('warn')) console.warn(`${ts()} ${prefix} ${msg}`, ...args);
    },
    error: (msg: string, ...args: unknown[]) => {
      if (should('error')) console.error(`${ts()} ${prefix} ${msg}`, ...args);
    },
    /** Log an error with full stack trace. */
    errorTrace: (msg: string, err: unknown) => {
      if (should('error')) {
        if (err instanceof Error) {
          console.error(`${ts()} ${prefix} ${msg}`, err.message, err.stack);
        } else {
          console.error(`${ts()} ${prefix} ${msg}`, err);
        }
      }
    },
    prefix,
  };
}

export type ChatLogger = ReturnType<typeof chatLogger>;

/** Generate a short random trace ID (4 hex chars — enough for log correlation). */
export function newTraceId(): string {
  return Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
}

/** Elapsed-millis helper for timing logs. */
export function elapsed(sinceMs: number): string {
  return `${Date.now() - sinceMs}ms`;
}
