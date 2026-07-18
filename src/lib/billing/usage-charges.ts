/**
 * Billable third-party usage carve-out for the 30-day money-back refund.
 *
 * Policy (Jul 2026): the money-back guarantee refunds the plan price, not
 * the third-party charges the tenant ran up on our vendor accounts — SMS
 * (Telnyx), voice minutes (Telnyx carriage + Gemini Live audio), and Gemini
 * chat spend. Those are priced AT OUR COST — the same per-unit rates the
 * margin engine and the enterprise deal calculator use
 * (src/lib/plans/enterprise-pricing.ts) — so the carve-out recovers exactly
 * what we are out of pocket, no markup.
 *
 * The refund executor subtracts the resulting cents from the Stripe refund
 * alongside the carrier-registration fee and the term carve-out (see
 * `refund_latest_charge` in lifecycle-executor.ts). Loaders here THROW on
 * read errors: the refund routes fail closed (retryable error) rather than
 * refunding money we cannot verify wasn't already spent on usage.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  ENTERPRISE_UNIT_COSTS,
  VOICE_ALL_IN_CENTS_PER_MINUTE
} from "@/lib/plans/enterprise-pricing";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type BillableUsage = {
  smsSent: number;
  /** Settled AI voice seconds + forwarded/transferred human-leg seconds. */
  voiceSeconds: number;
  /** Gemini chat spend, micro-USD (1 cent = 10,000 micros). */
  aiSpendMicros: number;
};

/**
 * Price a usage snapshot at platform cost. Rounded once at the end so the
 * three components can't each donate a rounding cent.
 */
export function computeBillableUsageCents(usage: BillableUsage): number {
  return Math.round(
    usage.smsSent * ENTERPRISE_UNIT_COSTS.smsOutboundCentsPerMessage +
      (usage.voiceSeconds / 60) * VOICE_ALL_IN_CENTS_PER_MINUTE +
      usage.aiSpendMicros / 10_000
  );
}

/**
 * The instant the refunded invoice's usage window opened: prefer the cached
 * Stripe period start (the invoice being refunded IS the current period),
 * then the profile's `first_paid_at` (self-serve refunds only exist within
 * 30 days of it), then the subscription row's creation. Never null — every
 * refundable subscription has a `created_at`.
 */
export function resolveUsageCarveOutSinceIso(input: {
  stripeCurrentPeriodStart: string | null;
  firstPaidAt: string | null;
  subscriptionCreatedAt: string;
}): string {
  if (input.stripeCurrentPeriodStart && Number.isFinite(Date.parse(input.stripeCurrentPeriodStart))) {
    return input.stripeCurrentPeriodStart;
  }
  if (input.firstPaidAt && Number.isFinite(Date.parse(input.firstPaidAt))) {
    return input.firstPaidAt;
  }
  return input.subscriptionCreatedAt;
}

/**
 * Sum the tenant's metered usage since `sinceIso`:
 *
 * - SMS from `daily_usage.sms_sent` (usage_date ≥ since's UTC day — the
 *   whole signup day counts, which can only over-include the tenant's own
 *   sends from earlier that day).
 * - Voice from `voice_settlements.billable_seconds` (AI portions) plus
 *   `voice_forwarded_call_meter.billable_seconds` (forwarded/transferred
 *   human legs) — together the same population the quota pool commits.
 * - Gemini chat spend from `owner_chat_model_spend` rows whose
 *   `period_start` ≥ since (window keys inside the Stripe period are always
 *   ≥ the period start).
 *
 * Every read pages in 1000-row chunks: PostgREST silently caps a single
 * response at 1000 rows, and a silent truncation here would under-withhold
 * (refund money already spent on usage) with no error. Read failures THROW
 * — callers fail closed.
 */
export async function loadBillableUsageSince(
  businessId: string,
  sinceIso: string,
  client?: SupabaseClient
): Promise<BillableUsage> {
  const db = client ?? (await createSupabaseServiceClient());
  const pageSize = 1000;
  const sinceYmd = sinceIso.slice(0, 10);

  let smsSent = 0;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("daily_usage")
      .select("sms_sent")
      .eq("business_id", businessId)
      .gte("usage_date", sinceYmd)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`loadBillableUsageSince(daily_usage): ${error.message}`);
    const rows = data ?? [];
    for (const row of rows) {
      smsSent += Number((row as { sms_sent?: number | null }).sms_sent ?? 0);
    }
    if (rows.length < pageSize) break;
  }

  let voiceSeconds = 0;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("voice_settlements")
      .select("billable_seconds")
      .eq("business_id", businessId)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true })
      .order("call_control_id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`loadBillableUsageSince(voice_settlements): ${error.message}`);
    const rows = data ?? [];
    for (const row of rows) {
      voiceSeconds += Number((row as { billable_seconds?: number | null }).billable_seconds ?? 0);
    }
    if (rows.length < pageSize) break;
  }
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("voice_forwarded_call_meter")
      .select("billable_seconds")
      .eq("business_id", businessId)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true })
      .order("call_control_id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      throw new Error(`loadBillableUsageSince(voice_forwarded_call_meter): ${error.message}`);
    }
    const rows = data ?? [];
    for (const row of rows) {
      voiceSeconds += Number((row as { billable_seconds?: number | null }).billable_seconds ?? 0);
    }
    if (rows.length < pageSize) break;
  }

  let aiSpendMicros = 0;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("owner_chat_model_spend")
      .select("spend_micros")
      .eq("business_id", businessId)
      .gte("period_start", sinceIso)
      .order("period_start", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`loadBillableUsageSince(owner_chat_model_spend): ${error.message}`);
    const rows = data ?? [];
    for (const row of rows) {
      const n = Number((row as { spend_micros?: number | string | null }).spend_micros ?? 0);
      if (Number.isFinite(n) && n > 0) aiSpendMicros += n;
    }
    if (rows.length < pageSize) break;
  }

  return { smsSent, voiceSeconds, aiSpendMicros };
}

/** Load + price in one call — what the refund routes use. */
export async function loadBillableUsageCarveOutCents(
  businessId: string,
  sinceIso: string,
  client?: SupabaseClient
): Promise<{ usage: BillableUsage; cents: number }> {
  const usage = await loadBillableUsageSince(businessId, sinceIso, client);
  return { usage, cents: computeBillableUsageCents(usage) };
}
