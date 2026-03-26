type Level = "debug" | "info" | "warn" | "error";
type Context = Record<string, unknown>;

function log(level: Level, message: string, context?: Context): void {
  const entry = JSON.stringify({
    level,
    message,
    timestamp: new Date().toISOString(),
    ...context
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
