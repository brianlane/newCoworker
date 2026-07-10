/**
 * Read-only Gemini (chat-model) spend snapshot for the billing page.
 *
 * The actual cap enforcement lives in the workers (`_shared/chat_spend_cap.ts`
 * and `vps/chat-worker/worker.mjs`); this mirrors their reads — period keyed by
 * the subscription's Stripe period start (UTC month start fallback), spend from
 * `owner_chat_model_spend`, purchased credit via the `chat_active_credit_micros`
 * RPC — purely for display. Base cap mirrors the workers' env contract
 * (`OWNER_CHAT_SPEND_CAP_MICROS`, default $10).
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { PlanTier } from "@/lib/plans/tier";
import { deriveMonthlyQuotaWindow } from "../../../supabase/functions/_shared/billing_period_window";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export const DEFAULT_CHAT_SPEND_CAP_MICROS = 10_000_000; // $10 (standard / enterprise)
export const STARTER_CHAT_SPEND_CAP_MICROS = 5_000_000; // $5

export type ChatSpendSnapshot = {
  periodStart: string;
  spendMicros: number;
  baseCapMicros: number;
  creditMicros: number;
  /** baseCapMicros + creditMicros — what the workers trip the fuse against. */
  effectiveCapMicros: number;
};

export function chatSpendBaseCapMicros(
  env: Record<string, string | undefined> = process.env
): number {
  const n = Number(env.OWNER_CHAT_SPEND_CAP_MICROS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CHAT_SPEND_CAP_MICROS;
}

/**
 * Tier-derived base cap. Starter gets a lower included AI budget ($5) than
 * Standard/Enterprise ($10). Each side has an optional env override
 * (`OWNER_CHAT_SPEND_CAP_MICROS_STARTER` / `OWNER_CHAT_SPEND_CAP_MICROS`) so ops
 * can tune without a code change. Must stay in lockstep with the Edge
 * (`_shared/chat_spend_cap.ts`) and VPS worker (`vps/chat-worker/worker.mjs`)
 * mappings so every surface trips the shared fuse at the same total.
 */
export function chatSpendBaseCapMicrosForTier(
  tier: PlanTier | null | undefined,
  env: Record<string, string | undefined> = process.env
): number {
  if (tier === "starter") {
    const n = Number(env.OWNER_CHAT_SPEND_CAP_MICROS_STARTER);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : STARTER_CHAT_SPEND_CAP_MICROS;
  }
  return chatSpendBaseCapMicros(env);
}

function monthStartIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export async function getChatSpendSnapshotForBusiness(
  businessId: string,
  client?: SupabaseClient,
  // The caller passes the tenant tier so the displayed cap matches what the fuse
  // enforces ($5 starter / $10 otherwise). Omitted/null → standard base cap.
  tier?: PlanTier | null
): Promise<ChatSpendSnapshot> {
  const db = client ?? (await createSupabaseServiceClient());

  let periodStart = monthStartIso();
  const { data: subRow } = await db
    .from("subscriptions")
    .select("stripe_current_period_start")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const subStart = (subRow as { stripe_current_period_start?: string | null } | null)
    ?.stripe_current_period_start;
  // Month-window key within the Stripe period (see _shared/billing_period_window):
  // matches the workers' resolveChatPeriodStart so display and enforcement agree.
  if (subStart) periodStart = deriveMonthlyQuotaWindow(subStart, Date.now()).startIso;

  let spendMicros = 0;
  const { data: spendRow } = await db
    .from("owner_chat_model_spend")
    .select("spend_micros")
    .eq("business_id", businessId)
    .eq("period_start", periodStart)
    .maybeSingle();
  const rawSpend = (spendRow as { spend_micros?: number | string } | null)?.spend_micros;
  const spendNum = Number(rawSpend ?? 0);
  if (Number.isFinite(spendNum) && spendNum > 0) spendMicros = spendNum;

  let creditMicros = 0;
  const { data: creditRaw, error: creditErr } = await db.rpc("chat_active_credit_micros", {
    p_business_id: businessId
  });
  if (!creditErr) {
    const n = Number(creditRaw ?? 0);
    if (Number.isFinite(n) && n > 0) creditMicros = n;
  }

  const baseCapMicros = chatSpendBaseCapMicrosForTier(tier);
  return {
    periodStart,
    spendMicros,
    baseCapMicros,
    creditMicros,
    effectiveCapMicros: baseCapMicros + creditMicros
  };
}

/** UTC month shift that mirrors the spend window's one-month length. */
function shiftUtcMonths(ms: number, months: number): number {
  const d = new Date(ms);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth() + months,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds()
  );
}

/**
 * FLEET-WIDE Gemini spend (micro-USD) across every tenant's CURRENT period
 * row (admin dashboard platform-cost estimate). A spend row's window is one
 * month from its `period_start` (see deriveMonthlyQuotaWindow), so the sum
 * takes each business's NEWEST started row and counts it only while its
 * window still covers `now` — summing every row in a rolling one-month
 * lookback would double-count a tenant right after a window rollover. The
 * two-month fetch lookback is a safe superset of any window that can cover
 * `now`. Best effort: 0 on error — the dashboard must render even if the
 * rollup read fails.
 */
export async function getFleetCurrentAiSpendMicros(
  client?: SupabaseClient,
  now: Date = new Date()
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const nowMs = now.getTime();
  const lookbackIso = new Date(shiftUtcMonths(nowMs, -2)).toISOString();
  const { data, error } = await db
    .from("owner_chat_model_spend")
    .select("business_id, period_start, spend_micros")
    .gt("period_start", lookbackIso)
    .lte("period_start", now.toISOString());
  if (error) {
    console.error("getFleetCurrentAiSpendMicros", error.message);
    return 0;
  }

  const newestByBusiness = new Map<string, { startMs: number; spendMicros: number }>();
  for (const row of data ?? []) {
    const r = row as {
      business_id?: string;
      period_start?: string;
      spend_micros?: number | string;
    };
    const startMs = Date.parse(r.period_start ?? "");
    if (!r.business_id || !Number.isFinite(startMs)) continue;
    const prev = newestByBusiness.get(r.business_id);
    if (prev && prev.startMs >= startMs) continue;
    const n = Number(r.spend_micros ?? 0);
    newestByBusiness.set(r.business_id, {
      startMs,
      spendMicros: Number.isFinite(n) && n > 0 ? n : 0
    });
  }

  let total = 0;
  for (const { startMs, spendMicros } of newestByBusiness.values()) {
    if (shiftUtcMonths(startMs, 1) > nowMs) total += spendMicros;
  }
  return total;
}

/** Unexpired, unvoided bonus texts remaining across all SMS grants. 0 on error. */
export async function getSmsBonusTextsRemaining(
  businessId: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.rpc("sms_bonus_texts_remaining", {
    p_business_id: businessId
  });
  if (error) {
    console.error("getSmsBonusTextsRemaining", error.message);
    return 0;
  }
  const n = Number(data ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
