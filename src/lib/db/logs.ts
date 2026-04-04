import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { CoworkerLog } from "@/lib/db/schema";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type LogRow = {
  id: string;
  business_id: string;
  task_type: CoworkerLog["taskType"];
  status: CoworkerLog["status"];
  log_payload: Record<string, unknown>;
  created_at: string;
};

export async function insertCoworkerLog(
  data: Omit<LogRow, "created_at">,
  client?: SupabaseClient
): Promise<LogRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: row, error } = await db
    .from("coworker_logs")
    .insert({
      id: data.id,
      business_id: data.business_id,
      task_type: data.task_type,
      status: data.status,
      log_payload: data.log_payload
    })
    .select()
    .single();

  if (error) throw new Error(`insertCoworkerLog: ${error.message}`);
  return row as LogRow;
}

export async function getRecentAlertsAll(
  limit = 20,
  client?: SupabaseClient
): Promise<LogRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("coworker_logs")
    .select()
    .in("status", ["urgent_alert", "error"])
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`getRecentAlertsAll: ${error.message}`);
  return (data ?? []) as LogRow[];
}

export async function getRecentLogsAll(
  limit = 20,
  client?: SupabaseClient
): Promise<LogRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("coworker_logs")
    .select()
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`getRecentLogsAll: ${error.message}`);
  return (data ?? []) as LogRow[];
}

export async function getRecentLogs(
  businessId: string,
  limit = 20,
  client?: SupabaseClient,
  options?: { excludeProvisioning?: boolean }
): Promise<LogRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  let q = db.from("coworker_logs").select().eq("business_id", businessId);
  if (options?.excludeProvisioning) {
    q = q.neq("task_type", "provisioning");
  }
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`getRecentLogs: ${error.message}`);
  return (data ?? []) as LogRow[];
}
