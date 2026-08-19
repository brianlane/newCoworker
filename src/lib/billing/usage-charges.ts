/**
 * Billable third-party usage carve-out for the 30-day money-back refund.
 *
 * Policy (Jul 2026): the money-back guarantee refunds the plan price, not
 * the third-party charges the tenant ran up on our vendor accounts, SMS
 * sent AND received (Telnyx), voice minutes (Telnyx carriage), and metered
 * Gemini spend. Those are priced AT OUR COST, the same per-unit rates the
 * margin engine and the enterprise deal calculator use
 * (src/lib/plans/enterprise-pricing.ts), so the carve-out recovers exactly
 * what we are out of pocket, no markup.
 *
 * Voice is priced at the TELNYX-ONLY per-minute rate on purpose: the Gemini
 * side of a call is NOT estimated here because it arrives as metered
 * actuals in `aiSpendMicros`, `owner_chat_model_spend` is the single pool
 * for ALL per-tenant Gemini usage (llm-router exact tokens for Rowboat
 * chat/SMS/voice_task, platform surfaces via meterGeminiSpendForBusiness
 * incl. image generation, webchat/messenger engines, and Gemini Live audio
 * settled at call teardown via `owner_chat_ai_settle`). Pricing voice
 * all-in here would double-charge the Gemini Live component.
 *
 * The refund executor subtracts the resulting cents from the Stripe refund
 * alongside the carrier-registration fee, the membership pack carve-out,
 * and the term carve-out (see `refund_latest_charge` in
 * lifecycle-executor.ts). Loaders here THROW on read errors: the refund
 * routes fail closed (retryable error) rather than refunding money we
 * cannot verify wasn't already spent on usage.
 *
 * Bonus-funded usage is NOT withheld (Aug 2026): usage that drew on pack
 * credits was already paid for with money New Coworker keeps (membership
 * pack invoice lines are carved out of the refund in full, and standalone
 * Checkout top-ups were never customer-refundable), so withholding its
 * vendor cost again would charge the customer twice for the same units.
 * `loadBonusFundedUsageOffsets` measures what was actually consumed from
 * packs and `loadBillableUsageCarveOutCents` subtracts it before pricing.
 * A customer whose usage never dipped into their packs has zero offsets
 * and an unchanged carve-out. Accepted approximations (each bounded, and
 * wrong only in the customer's favor): the SMS offset is grant-lifetime
 * consumption rather than windowed, and the chat offset attributes spend
 * above the base tier cap to packs. An offset read error THROWS like every
 * other loader here: a silent zero offset would quietly reinstate the
 * double-charge.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { ENTERPRISE_UNIT_COSTS } from "@/lib/plans/enterprise-pricing";
import { chatSpendBaseCapMicrosForTier } from "@/lib/db/chat-usage";
import type { PlanTier } from "@/lib/plans/tier";
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
   * per-tenant Gemini usage, not just chat, see the module docstring.
   */
  aiSpendMicros: number;
};

/**
 * Price a usage snapshot at platform cost. Rounded once at the end so the
 * components can't each donate a rounding cent. Voice is Telnyx-only, the
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

export type BonusFundedUsageOffsets = {
  /** AI-settled seconds funded by voice bonus grants (forwarded human legs never are). */
  voiceSeconds: number;
  /** Outbound sends funded by SMS bonus grants (inbound never draws bonus). */
  smsSent: number;
  /** Window spend above the per-window base cap, clamped to unvoided pack credit. */
  aiSpendMicros: number;
};

/**
 * Remove bonus-funded units from a usage snapshot so only plan-funded usage
 * gets priced. Every lane clamps at zero: an offset can only shrink the
 * carve-out, never mint negative usage. Inbound SMS never draws bonus, so
 * it passes through untouched.
 */
export function applyBonusFundedUsageOffsets(
  usage: BillableUsage,
  offsets: BonusFundedUsageOffsets
): BillableUsage {
  return {
    smsSent: Math.max(0, usage.smsSent - offsets.smsSent),
    smsReceived: usage.smsReceived,
    voiceSeconds: Math.max(0, usage.voiceSeconds - offsets.voiceSeconds),
    aiSpendMicros: Math.max(0, usage.aiSpendMicros - offsets.aiSpendMicros)
  };
}

export type UsageCarveOutWindow = {
  /** Anchor for the timestamp-keyed reads (SMS days, voice settlements/meters). */
  sinceIso: string;
  /**
   * `period_start` filter for the AI-spend read; null = sum EVERY spend row
   * for the business. Null only in the first-paid fallback: the spend
   * writers key `period_start` at the UTC calendar-month start when the
   * subscription's Stripe period cache is cold, which can predate a
   * mid-month `first_paid_at`, a `>= sinceIso` filter would silently miss
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
 * month; for full-upfront term plans the whole term, the Stripe period IS
 * the term via `interval_count=12|24`).
 *
 * When the period cache is missing (fresh checkout before the first
 * lifecycle webhook, pre-backfill rows), the profile's `first_paid_at` is a
 * safe substitute ONLY while the lifetime 30-day money-back window is still
 * open, the account is ≤30 days old, so "everything since first payment"
 * and "the refunded invoice's period" coincide. Outside that window (admin
 * force-refund of a long-lived subscription with a cold cache) there is NO
 * safe fallback: anchoring on `first_paid_at` would subtract months of
 * prior-period usage from a one-month refund. We FAIL CLOSED instead,
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
    // which never precedes the period start, the >= filter is exact here.
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
    // Window-open implies a non-null, parseable first_paid_at, the window
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
 *   day, the whole signup day counts, which can only over-include the
 *   tenant's own sends from earlier that day).
 * - Inbound SMS from `sms_inbound_jobs` (one row per delivered inbound
 *   message, deduped by Telnyx event id, AI-reply jobs, team/owner reply
 *   captures, and safe-mode forwards all persist here). Counted with a
 *   HEAD count query, so no paging concern. Keyword-only traffic
 *   (STOP/HELP) that short-circuits before the insert is not counted,
 *   under-counting in the customer's favor.
 * - Voice from `voice_settlements.billable_seconds` (AI portions) plus
 *   `voice_forwarded_call_meter.billable_seconds` (forwarded/transferred
 *   human legs), together the same population the quota pool commits.
 * - Metered Gemini spend from `owner_chat_model_spend` rows, filtered by
 *   `period_start` ≥ `aiSpendSinceIso` when set (see
 *   {@link UsageCarveOutWindow.aiSpendSinceIso} for why the first-paid
 *   fallback sums every row instead).
 *
 * Every read pages in 1000-row chunks: PostgREST silently caps a single
 * response at 1000 rows, and a silent truncation here would under-withhold
 * (refund money already spent on usage) with no error. Read failures THROW,
 * callers fail closed.
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

/**
 * Measure how much of the metered usage was funded by pack credits.
 *
 * - Voice: per settled call, seconds beyond what the plan reservation
 *   covered: max(0, settled billable - reserved_included_seconds). This is
 *   the same invariant the finalize RPC commits (commit_inc =
 *   least(billable, reserved_included)), read through the settlements join
 *   so it is windowed, bounded by the settled subtotal (forwarded human
 *   legs never draw bonus), and immune to grant voiding. Rows with a
 *   malformed reserved_included contribute 0 (withhold, conservative).
 * - SMS: consumed texts on unvoided grants (texts_purchased -
 *   texts_remaining), applied to outbound only. The void RPCs zero
 *   `texts_remaining`, so a voided grant would read as fully consumed;
 *   voided also means the pack money went back to the customer, so its
 *   usage is legitimately withholdable. Grant-lifetime scoped; the apply
 *   clamp bounds any pre-window leak.
 * - Chat: packs raise the period cap instead of draining, so attribution
 *   is per spend window: sum of max(0, spend_micros - base tier cap),
 *   clamped to the unvoided pack credit total read straight from the
 *   grant table (NOT the chat_active_credit_micros RPC, which drops
 *   grants that expired between funding the overage and an admin_force
 *   refund). No packs means a zero ceiling, so settlement overshoot past
 *   the base cap stays withheld.
 *
 * Documented read order (composed tests depend on it): voice_reservations,
 * sms_bonus_grants, businesses, owner_chat_model_spend,
 * chat_spend_credit_grants. Read errors THROW; callers fail closed.
 */
export async function loadBonusFundedUsageOffsets(
  businessId: string,
  window: UsageCarveOutWindow,
  client?: SupabaseClient
): Promise<BonusFundedUsageOffsets> {
  const db = client ?? (await createSupabaseServiceClient());
  const pageSize = 1000;

  let voiceSeconds = 0;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("voice_reservations")
      .select("reserved_included_seconds, voice_settlements!inner(billable_seconds)")
      .eq("business_id", businessId)
      .gte("voice_settlements.created_at", window.sinceIso)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      throw new Error(`loadBonusFundedUsageOffsets(voice_reservations): ${error.message}`);
    }
    const rows = data ?? [];
    for (const row of rows) {
      const r = row as {
        reserved_included_seconds?: number | null;
        voice_settlements?: Array<{ billable_seconds?: number | null }> | null;
      };
      // Strict number check: Number(null) is 0, which would misread a
      // malformed row as "nothing plan-covered" and count the whole call
      // as bonus. Malformed rows contribute 0 instead (conservative).
      const included =
        typeof r.reserved_included_seconds === "number"
          ? r.reserved_included_seconds
          : Number.NaN;
      if (!Number.isFinite(included) || included < 0) continue;
      let settled = 0;
      for (const s of r.voice_settlements ?? []) {
        const n = Number(s?.billable_seconds ?? 0);
        if (Number.isFinite(n) && n > 0) settled += n;
      }
      voiceSeconds += Math.max(0, settled - included);
    }
    if (rows.length < pageSize) break;
  }

  let smsSent = 0;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("sms_bonus_grants")
      .select("texts_purchased, texts_remaining")
      .eq("business_id", businessId)
      .is("voided_at", null)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      throw new Error(`loadBonusFundedUsageOffsets(sms_bonus_grants): ${error.message}`);
    }
    const rows = data ?? [];
    for (const row of rows) {
      const r = row as { texts_purchased?: number | null; texts_remaining?: number | null };
      // Strict number checks, like the voice lane: Number(null) is 0, and a
      // null texts_remaining would fake a fully consumed grant.
      const purchased = typeof r.texts_purchased === "number" ? r.texts_purchased : Number.NaN;
      const remaining = typeof r.texts_remaining === "number" ? r.texts_remaining : Number.NaN;
      if (!Number.isFinite(purchased) || !Number.isFinite(remaining)) continue;
      smsSent += Math.max(0, purchased - remaining);
    }
    if (rows.length < pageSize) break;
  }

  const { data: bizRow, error: bizErr } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (bizErr) {
    throw new Error(`loadBonusFundedUsageOffsets(businesses): ${bizErr.message}`);
  }
  // Missing row/tier prices against the standard (higher) base cap, the
  // same fallback the live meter uses (ai-spend-meter.ts); a higher cap
  // can only shrink the offset, never inflate it.
  const baseCapMicros = chatSpendBaseCapMicrosForTier(
    (bizRow as { tier?: PlanTier | null } | null)?.tier ?? null
  );

  let rawChatOverageMicros = 0;
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
    if (error) {
      throw new Error(`loadBonusFundedUsageOffsets(owner_chat_model_spend): ${error.message}`);
    }
    const rows = data ?? [];
    for (const row of rows) {
      const n = Number((row as { spend_micros?: number | string | null }).spend_micros ?? 0);
      if (Number.isFinite(n) && n > baseCapMicros) rawChatOverageMicros += n - baseCapMicros;
    }
    if (rows.length < pageSize) break;
  }

  let packCreditCeilingMicros = 0;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("chat_spend_credit_grants")
      .select("credit_micros")
      .eq("business_id", businessId)
      .is("voided_at", null)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      throw new Error(`loadBonusFundedUsageOffsets(chat_spend_credit_grants): ${error.message}`);
    }
    const rows = data ?? [];
    for (const row of rows) {
      const n = Number((row as { credit_micros?: number | string | null }).credit_micros ?? 0);
      if (Number.isFinite(n) && n > 0) packCreditCeilingMicros += n;
    }
    if (rows.length < pageSize) break;
  }

  return {
    voiceSeconds,
    smsSent,
    aiSpendMicros: Math.min(rawChatOverageMicros, packCreditCeilingMicros)
  };
}

/**
 * Load, offset, and price in one call: what the refund routes use. The
 * carve-out prices ONLY plan-funded usage (raw metered minus bonus-funded
 * offsets); both snapshots come back for logging and future admin display.
 */
export async function loadBillableUsageCarveOutCents(
  businessId: string,
  window: UsageCarveOutWindow,
  client?: SupabaseClient
): Promise<{
  usage: BillableUsage;
  offsets: BonusFundedUsageOffsets;
  adjustedUsage: BillableUsage;
  cents: number;
}> {
  const db = client ?? (await createSupabaseServiceClient());
  const usage = await loadBillableUsageSince(businessId, window, db);
  const offsets = await loadBonusFundedUsageOffsets(businessId, window, db);
  const adjustedUsage = applyBonusFundedUsageOffsets(usage, offsets);
  const cents = computeBillableUsageCents(adjustedUsage);
  logger.info("usage carve-out: priced plan-funded usage only", {
    businessId,
    usage,
    offsets,
    cents
  });
  return { usage, offsets, adjustedUsage, cents };
}
