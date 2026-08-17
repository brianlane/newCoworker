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
  /**
   * The Telnyx sender identity behind an UNATTRIBUTED row (our own leg: cli
   * on outbound, cld on inbound): a phone number, or a non-numeric sender
   * id like an RCS agent. NULL on attributed rows, where `business_id`
   * already names the owner, and NULL on rows synced before the column
   * existed.
   */
  sender: string | null;
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

export type StripeFeeMonthlyInsert = {
  month_start: string; // YYYY-MM-01 (UTC)
  business_id: string | null;
  /** Every transaction type, so the totals reconcile with Stripe's net volume. */
  gross_cents: number;
  fee_cents: number;
  net_cents: number;
  /**
   * The same money restricted to real card charges. Rate derivation uses
   * THESE: Stripe keeps the fee when a charge is refunded, so a refund in
   * the totals lowers gross without lowering fee and inflates the derived
   * rate.
   */
  charge_gross_cents: number;
  charge_fee_cents: number;
  charge_count: number;
};

export type StripeFeeMonthlyRow = StripeFeeMonthlyInsert & {
  id: number;
  synced_at: string;
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

/**
 * Idempotent write for the rolling Stripe fee window: replace every row with
 * `month_start >= windowStart` with the fresh aggregates, in ONE transaction
 * (`replace_stripe_fee_window`) for the same reason as
 * {@link replaceTelnyxCostWindow}.
 */
export async function replaceStripeFeeWindow(
  windowStartMonth: string,
  rows: StripeFeeMonthlyInsert[],
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.rpc("replace_stripe_fee_window", {
    p_window_start: windowStartMonth,
    p_rows: rows
  });
  if (error) throw new Error(`replaceStripeFeeWindow: ${error.message}`);
}

/**
 * All Stripe fee rows with `month_start >= sinceMonth`, oldest first. Paged
 * for the same reason as {@link listTelnyxCostDaily}: PostgREST silently
 * caps a single request at 1000 rows.
 */
export async function listStripeFeeMonthly(
  sinceMonth: string,
  client?: SupabaseClient
): Promise<StripeFeeMonthlyRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const pageSize = 1000;
  const all: StripeFeeMonthlyRow[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("stripe_fee_monthly")
      .select()
      .gte("month_start", sinceMonth)
      .order("month_start", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`listStripeFeeMonthly: ${error.message}`);
    const rows = (data ?? []) as StripeFeeMonthlyRow[];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

/**
 * Stripe customer id → owning business, for attributing a balance
 * transaction to a tenant. Built from the subscriptions table (the only
 * place the customer id is recorded); history included, since a canceled
 * tenant's charges still settled against their customer id. A customer id
 * reused across rows for one business collapses to the same entry; the
 * first row wins if two businesses somehow share one, which would be a data
 * bug rather than something to average over.
 */
export async function listStripeCustomerBusinessIds(
  client?: SupabaseClient
): Promise<Array<{ businessId: string; stripeCustomerId: string }>> {
  const db = client ?? (await createSupabaseServiceClient());
  const pageSize = 1000;
  const seen = new Set<string>();
  const pairs: Array<{ businessId: string; stripeCustomerId: string }> = [];
  // Paged, like every other list here: an unbounded select is silently
  // capped at 1000 rows by PostgREST, and a dropped customer id is not an
  // error, it is a tenant whose fees quietly stop being attributed.
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("subscriptions")
      .select("business_id, stripe_customer_id")
      .not("stripe_customer_id", "is", null)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`listStripeCustomerBusinessIds: ${error.message}`);
    const rows = (data ?? []) as Array<{
      business_id?: string;
      stripe_customer_id?: string | null;
    }>;
    for (const r of rows) {
      if (!r.business_id || !r.stripe_customer_id) continue;
      if (seen.has(r.stripe_customer_id)) continue;
      seen.add(r.stripe_customer_id);
      pairs.push({ businessId: r.business_id, stripeCustomerId: r.stripe_customer_id });
    }
    if (rows.length < pageSize) break;
  }
  return pairs;
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
