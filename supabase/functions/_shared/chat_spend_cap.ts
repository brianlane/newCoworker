/**
 * Shared chat-model spend cap helpers for the SMS inbound worker.
 *
 * Background: inbound SMS replies now run on Gemini (the workflow `Coworker`
 * agent was repointed off local Qwen), so SMS bills per token. The owner picked
 * a single SHARED monthly pool across owner-dashboard chat + SMS: both surfaces
 * meter estimated per-turn cost into `owner_chat_model_spend` (period-keyed) and
 * fall back to the local Qwen agent once the COMBINED spend crosses the cap for
 * the period. The fuse auto-resets each billing period (spend is keyed by the
 * Stripe period start).
 *
 * This mirrors the owner chat-worker fuse (vps/chat-worker/worker.mjs) but in
 * the Deno/Edge runtime where the SMS path lives. The pure functions
 * (`estimateChatCostMicros`, `pickSmsTurn`, `monthStartIso`) are unit-tested;
 * the IO helpers take a minimal structural Supabase client so they can be
 * stubbed without importing the supabase-js types (same approach as
 * _shared/telemetry.ts's RpcSupabase).
 */

// Gemini 2.5 Flash-Lite list price, USD per 1M tokens (matches the owner
// chat-worker constants in vps/chat-worker/worker.mjs).
export const DEFAULT_CHAT_PRICE_IN_PER_1M = 0.1;
export const DEFAULT_CHAT_PRICE_OUT_PER_1M = 0.4;

// Per-model Google list prices (USD per 1M tokens, standard tier). Unknown
// models fall back to the priciest tier we deploy so the fuse never
// undercounts. Mirrors src/lib/billing/ai-spend-meter.ts on the Next side.
export const GEMINI_PRICES_PER_1M: Record<string, { in: number; out: number }> = {
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-3-flash": { in: 0.5, out: 3.0 },
  "gemini-3-flash-preview": { in: 0.5, out: 3.0 }
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
// Flat token overhead added to the text-only estimate. Rowboat prepends the
// agent instructions (synced memory + persona) AND — because SMS turns resume a
// stateful thread — the server-side conversation history, none of which is in
// the worker's input text. A safety fuse may under-count without this; it is a
// fuse, not an invoice, so an approximate flat add is fine. Tunable per surface.
export const DEFAULT_SMS_PROMPT_OVERHEAD_TOKENS = 1200;

export type ChatCostConfig = {
  priceInPer1M?: number;
  priceOutPer1M?: number;
  promptOverheadTokens?: number;
};

/**
 * Estimate the Gemini cost (micro-USD) of one chat turn from raw text lengths.
 * tokens ~ chars/4; cost_micros = inTokens*priceIn + outTokens*priceOut because
 * price is per-1M-tokens and 1 USD = 1e6 micros (the 1e6 factors cancel).
 * Negative inputs are clamped to 0.
 */
export function estimateChatCostMicros(
  inputChars: number,
  outputChars: number,
  cfg: ChatCostConfig = {}
): number {
  const priceIn = cfg.priceInPer1M ?? DEFAULT_CHAT_PRICE_IN_PER_1M;
  const priceOut = cfg.priceOutPer1M ?? DEFAULT_CHAT_PRICE_OUT_PER_1M;
  const overhead = cfg.promptOverheadTokens ?? DEFAULT_SMS_PROMPT_OVERHEAD_TOKENS;
  const inTokens = Math.max(0, inputChars) / 4 + Math.max(0, overhead);
  const outTokens = Math.max(0, outputChars) / 4;
  return Math.ceil(inTokens * priceIn + outTokens * priceOut);
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

interface QueryBuilder extends PromiseLike<DbResult> {
  select(cols?: string): QueryBuilder;
  update(values: Record<string, unknown>): QueryBuilder;
  eq(col: string, val: unknown): QueryBuilder;
  is(col: string, val: unknown): QueryBuilder;
  order(col: string, opts: { ascending: boolean }): QueryBuilder;
  limit(n: number): QueryBuilder;
  maybeSingle(): Promise<DbResult>;
}

export interface SpendSupabase {
  from(table: string): QueryBuilder;
  rpc(fn: string, args: Record<string, unknown>): Promise<DbResult>;
}

/**
 * Billing-period key for chat spend: the subscription's current Stripe period
 * start, so the fuse resets each month. Falls back to the start of the current
 * UTC month when there's no subscription row. Never throws.
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
    if (row?.stripe_current_period_start) return row.stripe_current_period_start;
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

export type MeterResult = {
  metered: boolean;
  reason?: "disabled" | "already_metered" | "claim_failed" | "rpc_failed";
  costMicros?: number;
  spendMicros?: number;
  fuseNewlyTripped?: boolean;
  error?: string;
};

/**
 * Record estimated SMS Gemini spend for one turn into the shared meter and trip
 * the period fuse on first cap crossing. Exactly-once: atomically claims
 * `sms_inbound_jobs.metered_at` (WHERE metered_at IS NULL) before the RPC, so a
 * retried/reclaimed run (e.g. a cached-reply re-send) never double-counts. If the
 * RPC fails after the claim, the claim is released so a later retry can re-meter.
 * NEVER throws — metering must never fail a turn whose reply already went out.
 */
export async function recordSmsChatSpend(
  supabase: SpendSupabase,
  args: {
    jobId: string;
    businessId: string;
    periodStart: string | null;
    inputChars: number;
    outputChars: number;
    capMicros: number;
    enabled: boolean;
    costConfig?: ChatCostConfig;
  }
): Promise<MeterResult> {
  if (!args.enabled) return { metered: false, reason: "disabled" };

  const claimRes = await supabase
    .from("sms_inbound_jobs")
    .update({ metered_at: new Date().toISOString() })
    .eq("id", args.jobId)
    .is("metered_at", null)
    .select("id");
  if (claimRes.error) {
    return { metered: false, reason: "claim_failed", error: claimRes.error.message };
  }
  const claimed = Array.isArray(claimRes.data) ? claimRes.data : [];
  if (claimed.length === 0) {
    // Already metered by an earlier (retried/reclaimed) run.
    return { metered: false, reason: "already_metered" };
  }

  const ps = args.periodStart ?? (await resolveChatPeriodStart(supabase, args.businessId));
  const costMicros = estimateChatCostMicros(args.inputChars, args.outputChars, args.costConfig);
  // Trip the fuse against the EFFECTIVE cap (base + purchased credit) so a
  // Gemini pack purchase moves the trip point along with the routing check.
  const credits = await readActiveChatCreditMicros(supabase, args.businessId);
  const { data, error } = await supabase.rpc("owner_chat_record_spend", {
    p_business_id: args.businessId,
    p_period_start: ps,
    p_cost_micros: costMicros,
    p_cap_micros: args.capMicros + credits
  });
  if (error) {
    // Release the claim so a reclaim can retry metering this turn's spend.
    await supabase
      .from("sms_inbound_jobs")
      .update({ metered_at: null })
      .eq("id", args.jobId);
    return { metered: false, reason: "rpc_failed", costMicros, error: error.message };
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { spend_micros?: number | string; fuse_newly_tripped?: boolean }
    | null
    | undefined;
  return {
    metered: true,
    costMicros,
    spendMicros: Number(row?.spend_micros ?? 0),
    fuseNewlyTripped: Boolean(row?.fuse_newly_tripped)
  };
}
