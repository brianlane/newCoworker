/**
 * system_logs writer for Edge functions (Deno).
 *
 * Best-effort and NEVER throws — logging must never break the worker path it
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
