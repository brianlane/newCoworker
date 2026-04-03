import { randomUUID } from "crypto";
import { insertCoworkerLog, type LogRow } from "@/lib/db/logs";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { CoworkerLog } from "@/lib/db/schema";

export type ProvisioningSource = "orchestrator" | "vps";

export type ProvisioningLogPayload = {
  phase: string;
  percent: number;
  message: string;
  source: ProvisioningSource;
};

function clampPercent(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function resolveStatus(
  percent: number,
  explicit?: "thinking" | "success" | "error"
): CoworkerLog["status"] {
  if (explicit === "error") return "error";
  if (explicit === "success") return "success";
  if (percent >= 100) return "success";
  return "thinking";
}

/**
 * Inserts a coworker_logs row for provisioning/deploy progress (admin-visible message in log_payload).
 */
export async function recordProvisioningProgress(params: {
  businessId: string;
  phase: string;
  percent: number;
  message: string;
  source: ProvisioningSource;
  status?: "thinking" | "success" | "error";
}): Promise<LogRow> {
  const percent = clampPercent(params.percent);
  const payload: ProvisioningLogPayload = {
    phase: params.phase,
    percent,
    message: params.message,
    source: params.source
  };
  const status = resolveStatus(percent, params.status);

  return insertCoworkerLog({
    id: randomUUID(),
    business_id: params.businessId,
    task_type: "provisioning",
    status,
    log_payload: payload as unknown as Record<string, unknown>
  });
}

export type LatestProvisioningStatus = {
  percent: number;
  updatedAt: string;
  phase: string;
} | null;

/** Whether to show the owner-only provisioning progress UI (no labels). */
export function shouldShowProvisioningProgress(
  businessStatus: string,
  latest: LatestProvisioningStatus | null
): boolean {
  if (businessStatus === "online" && latest === null) return false;
  if (businessStatus === "online" && (latest?.percent ?? 0) >= 100) return false;
  return true;
}

/** Latest provisioning row for owner progress UI (percent is source of truth). */
export async function getLatestProvisioningStatus(
  businessId: string
): Promise<LatestProvisioningStatus> {
  const db = await createSupabaseServiceClient();
  const { data, error } = await db
    .from("coworker_logs")
    .select("log_payload, created_at")
    .eq("business_id", businessId)
    .eq("task_type", "provisioning")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`getLatestProvisioningStatus: ${error.message}`);
  if (!data?.log_payload) return null;

  const p = data.log_payload as ProvisioningLogPayload;
  return {
    percent: clampPercent(typeof p.percent === "number" ? p.percent : 0),
    updatedAt: data.created_at as string,
    phase: typeof p.phase === "string" ? p.phase : ""
  };
}

/** Admin: recent provisioning/deploy log rows (newest first). */
export async function getProvisioningLogs(businessId: string, limit = 50): Promise<LogRow[]> {
  const db = await createSupabaseServiceClient();
  const { data, error } = await db
    .from("coworker_logs")
    .select()
    .eq("business_id", businessId)
    .eq("task_type", "provisioning")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`getProvisioningLogs: ${error.message}`);
  return (data ?? []) as LogRow[];
}
