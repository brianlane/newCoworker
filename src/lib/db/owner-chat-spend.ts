/**
 * Owner-dashboard chat spend cap ("runaway fuse") — read/decide side.
 *
 * PR #104 routed the OwnerCoworker agent to Gemini for latency. Gemini bills
 * per token, so we meter per-business spend per billing period and, once a
 * business crosses {@link OWNER_CHAT_SPEND_CAP_MICROS} for the period, route
 * owner chat to the LOCAL Qwen agent ({@link OWNER_CHAT_AGENT_LOCAL}) instead
 * of the Gemini one ({@link OWNER_CHAT_AGENT_GEMINI}). The fuse auto-resets at
 * the next billing period (spend is keyed by stripe_current_period_start).
 *
 * This module is the *decision* half (read spend, pick the agent); the VPS
 * chat-worker is the *metering* half (estimate per-turn cost, call
 * owner_chat_record_spend). See:
 *   - supabase/migrations/20260604000000_owner_chat_spend_cap.sql
 *   - vps/chat-worker/worker.mjs (recordOwnerChatSpend)
 *
 * Access is service-role only; callers MUST gate on requireOwner() first.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** $10/period, expressed in micro-USD (1 USD = 1_000_000). */
export const OWNER_CHAT_SPEND_CAP_MICROS = 10_000_000;

/** Gemini-backed owner-chat agent (normal path). */
export const OWNER_CHAT_AGENT_GEMINI = "OwnerCoworker";
/** Local Qwen owner-chat agent (fallback once the period cap is reached). */
export const OWNER_CHAT_AGENT_LOCAL = "OwnerCoworkerLocal";

/**
 * Resolve the billing-period key for a business's owner-chat spend: the
 * subscription's current Stripe period start. Falls back to the start of the
 * current UTC calendar month when there's no subscription row (e.g. a tenant
 * still in trial/manual state) so metering still resets monthly and never
 * silently shares one unbounded bucket.
 */
export async function getOwnerChatPeriodStart(
  businessId: string,
  client?: SupabaseClient
): Promise<string> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: sub } = await db
    .from("subscriptions")
    .select("stripe_current_period_start")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const periodStart = sub?.stripe_current_period_start as string | undefined;
  if (periodStart) return periodStart;
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * Current period spend (micro-USD) for a business. 0 when no row exists yet
 * (fresh period / first turn).
 */
export async function getOwnerChatSpendMicros(
  businessId: string,
  periodStart: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data } = await db
    .from("owner_chat_model_spend")
    .select("spend_micros")
    .eq("business_id", businessId)
    .eq("period_start", periodStart)
    .maybeSingle();
  return Number(data?.spend_micros ?? 0);
}

/**
 * Decide which owner-chat agent the worker should start for the next turn.
 * Returns the local Qwen agent once the period spend is at/over the cap,
 * else the Gemini agent. Never throws — on any read error it FAILS OPEN to
 * Gemini (the quality path); the worker still meters and will trip the fuse on
 * the next turn once spend is readable again.
 */
export async function chooseOwnerChatStartAgent(
  businessId: string,
  client?: SupabaseClient
): Promise<{ startAgent: string; capReached: boolean; spendMicros: number; periodStart: string }> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const periodStart = await getOwnerChatPeriodStart(businessId, db);
    const spendMicros = await getOwnerChatSpendMicros(businessId, periodStart, db);
    const capReached = spendMicros >= OWNER_CHAT_SPEND_CAP_MICROS;
    return {
      startAgent: capReached ? OWNER_CHAT_AGENT_LOCAL : OWNER_CHAT_AGENT_GEMINI,
      capReached,
      spendMicros,
      periodStart
    };
  } catch {
    return {
      startAgent: OWNER_CHAT_AGENT_GEMINI,
      capReached: false,
      spendMicros: 0,
      periodStart: ""
    };
  }
}
