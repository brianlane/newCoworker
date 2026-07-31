import { redactContext } from "@/lib/log-redaction";

type Level = "debug" | "info" | "warn" | "error";
type Context = Record<string, unknown>;

function log(level: Level, message: string, context?: Context): void {
  // CASA 6.5.1: scrub here rather than trusting every call site.
  //
  // Field order is deliberately unchanged: context still spreads LAST and so
  // still wins on a key collision. Reordering to stop a context key forging
  // `level`/`message` looks tempting, but a number of call sites legitimately
  // pass `message: err.message` alongside a static log string (the admin
  // costs/gemini/usage pages and platform-cost-sync among them), and letting
  // the literal argument win would silently drop the exception text. That is a
  // separate concern from redaction, and worth its own change with its own
  // call-site migration rather than a side effect of this one.
  const entry = JSON.stringify({
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(context ? redactContext(context) : {})
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
