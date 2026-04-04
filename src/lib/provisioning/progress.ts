import { randomUUID } from "crypto";
import { insertCoworkerLog, type LogRow } from "@/lib/db/logs";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { CoworkerLog } from "@/lib/db/schema";

export type ProvisioningLogRowStatus = CoworkerLog["status"];

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
  /** Row status from coworker_logs (error = deploy/orchestrator failure at partial percent). */
  logStatus: ProvisioningLogRowStatus;
} | null;

function normalizeLogStatus(raw: unknown): ProvisioningLogRowStatus {
  if (raw === "thinking" || raw === "success" || raw === "error" || raw === "urgent_alert") {
    return raw;
  }
  return "thinking";
}

/** `online` and `high_load` are both live/running infra states (see businesses.status). */
export function isBusinessRunningStatus(status: string): boolean {
  return status === "online" || status === "high_load";
}

/**
 * Whether to show the owner-only provisioning progress UI (no labels).
 * Hide when the business is already running (online or high_load) and provisioning is done or never recorded.
 * Also hide the in-progress bar when the latest row is an error (terminal failure — use failed state instead).
 */
export function shouldShowProvisioningProgress(
  businessStatus: string,
  latest: LatestProvisioningStatus | null
): boolean {
  if (latest?.logStatus === "error") return false;
  if (!isBusinessRunningStatus(businessStatus)) return true;
  if (latest === null) return false;
  if ((latest.percent ?? 0) >= 100) return false;
  return true;
}

/**
 * Mount the provisioning widget when the owner should see either an in-progress bar or a terminal failure message.
 */
export function shouldMountProvisioningWidget(
  businessStatus: string,
  latest: LatestProvisioningStatus | null
): boolean {
  if (latest?.logStatus === "error") return true;
  return shouldShowProvisioningProgress(businessStatus, latest);
}

/** Latest provisioning row for owner progress UI (percent is source of truth). */
export async function getLatestProvisioningStatus(
  businessId: string
): Promise<LatestProvisioningStatus> {
  const db = await createSupabaseServiceClient();
  const { data, error } = await db
    .from("coworker_logs")
    .select("log_payload, created_at, status")
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
    phase: typeof p.phase === "string" ? p.phase : "",
    logStatus: normalizeLogStatus((data as { status?: unknown }).status)
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
