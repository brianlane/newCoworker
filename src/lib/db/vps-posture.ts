/**
 * Persistence for per-box security-posture reports (`vps_posture_reports`,
 * service-role only). Written by POST /api/vps/posture (gateway-token
 * authenticated heartbeat reports); read by the admin business page.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type VpsPostureCheck = {
  name: string;
  ok: boolean;
  detail?: string;
};

export type VpsPostureReportRow = {
  id: string;
  business_id: string;
  ok: boolean;
  checks: VpsPostureCheck[];
  created_at: string;
};

export async function insertVpsPostureReport(
  input: { businessId: string; ok: boolean; checks: VpsPostureCheck[] },
  client?: SupabaseClient
): Promise<VpsPostureReportRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("vps_posture_reports")
    .insert({
      business_id: input.businessId,
      ok: input.ok,
      checks: input.checks
    })
    .select()
    .single();
  if (error) throw new Error(`insertVpsPostureReport: ${error.message}`);
  return data as VpsPostureReportRow;
}

/** Latest report for a business, or null when the box has never reported. */
export async function getLatestVpsPostureReport(
  businessId: string,
  client?: SupabaseClient
): Promise<VpsPostureReportRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("vps_posture_reports")
    .select("*")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getLatestVpsPostureReport: ${error.message}`);
  return (data as VpsPostureReportRow | null) ?? null;
}
