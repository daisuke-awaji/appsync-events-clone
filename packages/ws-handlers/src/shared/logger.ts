/**
 * Minimal structured logger. Replaceable with @aws-lambda-powertools/logger
 * later, but kept dependency-free for the MVP.
 */
export type LogFields = Readonly<Record<string, unknown>>;

function emit(level: "info" | "warn" | "error", msg: string, fields?: LogFields): void {
  const record = {
    level,
    msg,
    timestamp: new Date().toISOString(),
    ...fields,
  };

  console.log(JSON.stringify(record));
}

export const logger = {
  info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => emit("error", msg, fields),
};
