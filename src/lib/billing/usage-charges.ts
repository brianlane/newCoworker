/**
 * Billable third-party usage carve-out for the 30-day money-back refund.
 *
 * Policy (Jul 2026): the money-back guarantee refunds the plan price, not
 * the third-party charges the tenant ran up on our vendor accounts — SMS
 * sent AND received (Telnyx), voice minutes (Telnyx carriage), and metered
 * Gemini spend. Those are priced AT OUR COST — the same per-unit rates the
 * margin engine and the enterprise deal calculator use
 * (src/lib/plans/enterprise-pricing.ts) — so the carve-out recovers exactly
 * what we are out of pocket, no markup.
 *
 * Voice is priced at the TELNYX-ONLY per-minute rate on purpose: the Gemini
 * side of a call is NOT estimated here because it arrives as metered
 * actuals in `aiSpendMicros` — `owner_chat_model_spend` is the single pool
 * for ALL per-tenant Gemini usage (llm-router exact tokens for Rowboat
 * chat/SMS/voice_task, platform surfaces via meterGeminiSpendForBusiness
 * incl. image generation, webchat/messenger engines, and Gemini Live audio
 * settled at call teardown via `owner_chat_ai_settle`). Pricing voice
 * all-in here would double-charge the Gemini Live component.
 *
 * The refund executor subtracts the resulting cents from the Stripe refund
 * alongside the carrier-registration fee and the term carve-out (see
 * `refund_latest_charge` in lifecycle-executor.ts). Loaders here THROW on
 * read errors: the refund routes fail closed (retryable error) rather than
 * refunding money we cannot verify wasn't already spent on usage.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { ENTERPRISE_UNIT_COSTS } from "@/lib/plans/enterprise-pricing";
import {
  isWithinLifetimeRefundWindow,
  type CustomerProfileRow
} from "@/lib/db/customer-profiles";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type BillableUsage = {
  smsSent: number;
  /** Inbound messages (one `sms_inbound_jobs` row per delivered inbound). */
  smsReceived: number;
  /** Settled AI voice seconds + forwarded/transferred human-leg seconds. */
  voiceSeconds: number;
  /**
   * Metered Gemini spend, micro-USD (1 cent = 10,000 micros). Covers ALL
   * per-tenant Gemini usage, not just chat — see the module docstring.
   */
  aiSpendMicros: number;
};

/**
 * Price a usage snapshot at platform cost. Rounded once at the end so the
 * components can't each donate a rounding cent. Voice is Telnyx-only — the
 * Gemini component is already inside `aiSpendMicros` (module docstring).
 */
export function computeBillableUsageCents(usage: BillableUsage): number {
  return Math.round(
    usage.smsSent * ENTERPRISE_UNIT_COSTS.smsOutboundCentsPerMessage +
      usage.smsReceived * ENTERPRISE_UNIT_COSTS.smsInboundCentsPerMessage +
      (usage.voiceSeconds / 60) * ENTERPRISE_UNIT_COSTS.voiceTelnyxCentsPerMinute +
      usage.aiSpendMicros / 10_000
  );
}

export type UsageCarveOutWindow = {
  /** Anchor for the timestamp-keyed reads (SMS days, voice settlements/meters). */
  sinceIso: string;
  /**
   * `period_start` filter for the AI-spend read; null = sum EVERY spend row
   * for the business. Null only in the first-paid fallback: the spend
   * writers key `period_start` at the UTC calendar-month start when the
   * subscription's Stripe period cache is cold, which can predate a
   * mid-month `first_paid_at` — a `>= sinceIso` filter would silently miss
   * the current spend row. In that fallback the account is ≤30 days old,
   * so its lifetime spend IS the refundable-window spend.
   */
  aiSpendSinceIso: string | null;
};

export type UsageCarveOutAnchor =
  | { ok: true; window: UsageCarveOutWindow }
  | { ok: false; reason: "usage_window_unknown" };

/**
 * The window of usage the refund may withhold.
 *
 * The refund executor refunds the LATEST Stripe invoice only, so the usage
 * we may withhold is exactly the usage covered by that invoice's period:
 * the cached `stripe_current_period_start` (for monthly plans the current
 * month; for full-upfront term plans the whole term — the Stripe period IS
 * the term via `interval_count=12|24`).
 *
 * When the period cache is missing (fresh checkout before the first
 * lifecycle webhook, pre-backfill rows), the profile's `first_paid_at` is a
 * safe substitute ONLY while the lifetime 30-day money-back window is still
 * open — the account is ≤30 days old, so "everything since first payment"
 * and "the refunded invoice's period" coincide. Outside that window (admin
 * force-refund of a long-lived subscription with a cold cache) there is NO
 * safe fallback: anchoring on `first_paid_at` would subtract months of
 * prior-period usage from a one-month refund. We FAIL CLOSED instead —
 * the operator remedy is `scripts/backfill-stripe-subscription-periods.ts`.
 */
export function resolveUsageCarveOutWindow(input: {
  stripeCurrentPeriodStart: string | null;
  profile: Pick<CustomerProfileRow, "first_paid_at" | "refund_used_at"> | null;
  now?: Date;
}): UsageCarveOutAnchor {
  if (
    input.stripeCurrentPeriodStart &&
    Number.isFinite(Date.parse(input.stripeCurrentPeriodStart))
  ) {
    // Spend writers key windows via deriveMonthlyQuotaWindow(periodStart),
    // which never precedes the period start — the >= filter is exact here.
    return {
      ok: true,
      window: {
        sinceIso: input.stripeCurrentPeriodStart,
        aiSpendSinceIso: input.stripeCurrentPeriodStart
      }
    };
  }
  if (
    input.profile !== null &&
    isWithinLifetimeRefundWindow(input.profile, input.now ?? new Date())
  ) {
    // Window-open implies a non-null, parseable first_paid_at — the window
    // is anchored on it (a null/malformed timestamp reads as closed).
    return {
      ok: true,
      window: {
        sinceIso: input.profile.first_paid_at as string,
        aiSpendSinceIso: null
      }
    };
  }
  return { ok: false, reason: "usage_window_unknown" };
}

/**
 * Sum the tenant's metered usage inside the carve-out window:
 *
 * - Outbound SMS from `daily_usage.sms_sent` (usage_date ≥ the window's UTC
 *   day — the whole signup day counts, which can only over-include the
 *   tenant's own sends from earlier that day).
 * - Inbound SMS from `sms_inbound_jobs` (one row per delivered inbound
 *   message, deduped by Telnyx event id — AI-reply jobs, team/owner reply
 *   captures, and safe-mode forwards all persist here). Counted with a
 *   HEAD count query, so no paging concern. Keyword-only traffic
 *   (STOP/HELP) that short-circuits before the insert is not counted —
 *   under-counting in the customer's favor.
 * - Voice from `voice_settlements.billable_seconds` (AI portions) plus
 *   `voice_forwarded_call_meter.billable_seconds` (forwarded/transferred
 *   human legs) — together the same population the quota pool commits.
 * - Metered Gemini spend from `owner_chat_model_spend` rows, filtered by
 *   `period_start` ≥ `aiSpendSinceIso` when set (see
 *   {@link UsageCarveOutWindow.aiSpendSinceIso} for why the first-paid
 *   fallback sums every row instead).
 *
 * Every read pages in 1000-row chunks: PostgREST silently caps a single
 * response at 1000 rows, and a silent truncation here would under-withhold
 * (refund money already spent on usage) with no error. Read failures THROW
 * — callers fail closed.
 */
export async function loadBillableUsageSince(
  businessId: string,
  window: UsageCarveOutWindow,
  client?: SupabaseClient
): Promise<BillableUsage> {
  const db = client ?? (await createSupabaseServiceClient());
  const pageSize = 1000;
  const sinceIso = window.sinceIso;
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

  const { count: inboundCount, error: inboundErr } = await db
    .from("sms_inbound_jobs")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .gte("created_at", sinceIso);
  if (inboundErr) {
    throw new Error(`loadBillableUsageSince(sms_inbound_jobs): ${inboundErr.message}`);
  }
  const smsReceived = inboundCount ?? 0;

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
    let query = db
      .from("owner_chat_model_spend")
      .select("spend_micros")
      .eq("business_id", businessId);
    if (window.aiSpendSinceIso !== null) {
      query = query.gte("period_start", window.aiSpendSinceIso);
    }
    const { data, error } = await query
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

  return { smsSent, smsReceived, voiceSeconds, aiSpendMicros };
}

/** Load + price in one call — what the refund routes use. */
export async function loadBillableUsageCarveOutCents(
  businessId: string,
  window: UsageCarveOutWindow,
  client?: SupabaseClient
): Promise<{ usage: BillableUsage; cents: number }> {
  const usage = await loadBillableUsageSince(businessId, window, client);
  return { usage, cents: computeBillableUsageCents(usage) };
}
