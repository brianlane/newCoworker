import { redactContext } from "@/lib/log-redaction";

type Level = "debug" | "info" | "warn" | "error";
type Context = Record<string, unknown>;

function log(level: Level, message: string, context?: Context): void {
  // CASA 6.5.1: scrub here rather than trusting every call site. `level`,
  // `message` and `timestamp` are written after the spread so a context key
  // called "level" cannot forge the log's own shape.
  const entry = JSON.stringify({
    ...(context ? redactContext(context) : {}),
    level,
    message,
    timestamp: new Date().toISOString()
  });

  if (level === "error" || level === "warn") {
    console.error(entry);
  } else {
    console.log(entry);
  }
}

export const logger = {
  debug: (message: string, context?: Context) => log("debug", message, context),
  info: (message: string, context?: Context) => log("info", message, context),
  warn: (message: string, context?: Context) => log("warn", message, context),
  error: (message: string, context?: Context) => log("error", message, context)
};
