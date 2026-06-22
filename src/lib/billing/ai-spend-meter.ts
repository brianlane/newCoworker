/**
 * Meter platform-side (Next.js) Gemini calls into the shared AI budget.
 *
 * Background: the "AI chat budget" the billing page shows is the
 * `owner_chat_model_spend` pool. The workers meter chat turns, SMS replies,
 * and AiFlow extraction — but the platform's own Gemini calls (AiFlow
 * compile, website ingest, knowledge lookups) were never metered, and they
 * run on pricier models than the flash-lite chat path. The dashboard said
 * $0.01 while Google billed $0.07 — this module closes that gap.
 *
 * Cost is computed from the response's billed token counts when available
 * (exact — includes thinking tokens), falling back to a chars/4 estimate.
 * Prices are per-model Google list prices; unknown models use the priciest
 * tier we deploy so the fuse never undercounts.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { chatSpendBaseCapMicrosForTier } from "@/lib/db/chat-usage";
import type { PlanTier } from "@/lib/plans/tier";
import type { GeminiUsage } from "@/lib/gemini-generate-content";
import { sendCapAlertOnce } from "../../../supabase/functions/_shared/cap_alerts";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type GeminiPricePer1M = { in: number; out: number };

/** USD per 1M tokens, Google list prices (standard interactive tier). */
export const GEMINI_PRICES_PER_1M: Record<string, GeminiPricePer1M> = {
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-3-flash": { in: 0.5, out: 3.0 },
  "gemini-3-flash-preview": { in: 0.5, out: 3.0 },
  // Voice-path models (Rowboat voice_task / Gemini Live). Their spend is billed
  // as voice minutes and the llm-router EXCLUDES them from the chat budget, so
  // these entries are purely defensive: if a stray non-voice 3.1 call ever
  // reaches this meter it prices in the flash tier instead of the priciest
  // default. Same flash-tier rate as gemini-3-flash.
  "gemini-3.1-flash": { in: 0.5, out: 3.0 },
  "gemini-3.1-flash-live-preview": { in: 0.5, out: 3.0 },
  // Gemini 3.5 Flash (GA May 2026). Output price includes thinking tokens, so
  // a medium/high reasoning compile is billed entirely at this rate.
  "gemini-3.5-flash": { in: 1.5, out: 9.0 }
};

/** Unknown model → assume the priciest tier we deploy (never undercount a fuse). */
export const DEFAULT_GEMINI_PRICE_PER_1M: GeminiPricePer1M = { in: 1.5, out: 9.0 };

export function geminiPriceFor(model: string): GeminiPricePer1M {
  return GEMINI_PRICES_PER_1M[model.trim()] ?? DEFAULT_GEMINI_PRICE_PER_1M;
}

/** Exact cost (micro-USD) from billed token counts. */
export function geminiCostMicrosFromUsage(model: string, usage: GeminiUsage): number {
  const price = geminiPriceFor(model);
  return Math.ceil(
    Math.max(0, usage.promptTokens) * price.in + Math.max(0, usage.outputTokens) * price.out
  );
}

/**
 * Fallback estimate (micro-USD) from raw text lengths, tokens ~ chars/4.
 * The per-1M price and the 1e6 micros-per-USD factor cancel.
 */
export function estimateGeminiCostMicrosFromChars(
  model: string,
  inputChars: number,
  outputChars: number
): number {
  const price = geminiPriceFor(model);
  return Math.ceil(
    (Math.max(0, inputChars) / 4) * price.in + (Math.max(0, outputChars) / 4) * price.out
  );
}

function monthStartIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export type MeterGeminiSpendArgs = {
  businessId: string;
  /** Short model id the call actually ran on. */
  model: string;
  /** Telemetry label, e.g. "aiflow_compile" | "website_ingest" | "knowledge_lookup". */
  surface: string;
  /** Billed token counts when the response carried usageMetadata. */
  usage?: GeminiUsage | null;
  /** Fallback estimate inputs when usage is unavailable. */
  inputChars?: number;
  outputChars?: number;
  client?: SupabaseClient;
};

/**
 * Record one platform Gemini call into `owner_chat_model_spend` (same pool +
 * RPC the workers use, so the fuse and the billing page see ONE number).
 * Best-effort and never throws: the model call already happened, so a
 * metering failure may only under-count the fuse, never break the feature.
 */
export async function meterGeminiSpendForBusiness(args: MeterGeminiSpendArgs): Promise<void> {
  try {
    const db = args.client ?? (await createSupabaseServiceClient());
    const costMicros = args.usage
      ? geminiCostMicrosFromUsage(args.model, args.usage)
      : estimateGeminiCostMicrosFromChars(
          args.model,
          args.inputChars ?? 0,
          args.outputChars ?? 0
        );
    if (costMicros <= 0) return;

    let periodStart = monthStartIso();
    const { data: subRow } = await db
      .from("subscriptions")
      .select("stripe_current_period_start")
      .eq("business_id", args.businessId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const subStart = (subRow as { stripe_current_period_start?: string | null } | null)
      ?.stripe_current_period_start;
    if (subStart) periodStart = subStart;

    // Trip the fuse against the tenant's tier cap ($5 starter / $10 otherwise)
    // so this platform-side meter agrees with the chat-worker and SMS surfaces.
    const { data: bizRow } = await db
      .from("businesses")
      .select("tier")
      .eq("id", args.businessId)
      .maybeSingle();
    const tier = (bizRow as { tier?: PlanTier | null } | null)?.tier ?? null;

    let creditMicros = 0;
    const { data: creditRaw, error: creditErr } = await db.rpc("chat_active_credit_micros", {
      p_business_id: args.businessId
    });
    if (!creditErr) {
      const n = Number(creditRaw ?? 0);
      if (Number.isFinite(n) && n > 0) creditMicros = n;
    }

    const { data, error } = await db.rpc("owner_chat_record_spend", {
      p_business_id: args.businessId,
      p_period_start: periodStart,
      p_cost_micros: costMicros,
      p_cap_micros: chatSpendBaseCapMicrosForTier(tier) + creditMicros
    });
    if (error) throw new Error(error.message);

    // First crossing of the shared period cap → one urgent owner alert. This is
    // the SAME shared fuse the chat-worker (owner chat) and SMS worker route
    // against; the alert used to fire from those workers' estimate-writes, but
    // metering is now centralized here, so the alert is too. `mark_usage_cap_alert`
    // dedupes once-per-period (keyed by the subscription period start), so every
    // surface that meters can call this and the owner still hears about it once.
    const row = (Array.isArray(data) ? data[0] : data) as
      | { fuse_newly_tripped?: boolean; spend_micros?: number | string }
      | null
      | undefined;
    if (row?.fuse_newly_tripped) {
      await sendCapAlertOnce(db, {
        businessId: args.businessId,
        kind: "chat_spend",
        periodKey: periodStart,
        notifyUrl: `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/functions/v1/notifications`,
        bearer: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
        payload: { surface: args.surface, spend_micros: Number(row.spend_micros) || null }
      });
    }
  } catch (err) {
    console.error(
      `meterGeminiSpendForBusiness(${args.surface})`,
      err instanceof Error ? err.message : err
    );
  }
}
