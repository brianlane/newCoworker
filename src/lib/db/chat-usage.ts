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

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export const DEFAULT_CHAT_SPEND_CAP_MICROS = 10_000_000; // $10

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

function monthStartIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export async function getChatSpendSnapshotForBusiness(
  businessId: string,
  client?: SupabaseClient
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

  const baseCapMicros = chatSpendBaseCapMicros();
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
