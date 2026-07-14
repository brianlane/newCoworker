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
import { deriveMonthlyQuotaWindow } from "../../../supabase/functions/_shared/billing_period_window";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * Per-1M-token prices. `in`/`out` are the TEXT rates. `audioIn`/`audioOut` are
 * the modality-specific AUDIO rates for native-audio models (Gemini Live): the
 * caller's speech in and the assistant's speech out are billed per audio token
 * at these higher rates, while the small text remainder (system instruction,
 * coordinator cues, tool JSON) stays on `in`/`out`. Omit the audio fields for
 * text-only models — everything then prices at `in`/`out`.
 */
export type GeminiPricePer1M = { in: number; out: number; audioIn?: number; audioOut?: number };

/** USD per 1M tokens, Google list prices (standard interactive tier). */
export const GEMINI_PRICES_PER_1M: Record<string, GeminiPricePer1M> = {
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-3-flash": { in: 0.5, out: 3.0 },
  "gemini-3-flash-preview": { in: 0.5, out: 3.0 },
  // SMS Coworker default since the 2026-07-14 Truly context-blindness
  // incident (GA May 2026; $0.25/$1.50 Google list).
  "gemini-3.1-flash-lite": { in: 0.25, out: 1.5 },
  // Voice `voice_task` model (Rowboat text turns through the llm-router). Now
  // metered into the shared AI budget like every other gemini-* text call.
  "gemini-3.1-flash": { in: 0.5, out: 3.0 },
  // Gemini Live (native audio-to-audio) — the voice-bridge holds this session
  // and meters it from the exact usageMetadata it sees. Priced modality-aware:
  // text in $0.75 / out $4.50, audio in $3.00 / out $12.00 per 1M tokens
  // (audio ≈ 25 tokens/sec). Nearly all of a call's tokens are audio.
  "gemini-3.1-flash-live-preview": { in: 0.75, out: 4.5, audioIn: 3.0, audioOut: 12.0 },
  // Gemini 3.5 Flash (GA May 2026). Output price includes thinking tokens, so
  // a medium/high reasoning compile is billed entirely at this rate.
  "gemini-3.5-flash": { in: 1.5, out: 9.0 }
};

/** Unknown model → assume the priciest tier we deploy (never undercount a fuse). */
export const DEFAULT_GEMINI_PRICE_PER_1M: GeminiPricePer1M = { in: 1.5, out: 9.0 };

export function geminiPriceFor(model: string): GeminiPricePer1M {
  return GEMINI_PRICES_PER_1M[model.trim()] ?? DEFAULT_GEMINI_PRICE_PER_1M;
}

/**
 * Exact cost (micro-USD) from billed token counts, modality-aware.
 *
 * When `usage` carries an audio split (Gemini Live), the audio portion of the
 * prompt/output tokens is priced at the model's audio rate and the remaining
 * (text) portion at the text rate. For text-only surfaces the audio fields are
 * absent/0 and everything prices at `in`/`out` — identical to the old math.
 * Audio counts are clamped to their respective totals so a malformed payload
 * can never over- or under-count.
 *
 * IMPORTANT: for a native-audio model (one that defines `audioIn`/`audioOut`,
 * i.e. Gemini Live) the tokens are overwhelmingly AUDIO. If a call reports token
 * totals but NO audio split (the modality detail rows were missing or labeled
 * differently), pricing the full counts at the cheaper TEXT rate would ~4x
 * under-record spend and weaken the shared AI-budget hard stop. So for those
 * models we treat the untagged remainder as audio (the dominant, pricier
 * modality) rather than text — conservative, never undercounts. When Gemini DID
 * report a positive audio split we honor it exactly (audio at audio rate, the
 * genuine text remainder at text rate).
 */
export function geminiCostMicrosFromUsage(model: string, usage: GeminiUsage): number {
  const price = geminiPriceFor(model);
  const promptTokens = Math.max(0, usage.promptTokens);
  const outputTokens = Math.max(0, usage.outputTokens);
  const isAudioModel = price.audioIn !== undefined || price.audioOut !== undefined;
  let promptAudio = Math.min(promptTokens, Math.max(0, usage.promptAudioTokens ?? 0));
  let outputAudio = Math.min(outputTokens, Math.max(0, usage.outputAudioTokens ?? 0));
  if (isAudioModel) {
    if (promptAudio === 0) promptAudio = promptTokens;
    if (outputAudio === 0) outputAudio = outputTokens;
  }
  const promptText = promptTokens - promptAudio;
  const outputText = outputTokens - outputAudio;
  const audioIn = price.audioIn ?? price.in;
  const audioOut = price.audioOut ?? price.out;
  return Math.ceil(
    promptText * price.in +
      promptAudio * audioIn +
      outputText * price.out +
      outputAudio * audioOut
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
  /**
   * Flat cost (micro-USD) that bypasses token math entirely. Image models
   * bill per generated image, not per text token — the token-rate tables
   * above would badly misprice them, so image surfaces pass the per-image
   * list price here.
   */
  costMicrosOverride?: number;
  /**
   * When set (live-voice teardown), SETTLE this call's AI-budget reservation
   * instead of a plain increment: `owner_chat_ai_settle` releases the hold the
   * inbound gate placed AND records the exact spend atomically. A zero cost still
   * releases the hold (unlike the plain path, which skips zero-cost writes).
   */
  callControlId?: string;
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
    const costMicros =
      args.costMicrosOverride !== undefined
        ? Math.max(0, Math.ceil(args.costMicrosOverride))
        : args.usage
          ? geminiCostMicrosFromUsage(args.model, args.usage)
          : estimateGeminiCostMicrosFromChars(
              args.model,
              args.inputChars ?? 0,
              args.outputChars ?? 0
            );
    const isSettle = typeof args.callControlId === "string" && args.callControlId.length > 0;
    // Plain path skips zero-cost writes; a settle must still run to release the
    // reservation the inbound gate placed even when the call cost nothing.
    if (costMicros <= 0 && !isSettle) return;

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
    // Month-window key within the Stripe period (see _shared/billing_period_window):
    // must agree with the workers' resolveChatPeriodStart so all surfaces meter
    // into the same monthly pool on prepaid multi-month plans.
    if (subStart) periodStart = deriveMonthlyQuotaWindow(subStart, Date.now()).startIso;

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

    const capMicros = chatSpendBaseCapMicrosForTier(tier) + creditMicros;
    const { data, error } = isSettle
      ? await db.rpc("owner_chat_ai_settle", {
          p_business_id: args.businessId,
          p_period_start: periodStart,
          p_call_control_id: args.callControlId,
          p_actual_micros: costMicros,
          p_cap_micros: capMicros
        })
      : await db.rpc("owner_chat_record_spend", {
          p_business_id: args.businessId,
          p_period_start: periodStart,
          p_cost_micros: costMicros,
          p_cap_micros: capMicros
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
