/**
 * pull-cost-data.ts — read-only data pull feeding the tier-economics canvas
 * (Standard-on-KVM2 plan, Part C). Gathers, for one business (default Amy):
 *
 *   1. Hostinger VPS catalog — every KVM2/KVM8 price entry (all term lengths),
 *      so the canvas can price monthly vs 12/24-month term buying.
 *   2. The business's real usage from Supabase:
 *        - daily_usage rolled up per calendar month (voice minutes, SMS, calls)
 *        - voice_billing_period_usage (per Stripe period voice seconds vs cap)
 *        - voice_settlements billable_seconds per month (ground truth actually
 *          reserved+settled through Telnyx)
 *        - sms_outbound_log + sms_inbound_jobs per month (both directions)
 *        - owner_chat_model_spend rows (Gemini spend fuse, micro-USD)
 *        - active subscription (plan tier, billing period, Stripe period)
 *   3. Telnyx actuals via /v2/detail_records (last 90 days): per-record-type
 *      count + summed cost for messaging and voice, so the canvas uses INVOICE
 *      rates, not list rates. Skipped with a warning if TELNYX_API_KEY is
 *      absent.
 *
 * Everything is written to debug/.cost-data-<businessId>.json plus a console
 * summary. Strictly read-only: no writes to Supabase, Hostinger, or Telnyx.
 *
 * Usage:
 *   npx tsx debug/pull-cost-data.ts                     # Amy
 *   npx tsx debug/pull-cost-data.ts --business <uuid>
 *   npx tsx debug/pull-cost-data.ts --telnyx-days 30    # narrower MDR window
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv, makeHostingerClient } from "./_shared.ts";

loadEnv();

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

const BUSINESS_ID = argValue("--business") ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3"; // Amy
// A non-numeric/absurd --telnyx-days must fall back to the documented 90-day
// default; NaN comparisons are all false, which would otherwise silently
// select the narrowest last_7_days preset.
const telnyxDaysRaw = Number(argValue("--telnyx-days") ?? "90");
const TELNYX_DAYS = Number.isFinite(telnyxDaysRaw) && telnyxDaysRaw > 0 ? telnyxDaysRaw : 90;

const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
const db = await createSupabaseServiceClient();
const hostinger = makeHostingerClient();

const monthOf = (iso: string): string => iso.slice(0, 7);
type NumMap = Record<string, number>;
const bump = (m: NumMap, k: string, v: number): void => {
  m[k] = (m[k] ?? 0) + v;
};

/**
 * Drain a Supabase query in 1000-row pages. PostgREST silently caps a single
 * request at 1000 rows, which for a busy tenant would drop the NEWEST usage
 * out of the rollups without any signal. `build` must apply a stable ORDER BY
 * so `.range()` pagination is deterministic.
 */
async function fetchAllRows<T>(
  label: string,
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const pageSize = 1000;
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1);
    if (error) {
      console.error(`${label} page starting at ${from} failed: ${error.message}`);
      process.exit(1);
    }
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

// ------------------------------------------------------------------ business
const { data: biz, error: bizErr } = await db
  .from("businesses")
  .select("id, name, tier, status, phone, vps_size, created_at")
  .eq("id", BUSINESS_ID)
  .single();
if (bizErr || !biz) {
  console.error(`business ${BUSINESS_ID} not found: ${bizErr?.message}`);
  process.exit(1);
}
console.log(`== cost data pull: ${biz.name} (tier=${biz.tier}) ==`);

const { data: subs } = await db
  .from("subscriptions")
  .select(
    "id, status, plan_tier, billing_period, stripe_current_period_start, stripe_current_period_end, hostinger_billing_subscription_id, created_at"
  )
  .eq("business_id", BUSINESS_ID)
  .order("created_at", { ascending: false });

// -------------------------------------------------------- hostinger catalog
console.log(`\n-- Hostinger VPS catalog (KVM1/KVM2/KVM4/KVM8, every term) --`);
const catalog = await hostinger.listCatalog("VPS");
const hostingerPrices: Array<{
  item: string;
  priceId: string;
  periodUnit: string;
  period: number | undefined;
  priceUsd: number;
  firstPeriodUsd: number | null;
  effectiveMonthlyUsd: number | null;
}> = [];
for (const item of catalog) {
  if (!/kvm/i.test(item.name)) continue;
  for (const p of item.prices) {
    if (!/usd/i.test(p.id)) continue;
    const period = (p as unknown as { period?: number }).period;
    const months =
      p.period_unit === "month" ? (period ?? 1) : p.period_unit === "year" ? (period ?? 1) * 12 : null;
    hostingerPrices.push({
      item: item.name,
      priceId: p.id,
      periodUnit: p.period_unit,
      period,
      priceUsd: p.price / 100,
      firstPeriodUsd: p.first_period_price !== undefined ? p.first_period_price / 100 : null,
      effectiveMonthlyUsd: months ? Number((p.price / 100 / months).toFixed(2)) : null
    });
  }
}
for (const p of hostingerPrices.filter((x) => /KVM [28]/i.test(x.item))) {
  console.log(
    `  ${p.item.padEnd(8)} ${p.priceId.padEnd(36)} $${p.priceUsd.toFixed(2)}/${p.period ?? 1}${p.periodUnit}` +
      (p.effectiveMonthlyUsd !== null ? `  (= $${p.effectiveMonthlyUsd}/mo)` : "") +
      (p.firstPeriodUsd !== null ? `  first=$${p.firstPeriodUsd.toFixed(2)}` : "")
  );
}

// ------------------------------------------------------------- daily_usage
const usageRows = await fetchAllRows(
  "daily_usage",
  (from, to) =>
    db
      .from("daily_usage")
      .select("usage_date, voice_minutes_used, sms_sent, calls_made, peak_concurrent_calls")
      .eq("business_id", BUSINESS_ID)
      .order("usage_date", { ascending: true })
      .range(from, to)
);
const usageByMonth: Record<
  string,
  { voiceMinutes: number; smsSent: number; calls: number; peakConcurrent: number; days: number }
> = {};
for (const r of usageRows) {
  const m = monthOf(r.usage_date);
  usageByMonth[m] ??= { voiceMinutes: 0, smsSent: 0, calls: 0, peakConcurrent: 0, days: 0 };
  usageByMonth[m].voiceMinutes += r.voice_minutes_used;
  usageByMonth[m].smsSent += r.sms_sent;
  usageByMonth[m].calls += r.calls_made;
  usageByMonth[m].peakConcurrent = Math.max(usageByMonth[m].peakConcurrent, r.peak_concurrent_calls);
  usageByMonth[m].days += 1;
}
console.log(`\n-- daily_usage by month (${usageRows.length} day rows) --`);
for (const [m, u] of Object.entries(usageByMonth)) {
  console.log(
    `  ${m}: voice=${u.voiceMinutes}min sms=${u.smsSent} calls=${u.calls} peakConcurrent=${u.peakConcurrent} (${u.days} active days)`
  );
}

// ------------------------------------------------- voice period usage + settlements
const { data: voicePeriods } = await db
  .from("voice_billing_period_usage")
  .select("*")
  .eq("business_id", BUSINESS_ID)
  .order("period_start", { ascending: true });

const settlements = await fetchAllRows(
  "voice_settlements",
  (from, to) =>
    db
      .from("voice_settlements")
      .select("created_at, billable_seconds, telnyx_reported_duration_seconds")
      .eq("business_id", BUSINESS_ID)
      .order("created_at", { ascending: true })
      // Unique tiebreaker: created_at alone can collide, making .range()
      // page boundaries non-deterministic (skipped/duplicated rows).
      // voice_settlements has no id column; its PK is call_control_id.
      .order("call_control_id", { ascending: true })
      .range(from, to)
);
const settledSecondsByMonth: NumMap = {};
for (const s of settlements) {
  bump(settledSecondsByMonth, monthOf(s.created_at), s.billable_seconds ?? 0);
}
console.log(`\n-- voice settlements (${settlements.length} calls) --`);
for (const [m, secs] of Object.entries(settledSecondsByMonth)) {
  console.log(`  ${m}: ${(secs / 60).toFixed(1)} billable minutes`);
}

// ------------------------------------------------------------------ SMS both ways
const smsOut = await fetchAllRows(
  "sms_outbound_log",
  (from, to) =>
    db
      .from("sms_outbound_log")
      .select("created_at, source")
      .eq("business_id", BUSINESS_ID)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)
);
const smsOutByMonth: NumMap = {};
for (const r of smsOut) bump(smsOutByMonth, monthOf(r.created_at), 1);

const smsIn = await fetchAllRows(
  "sms_inbound_jobs",
  (from, to) =>
    db
      .from("sms_inbound_jobs")
      .select("created_at")
      .eq("business_id", BUSINESS_ID)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)
);
const smsInByMonth: NumMap = {};
for (const r of smsIn) bump(smsInByMonth, monthOf(r.created_at), 1);
console.log(`\n-- SMS volume by month --`);
for (const m of [...new Set([...Object.keys(smsOutByMonth), ...Object.keys(smsInByMonth)])].sort()) {
  console.log(`  ${m}: outbound(worker)=${smsOutByMonth[m] ?? 0} inbound=${smsInByMonth[m] ?? 0}`);
}

// --------------------------------------------------------------- Gemini spend
const { data: spendRows } = await db
  .from("owner_chat_model_spend")
  .select("period_start, spend_micros, fuse_tripped_at, updated_at")
  .eq("business_id", BUSINESS_ID)
  .order("period_start", { ascending: true });
console.log(`\n-- Gemini spend fuse (owner_chat_model_spend) --`);
for (const r of spendRows ?? []) {
  console.log(
    `  period ${r.period_start}: $${(r.spend_micros / 1_000_000).toFixed(4)}` +
      (r.fuse_tripped_at ? `  FUSE TRIPPED ${r.fuse_tripped_at}` : "")
  );
}

// -------------------------------------------------------------- Telnyx MDRs
// Note: /v2/detail_records only accepts the PRESET date_range values
// (custom started_at[gte] silently matches nothing), so TELNYX_DAYS maps to
// the nearest preset. Records carry invoice-grade fields: `rate` (our
// per-unit price), `carrier_fee`, `cost` (= rate*count + fee), direction,
// cli/cld (so we can slice out this tenant's number).
interface TelnyxBucket {
  count: number;
  costUsd: number;
  rateUsd: number;
  carrierFeeUsd: number;
  billedSeconds: number;
}
const newBucket = (): TelnyxBucket => ({ count: 0, costUsd: 0, rateUsd: 0, carrierFeeUsd: 0, billedSeconds: 0 });
interface TelnyxAgg {
  account: Record<string, TelnyxBucket>; // key: direction or direction/month
  tenant: Record<string, TelnyxBucket>; // slice where cli/cld = this business's number
}
const telnyx: Record<string, TelnyxAgg> = {};
const telnyxKey = process.env.TELNYX_API_KEY ?? "";
const telnyxRange = TELNYX_DAYS > 30 ? "last_90_days" : TELNYX_DAYS > 7 ? "last_30_days" : "last_7_days";
// The tenant's Telnyx DIDs (what appears as cli/cld on MDRs): the messaging
// from-number plus every routed voice DID. businesses.phone is deliberately
// NOT used — that's the owner's onboarding cell, not a Telnyx number, and
// matching on it would attribute unrelated MDRs to this tenant.
const { data: telnyxSettings } = await db
  .from("business_telnyx_settings")
  .select("telnyx_sms_from_e164")
  .eq("business_id", BUSINESS_ID)
  .maybeSingle();
const { data: voiceRoutes } = await db
  .from("telnyx_voice_routes")
  .select("to_e164")
  .eq("business_id", BUSINESS_ID);
const tenantDidSuffixes = [
  ...new Set(
    [telnyxSettings?.telnyx_sms_from_e164, ...(voiceRoutes ?? []).map((r) => r.to_e164)]
      .map((n) => (n ?? "").replace(/[^+\d]/g, ""))
      .filter((n) => n.length >= 10)
      .map((n) => n.slice(-10))
  )
];
if (tenantDidSuffixes.length === 0) {
  console.log(`  [telnyx] WARNING: no Telnyx DIDs found for this business — tenant slices will be empty`);
}
let telnyxError: string | null = null;
if (!telnyxKey) {
  telnyxError = "TELNYX_API_KEY not set — skipped";
} else {
  // "messaging" = SMS/MMS MDRs, "sip-trunking" = voice call legs.
  for (const recordType of ["messaging", "sip-trunking"] as const) {
    const agg = (telnyx[recordType] ??= { account: {}, tenant: {} });
    let page = 1;
    for (;;) {
      const url =
        `https://api.telnyx.com/v2/detail_records?filter[record_type]=${recordType}` +
        `&filter[date_range]=${telnyxRange}&page[number]=${page}&page[size]=250`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${telnyxKey}` } });
      if (!res.ok) {
        // Record the failure so the JSON output flags the aggregates as
        // partial instead of silently reporting telnyx.error=null.
        const failure = `${recordType} page ${page}: HTTP ${res.status} ${(await res.text()).slice(0, 300)} — aggregates are partial`;
        console.log(`  [telnyx] ${failure}`);
        telnyxError = telnyxError ? `${telnyxError}; ${failure}` : failure;
        break;
      }
      const body = (await res.json()) as {
        data?: Array<Record<string, unknown>>;
        meta?: { total_pages?: number };
      };
      const pageSize = 250;
      const rows = body.data ?? [];
      for (const r of rows) {
        const num = (v: unknown): number => (typeof v === "string" || typeof v === "number" ? Number(v) || 0 : 0);
        const str = (v: unknown): string => (typeof v === "string" ? v : "");
        const direction = str(r.direction) || "unknown";
        const when = str(r.sent_at) || str(r.started_at) || str(r.created_at);
        const month = when ? monthOf(when) : "unknown";
        const cli = str(r.cli).replace(/[^+\d]/g, "");
        const cld = str(r.cld).replace(/[^+\d]/g, "");
        const isTenant = tenantDidSuffixes.some((s) => cli.endsWith(s) || cld.endsWith(s));
        const add = (map: Record<string, TelnyxBucket>, key: string): void => {
          const b = (map[key] ??= newBucket());
          b.count += num(r.count) || 1;
          b.costUsd += num(r.cost);
          b.rateUsd += num(r.rate) * (num(r.count) || 1);
          b.carrierFeeUsd += num(r.carrier_fee);
          b.billedSeconds += num(r.billed_sec ?? r.billsec ?? r.billed_seconds);
        };
        add(agg.account, direction);
        add(agg.account, `${direction}/${month}`);
        if (isTenant) {
          add(agg.tenant, direction);
          add(agg.tenant, `${direction}/${month}`);
        }
      }
      // Don't trust a missing meta.total_pages (defaulting it to 1 would stop
      // after a full first page): keep paging while pages come back full, and
      // stop early only when total_pages is present and says we're done.
      const totalPages = body.meta?.total_pages;
      if (rows.length < pageSize) break;
      if (typeof totalPages === "number" && page >= totalPages) break;
      page += 1;
    }
  }
}
console.log(`\n-- Telnyx detail records (${telnyxRange}) --`);
if (telnyxError) console.log(`  WARNING: ${telnyxError}`);
for (const [type, agg] of Object.entries(telnyx)) {
  for (const [scope, map] of [
    ["account", agg.account],
    [`tenant …${tenantDidSuffixes.join(",…") || "?"}`, agg.tenant]
  ] as const) {
    for (const [key, b] of Object.entries(map).sort()) {
      const unit = type === "messaging" ? `${b.count} msgs` : `${(b.billedSeconds / 60).toFixed(1)} min (${b.count} legs)`;
      console.log(
        `  ${type} [${scope}] ${key}: ${unit}  cost=$${b.costUsd.toFixed(4)} (rate=$${b.rateUsd.toFixed(4)} + carrier=$${b.carrierFeeUsd.toFixed(4)})`
      );
    }
  }
}

// ------------------------------------------------------------------- output
const out = {
  pulledAt: new Date().toISOString(),
  business: biz,
  subscriptions: subs ?? [],
  hostingerCatalog: hostingerPrices,
  usageByMonth,
  voiceBillingPeriods: voicePeriods ?? [],
  voiceSettledSecondsByMonth: settledSecondsByMonth,
  smsOutboundByMonth: smsOutByMonth,
  smsInboundByMonth: smsInByMonth,
  geminiSpendRows: spendRows ?? [],
  telnyx: { range: telnyxRange, error: telnyxError, tenantDidSuffixes, byRecordType: telnyx }
};
const outFile = path.resolve(process.cwd(), `debug/.cost-data-${BUSINESS_ID}.json`);
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
console.log(`\nwritten: ${outFile}`);
