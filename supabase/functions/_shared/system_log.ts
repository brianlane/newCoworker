/**
 * system_logs writer for Edge functions (Deno).
 *
 * Best-effort and NEVER throws, logging must never break the worker path it
 * observes. Mirrors src/lib/db/system-logs.ts on the app side; the table is
 * created by 20260610010000_system_logs.sql and is service-role-only.
 */
type InsertSupabase = {
  from: (table: string) => {
    insert: (row: Record<string, unknown>) => PromiseLike<{
      error: { message: string } | null;
    }>;
  };
};

export type SystemLogLevel = "debug" | "info" | "warn" | "error";

export type SystemLogInput = {
  businessId?: string | null;
  source: string;
  level: SystemLogLevel;
  event: string;
  message?: string;
  payload?: Record<string, unknown>;
};

/**
 * Pick the level for one AiFlow step transition.
 *
 * The distinction that matters is TERMINAL vs RETRYABLE, not failed vs not.
 * Most step failures are transient: the worker re-queues the run and the next
 * attempt succeeds. Logging those at `error` put runs that finished perfectly
 * well on the fleet-wide "System Errors" dashboard, which selects
 * `level = 'error'`, and pushed the failures that DID end a run off the list.
 * A failure earns `error` only when the run actually dies of it.
 *
 * `persistFailed` (the `ai_flow_run_steps` upsert itself erroring) always wins:
 * that is a persistence bug rather than a flow outcome, and it means the
 * durable trace has diverged from the run table.
 */
export function stepLogLevel(
  status: string,
  opts: { terminal: boolean; persistFailed: boolean }
): SystemLogLevel {
  if (opts.persistFailed) return "error";
  if (status === "failed") return opts.terminal ? "error" : "warn";
  if (status === "pending") return "info";
  return "debug";
}

export async function systemLog(
  supabase: InsertSupabase,
  input: SystemLogInput
): Promise<void> {
  try {
    const { error } = await supabase.from("system_logs").insert({
      business_id: input.businessId ?? null,
      source: input.source,
      level: input.level,
      event: input.event,
      message: (input.message ?? "").slice(0, 4000),
      payload: input.payload ?? {}
    });
    if (error) {
      console.error("systemLog insert failed", input.event, error.message);
    }
  } catch (e) {
    console.error("systemLog insert threw", input.event, e);
  }
}
