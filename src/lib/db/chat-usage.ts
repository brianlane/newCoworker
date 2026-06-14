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
  tier?: PlanTier | null
): Promise<ChatSpendSnapshot> {
  const db = client ?? (await createSupabaseServiceClient());

  // Resolve tier when the caller didn't supply it, so the displayed cap matches
  // what the fuse enforces ($5 starter / $10 otherwise). A read blip falls back
  // to the standard base cap.
  let resolvedTier: PlanTier | null | undefined = tier;
  if (resolvedTier === undefined) {
    const { data: bizRow } = await db
      .from("businesses")
      .select("tier")
      .eq("id", businessId)
      .maybeSingle();
    resolvedTier = (bizRow as { tier?: PlanTier | null } | null)?.tier ?? null;
  }

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
  if (subStart) periodStart = subStart;

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

  const baseCapMicros = chatSpendBaseCapMicrosForTier(resolvedTier);
  return {
    periodStart,
    spendMicros,
    baseCapMicros,
    creditMicros,
    effectiveCapMicros: baseCapMicros + creditMicros
  };
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
