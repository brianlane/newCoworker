/**
 * Shared chat-model spend cap helpers for the SMS inbound worker.
 *
 * Background: inbound SMS replies now run on Gemini (the workflow `Coworker`
 * agent was repointed off local Qwen), so SMS bills per token. The owner picked
 * a single SHARED monthly pool across owner-dashboard chat + SMS: spend is
 * recorded into `owner_chat_model_spend` (period-keyed) and both surfaces fall
 * back to the local Qwen agent once the COMBINED spend crosses the cap for the
 * period. The fuse auto-resets each billing period (spend is keyed by the Stripe
 * period start).
 *
 * Spend RECORDING moved to the per-tenant llm-router sidecar (the only component
 * that sees Gemini's exact `usage`), which POSTs billed tokens to
 * /api/internal/meter-gemini-spend. This module now only provides the cap READ
 * + turn-routing decision (`resolveSmsChatCap`, `pickSmsTurn`) plus the pricing
 * table shared with the platform meter. The pure functions are unit-tested; the
 * IO helpers take a minimal structural Supabase client so they can be stubbed
 * without importing the supabase-js types (same approach as
 * _shared/telemetry.ts's RpcSupabase).
 */

import { deriveMonthlyQuotaWindow } from "./billing_period_window.ts";

// Per-model Google list prices (USD per 1M tokens, standard tier). Unknown
// models fall back to the priciest tier we deploy so the fuse never
// undercounts. Mirrors src/lib/billing/ai-spend-meter.ts on the Next side.
// gemini-3.1-flash is the voice `voice_task` text model, now metered into the
// SAME shared AI budget as chat/SMS. This TEXT-rate table is used by the SMS/
// AiFlow cap read + the AiFlow worker's own cost calc; the audio-native Live
// model (gemini-3.1-flash-live-preview) is priced modality-aware in
// ai-spend-meter.ts (the only place that sees its audio token split), so its
// entry here is a defensive text-rate floor only.
export const GEMINI_PRICES_PER_1M: Record<string, { in: number; out: number }> = {
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-3-flash": { in: 0.5, out: 3.0 },
  "gemini-3-flash-preview": { in: 0.5, out: 3.0 },
  "gemini-3.1-flash": { in: 0.5, out: 3.0 },
  "gemini-3.1-flash-live-preview": { in: 0.5, out: 3.0 }
};
export const DEFAULT_GEMINI_PRICE_PER_1M = { in: 0.5, out: 3.0 };

// Tier-derived shared spend cap. Starter gets a lower included AI budget ($5)
// than Standard/Enterprise ($10). Kept as a pure helper so the SMS worker (and
// its unit test) and the platform/VPS mirrors all trip the shared fuse at the
// same total. Must stay in lockstep with src/lib/db/chat-usage.ts
// (chatSpendBaseCapMicrosForTier) and vps/chat-worker/worker.mjs.
export const STARTER_CHAT_SPEND_CAP_MICROS = 5_000_000; // $5
export const DEFAULT_CHAT_SPEND_CAP_MICROS = 10_000_000; // $10

export function capMicrosForTier(
  tier: string | null | undefined,
  baseCapMicros: number,
  starterCapMicros: number = STARTER_CHAT_SPEND_CAP_MICROS
): number {
  return tier === "starter" ? starterCapMicros : baseCapMicros;
}

/**
 * Exact cost (micro-USD) from billed token counts (`usageMetadata`).
 * `outputTokens` must already include thinking tokens — Google bills them at
 * the output rate. Negative inputs clamp to 0.
 */
export function geminiCostMicrosFromTokens(
  model: string,
  promptTokens: number,
  outputTokens: number
): number {
  const price = GEMINI_PRICES_PER_1M[model.trim()] ?? DEFAULT_GEMINI_PRICE_PER_1M;
  return Math.ceil(
    Math.max(0, promptTokens) * price.in + Math.max(0, outputTokens) * price.out
  );
}

export type SmsTurnPlan = {
  /** Agent to enter for this turn (null → omit startAgent, use workflow default). */
  startAgent: string | null;
  /** Force a stateless Rowboat call (drop conversationId/state) so startAgent is honored. */
  stateless: boolean;
  /** Whether this turn should be metered (Gemini turns yes, local $0 turns no). */
  meter: boolean;
};

/**
 * Decide how to run this SMS turn given the cap decision.
 *
 * Under cap: resume normally on the Gemini-backed agent. Continued threads are
 * already bound to it (and new threads default to it), so we keep the call
 * STATEFUL (caller passes the stored conversationId) and meter the turn.
 *
 * Over cap: Rowboat IGNORES `startAgent` whenever a conversationId is supplied —
 * it resumes the agent the thread was first bound to — so the only way to switch
 * an existing thread to the local agent is to drop the continuation. We force a
 * STATELESS turn on the local agent; it is $0 (not metered) and intentionally
 * degraded (relies on the customer preamble for context). This is a rare safety
 * state, and we deliberately do NOT persist the local turn's conversationId so
 * the thread resumes on Gemini once the period resets.
 */
export function pickSmsTurn(opts: {
  overCap: boolean;
  geminiAgent: string | null;
  localAgent: string | null;
}): SmsTurnPlan {
  if (opts.overCap && opts.localAgent) {
    return { startAgent: opts.localAgent, stateless: true, meter: false };
  }
  return { startAgent: opts.geminiAgent || null, stateless: false, meter: true };
}

/** Start of the current UTC month, ISO — fallback period key when no subscription. */
export function monthStartIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// --- IO helpers (minimal structural Supabase client; see telemetry.ts) -------

type DbResult = { data: unknown; error: { message: string } | null };

// Mirrors supabase-js's two-stage builder: `from()` exposes the table verbs
// (select/update), and only the result of those exposes the row filters. Modeling
// it this way (rather than a single flat QueryBuilder) lets the real
// PostgrestQueryBuilder satisfy this interface structurally — it has no
// eq/is/order directly on the from() result either.
interface FilterBuilder extends PromiseLike<DbResult> {
  eq(col: string, val: unknown): FilterBuilder;
  is(col: string, val: unknown): FilterBuilder;
  order(col: string, opts: { ascending: boolean }): FilterBuilder;
  limit(n: number): FilterBuilder;
  maybeSingle(): PromiseLike<DbResult>;
}

interface QueryBuilder {
  select(cols?: string): FilterBuilder;
  update(values: Record<string, unknown>): FilterBuilder;
}

export interface SpendSupabase {
  from(table: string): QueryBuilder;
  // PromiseLike (not Promise) so supabase-js's thenable PostgrestFilterBuilder
  // satisfies the interface structurally (same approach as _shared/cap_alerts.ts).
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<DbResult>;
}

/**
 * Billing-period key for chat spend: the current MONTH-window within the
 * subscription's Stripe period, so the fuse resets monthly even on prepaid
 * 12/24-month plans (whose Stripe period spans the whole term). For monthly
 * subs the window equals the period, so existing tenants' keys are unchanged.
 * Falls back to the start of the current UTC month when there's no
 * subscription row. Never throws.
 */
export async function resolveChatPeriodStart(
  supabase: SpendSupabase,
  businessId: string
): Promise<string> {
  try {
    const { data } = await supabase
      .from("subscriptions")
      .select("stripe_current_period_start")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const row = data as { stripe_current_period_start?: string } | null;
    if (row?.stripe_current_period_start) {
      return deriveMonthlyQuotaWindow(row.stripe_current_period_start, Date.now()).startIso;
    }
  } catch {
    // fall through to month-start
  }
  return monthStartIso();
}

/** Combined chat spend (micro-USD) for this tenant + period. Throws on hard read error. */
export async function readChatSpendMicros(
  supabase: SpendSupabase,
  businessId: string,
  periodStart: string
): Promise<number> {
  const { data, error } = await supabase
    .from("owner_chat_model_spend")
    .select("spend_micros")
    .eq("business_id", businessId)
    .eq("period_start", periodStart)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as { spend_micros?: number | string } | null;
  return Number(row?.spend_micros ?? 0);
}

/**
 * Purchased spend credit currently active for this business (micro-USD).
 * Comes from `chat_spend_credit_grants` via the `chat_active_credit_micros`
 * RPC; credit RAISES the period cap (base + credits) rather than being
 * consumed per turn. Returns 0 on any failure — the base cap still applies,
 * so a read blip can never mint free headroom.
 */
export async function readActiveChatCreditMicros(
  supabase: SpendSupabase,
  businessId: string
): Promise<number> {
  try {
    const { data, error } = await supabase.rpc("chat_active_credit_micros", {
      p_business_id: businessId
    });
    if (error) return 0;
    const n = Number(data ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export type CapDecision = {
  periodStart: string | null;
  overCap: boolean;
  /** Base cap + active purchased credit; what the meter should trip against. */
  effectiveCapMicros: number;
};

/**
 * Resolve the cap decision for the SMS turn about to run. Never throws — on any
 * read failure it fails OPEN (overCap=false → Gemini), and returns the period it
 * resolved so post-turn metering can reuse it without a second subscription read.
 * The cap compared against is `base cap + active purchased credit`
 * (chat_spend_credit_grants), so a Gemini pack purchase immediately restores
 * cloud-model replies.
 */
export async function resolveSmsChatCap(
  supabase: SpendSupabase,
  businessId: string,
  opts: { capMicros: number; enabled: boolean }
): Promise<CapDecision> {
  if (!opts.enabled) {
    return { periodStart: null, overCap: false, effectiveCapMicros: opts.capMicros };
  }
  try {
    const periodStart = await resolveChatPeriodStart(supabase, businessId);
    const spent = await readChatSpendMicros(supabase, businessId, periodStart);
    const credits = await readActiveChatCreditMicros(supabase, businessId);
    const effectiveCapMicros = opts.capMicros + credits;
    return { periodStart, overCap: spent >= effectiveCapMicros, effectiveCapMicros };
  } catch {
    return { periodStart: null, overCap: false, effectiveCapMicros: opts.capMicros };
  }
}

// NOTE: SMS spend is no longer metered in this module. Exact billed tokens for
// every Gemini turn (owner chat / SMS / summarizers) are recorded by the
// llm-router sidecar → /api/internal/meter-gemini-spend → owner_chat_model_spend,
// and the cap-tripped owner alert fires there too (via _shared/cap_alerts.ts).
// This module now only provides the cap READ (resolveSmsChatCap) the SMS worker
// uses to route Gemini→local once the shared period cap is hit.
