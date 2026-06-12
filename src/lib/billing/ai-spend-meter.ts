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
import { chatSpendBaseCapMicros } from "@/lib/db/chat-usage";
import type { GeminiUsage } from "@/lib/gemini-generate-content";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type GeminiPricePer1M = { in: number; out: number };

/** USD per 1M tokens, Google list prices (standard interactive tier). */
export const GEMINI_PRICES_PER_1M: Record<string, GeminiPricePer1M> = {
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-3-flash": { in: 0.5, out: 3.0 },
  "gemini-3-flash-preview": { in: 0.5, out: 3.0 }
};

/** Unknown model → assume the priciest tier we deploy (never undercount a fuse). */
export const DEFAULT_GEMINI_PRICE_PER_1M: GeminiPricePer1M = { in: 0.5, out: 3.0 };

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

    let creditMicros = 0;
    const { data: creditRaw, error: creditErr } = await db.rpc("chat_active_credit_micros", {
      p_business_id: args.businessId
    });
    if (!creditErr) {
      const n = Number(creditRaw ?? 0);
      if (Number.isFinite(n) && n > 0) creditMicros = n;
    }

    const { error } = await db.rpc("owner_chat_record_spend", {
      p_business_id: args.businessId,
      p_period_start: periodStart,
      p_cost_micros: costMicros,
      p_cap_micros: chatSpendBaseCapMicros() + creditMicros
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error(
      `meterGeminiSpendForBusiness(${args.surface})`,
      err instanceof Error ? err.message : err
    );
  }
}
