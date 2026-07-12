/**
 * Accessors for the platform cost tables written by the daily
 * platform-cost-sync cron (src/lib/admin/cost-sync.ts):
 *
 *   - `telnyx_cost_daily`     — Telnyx detail records aggregated per UTC
 *     day / tenant / record type / direction, in micro-USD.
 *   - `hostinger_vps_costs`   — full snapshot of the Hostinger KVM billing
 *     subscriptions, joined to VMs and (when live) the owning business.
 *
 * Both tables are service-role only (RLS on, no policies). Nothing bills
 * from these rows — they feed the admin Costs/Usage pages and the margin
 * engine (src/lib/admin/margin.ts).
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type TelnyxCostDailyInsert = {
  day: string; // YYYY-MM-DD (UTC)
  business_id: string | null;
  record_type: "messaging" | "sip-trunking";
  direction: string;
  record_count: number;
  cost_micros: number;
  carrier_fee_micros: number;
  billed_seconds: number;
};

export type TelnyxCostDailyRow = TelnyxCostDailyInsert & {
  id: number;
  synced_at: string;
};

export type HostingerVpsCostInsert = {
  subscription_id: string;
  vm_id: number | null;
  hostname: string | null;
  plan: string | null;
  status: string;
  billing_period: number | null;
  billing_period_unit: string | null;
  total_price_cents: number | null;
  renewal_price_cents: number | null;
  monthly_price_cents: number | null;
  is_auto_renewed: boolean | null;
  next_billing_at: string | null;
  expires_at: string | null;
  assigned_business_id: string | null;
};

export type HostingerVpsCostRow = HostingerVpsCostInsert & {
  snapshot_at: string;
};

/**
 * Idempotent write for a rolling Telnyx sync window: replace every row with
 * `day >= windowStartDay` with the fresh aggregates. Telnyx only accepts
 * preset last_7/30/90-day ranges, so re-running a sync always covers a
 * superset of the previous run's recent days. The delete+insert runs
 * inside ONE transaction (`replace_telnyx_cost_window` SQL function) so a
 * failed insert can never leave the window deleted-but-empty.
 */
export async function replaceTelnyxCostWindow(
  windowStartDay: string,
  rows: TelnyxCostDailyInsert[],
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.rpc("replace_telnyx_cost_window", {
    p_window_start: windowStartDay,
    p_rows: rows
  });
  if (error) throw new Error(`replaceTelnyxCostWindow: ${error.message}`);
}

/**
 * All Telnyx cost rows with `day >= sinceDay`, oldest first. Paged in
 * 1000-row chunks — PostgREST silently caps a single request at 1000 rows,
 * which would drop the newest days without any error as history grows.
 */
export async function listTelnyxCostDaily(
  sinceDay: string,
  client?: SupabaseClient
): Promise<TelnyxCostDailyRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const pageSize = 1000;
  const all: TelnyxCostDailyRow[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("telnyx_cost_daily")
      .select()
      .gte("day", sinceDay)
      .order("day", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`listTelnyxCostDaily: ${error.message}`);
    const rows = (data ?? []) as TelnyxCostDailyRow[];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

/**
 * Full-replace the Hostinger billing snapshot (a point-in-time view).
 * Atomic for the same reason as {@link replaceTelnyxCostWindow}: the
 * `replace_hostinger_vps_costs` SQL function wraps delete+insert in one
 * transaction.
 */
export async function replaceHostingerVpsCosts(
  rows: HostingerVpsCostInsert[],
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.rpc("replace_hostinger_vps_costs", { p_rows: rows });
  if (error) throw new Error(`replaceHostingerVpsCosts: ${error.message}`);
}

/** The current Hostinger billing snapshot, soonest renewal first (nulls last). */
export async function listHostingerVpsCosts(
  client?: SupabaseClient
): Promise<HostingerVpsCostRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("hostinger_vps_costs")
    .select()
    .order("next_billing_at", { ascending: true, nullsFirst: false });
  if (error) throw new Error(`listHostingerVpsCosts: ${error.message}`);
  return (data ?? []) as HostingerVpsCostRow[];
}

/**
 * Every tenant DID that can appear as cli/cld on a Telnyx MDR: the
 * messaging from-number plus every routed voice DID. `businesses.phone` is
 * deliberately NOT included — that's the owner's onboarding cell, not a
 * Telnyx number, and matching on it would attribute unrelated MDRs.
 */
export async function listTenantDids(
  client?: SupabaseClient
): Promise<Array<{ businessId: string; e164: string }>> {
  const db = client ?? (await createSupabaseServiceClient());
  const [settings, routes] = await Promise.all([
    db
      .from("business_telnyx_settings")
      .select("business_id, telnyx_sms_from_e164")
      .not("telnyx_sms_from_e164", "is", null),
    db.from("telnyx_voice_routes").select("business_id, to_e164")
  ]);
  if (settings.error) throw new Error(`listTenantDids settings: ${settings.error.message}`);
  if (routes.error) throw new Error(`listTenantDids routes: ${routes.error.message}`);

  const dids: Array<{ businessId: string; e164: string }> = [];
  for (const row of settings.data ?? []) {
    const r = row as { business_id?: string; telnyx_sms_from_e164?: string | null };
    if (r.business_id && r.telnyx_sms_from_e164) {
      dids.push({ businessId: r.business_id, e164: r.telnyx_sms_from_e164 });
    }
  }
  for (const row of routes.data ?? []) {
    const r = row as { business_id?: string; to_e164?: string | null };
    if (r.business_id && r.to_e164) {
      dids.push({ businessId: r.business_id, e164: r.to_e164 });
    }
  }
  return dids;
}

/** vm_id → owning business for non-wiped tenants on a Hostinger VM. */
export async function listBusinessVpsAssignments(
  client?: SupabaseClient
): Promise<Array<{ businessId: string; vmId: number }>> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("id, hostinger_vps_id, status")
    .not("hostinger_vps_id", "is", null)
    .neq("status", "wiped");
  if (error) throw new Error(`listBusinessVpsAssignments: ${error.message}`);

  const assignments: Array<{ businessId: string; vmId: number }> = [];
  for (const row of data ?? []) {
    const r = row as { id?: string; hostinger_vps_id?: string | null };
    const vmId = Number.parseInt(r.hostinger_vps_id ?? "", 10);
    if (r.id && Number.isFinite(vmId) && vmId > 0) {
      assignments.push({ businessId: r.id, vmId });
    }
  }
  return assignments;
}
