/**
 * AI call summary + sentiment generator (Standard/Enterprise perk).
 *
 * Runs one Gemini Flash JSON call over a completed voice transcript and
 * persists `summary` / `sentiment` / `summarized_at` on the
 * `voice_call_transcripts` row. Spend is metered into the tenant's shared AI
 * budget via meterGeminiSpendForBusiness (surface "call_summary"), same pool
 * the billing page shows.
 *
 * Call chain:
 *   pg_cron → Edge `call-summary-sweep` (scan + tier filter)
 *           → /api/internal/summarize-call (this module)
 *
 * Terminal-vs-retry contract (the sweep re-dispatches rows whose
 * `summarized_at` is NULL and `summary_attempts` is under its cap):
 *   - success            → summary/sentiment set, summarized_at set (terminal)
 *   - empty transcript   → summarized_at set, summary stays NULL (terminal —
 *                          nothing will ever appear in an empty call)
 *   - transient failure  → summary_attempts += 1, summary_error set; row
 *                          retries until the sweep's attempt cap
 *   - tier/not-found/... → skipped without touching the row
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  GeminiEmptyError,
  geminiGenerateTextDetailed
} from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { callSummariesAllowedForTier } from "@/lib/plans/call-summaries";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Default model; override with GEMINI_CALL_SUMMARY_MODEL. */
export const CALL_SUMMARY_DEFAULT_MODEL = "gemini-3-flash-preview";

/** Hard cap on persisted summary text. */
export const CALL_SUMMARY_MAX_CHARS = 600;

/**
 * Prompt budget for transcript text. When a call runs over, we keep the
 * opening (why they called) and the tail (how it resolved) and elide the
 * middle — both ends matter more to a digest than mid-call back-and-forth.
 */
export const CALL_SUMMARY_MAX_TRANSCRIPT_CHARS = 24_000;

export const CALL_SENTIMENTS = ["positive", "neutral", "negative", "mixed"] as const;
export type CallSentiment = (typeof CALL_SENTIMENTS)[number];

const SYSTEM_INSTRUCTION = `You summarize one phone call between a small business's AI phone assistant and a caller.

Return STRICT JSON: {"summary": string, "sentiment": "positive"|"neutral"|"negative"|"mixed"}.

summary: 1-3 plain sentences (max ~${CALL_SUMMARY_MAX_CHARS} characters) a busy owner can skim: who called (if stated), what they wanted, what was resolved or promised, and any follow-up still owed. No preamble, no speculation beyond the transcript.

sentiment: the CALLER's overall mood — "positive" (satisfied/friendly), "negative" (frustrated/upset), "mixed" (shifted during the call), otherwise "neutral".`;

export type CallSummaryFailureReason =
  | "not_found"
  | "not_completed"
  | "already_summarized"
  | "tier"
  | "empty_transcript"
  | "no_api_key"
  | "gemini_failed"
  | "bad_json"
  | "db_failed";

export type CallSummaryResult =
  | { ok: true; summary: string; sentiment: CallSentiment | null; turnCount: number }
  | { ok: false; reason: CallSummaryFailureReason; detail?: string };

export type CallSummaryDeps = {
  client?: SupabaseClient;
  generate?: typeof geminiGenerateTextDetailed;
  meter?: typeof meterGeminiSpendForBusiness;
};

/** Head+tail elision so both the reason for the call and its resolution survive. */
export function clampTranscriptText(text: string, maxChars = CALL_SUMMARY_MAX_TRANSCRIPT_CHARS): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars / 3);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n[... middle of call omitted ...]\n${text.slice(text.length - tail)}`;
}

/**
 * Gemini JSON mode is reliable but not infallible — tolerate code fences and
 * surrounding prose, then validate the shape ourselves.
 */
export function parseCallSummaryJson(
  raw: string
): { summary: string; sentiment: CallSentiment | null } | null {
  const stripped = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  const summary = (parsed as { summary?: unknown })?.summary;
  if (typeof summary !== "string" || summary.trim().length === 0) return null;
  const sentimentRaw = (parsed as { sentiment?: unknown })?.sentiment;
  const sentiment = CALL_SENTIMENTS.includes(sentimentRaw as CallSentiment)
    ? (sentimentRaw as CallSentiment)
    : null;
  return { summary: summary.trim().slice(0, CALL_SUMMARY_MAX_CHARS), sentiment };
}

export async function summarizeCallTranscript(
  businessId: string,
  transcriptId: string,
  deps: CallSummaryDeps = {}
): Promise<CallSummaryResult> {
  const db = deps.client ?? (await createSupabaseServiceClient());
  const generate = deps.generate ?? geminiGenerateTextDetailed;
  const meter = deps.meter ?? meterGeminiSpendForBusiness;

  const { data: rowData, error: rowErr } = await db
    .from("voice_call_transcripts")
    .select("id, business_id, status, summarized_at, summary_attempts")
    .eq("business_id", businessId)
    .eq("id", transcriptId)
    .maybeSingle();
  if (rowErr) return { ok: false, reason: "db_failed", detail: rowErr.message };
  const row = rowData as {
    id: string;
    status: string;
    summarized_at: string | null;
    summary_attempts: number;
  } | null;
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "completed") return { ok: false, reason: "not_completed" };
  if (row.summarized_at) return { ok: false, reason: "already_summarized" };

  // Re-check tier at generation time: the sweep filters too, but a downgrade
  // can land between scan and dispatch — never spend AI budget on a tenant
  // whose plan no longer includes the perk.
  const { data: bizData, error: bizErr } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (bizErr) return { ok: false, reason: "db_failed", detail: bizErr.message };
  if (!callSummariesAllowedForTier((bizData as { tier?: string | null } | null)?.tier)) {
    return { ok: false, reason: "tier" };
  }

  // Transient-failure bookkeeping shared by every retryable exit below.
  const recordAttempt = async (detail: string): Promise<void> => {
    const { error } = await db
      .from("voice_call_transcripts")
      .update({
        summary_attempts: row.summary_attempts + 1,
        summary_error: detail.slice(0, 500)
      })
      .eq("id", transcriptId);
    if (error) {
      logger.warn("call-summary: attempt bookkeeping failed", {
        transcriptId,
        error: error.message
      });
    }
  };

  const { data: turnsData, error: turnsErr } = await db
    .from("voice_call_transcript_turns")
    .select("role, content")
    .eq("transcript_id", transcriptId)
    .order("turn_index", { ascending: true });
  if (turnsErr) return { ok: false, reason: "db_failed", detail: turnsErr.message };
  const turns = (turnsData as Array<{ role: string; content: string }> | null) ?? [];
  const transcriptText = turns
    .map((t) => `${t.role === "caller" ? "Caller" : "Assistant"}: ${t.content}`)
    .join("\n")
    .trim();

  if (transcriptText.length === 0) {
    // Terminal skip: an empty call will never grow content. Mark it so the
    // sweep stops re-dispatching the row.
    const { error } = await db
      .from("voice_call_transcripts")
      .update({ summarized_at: new Date().toISOString(), summary_error: "empty_transcript" })
      .eq("id", transcriptId);
    if (error) return { ok: false, reason: "db_failed", detail: error.message };
    return { ok: false, reason: "empty_transcript" };
  }

  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) {
    await recordAttempt("no_api_key");
    return { ok: false, reason: "no_api_key" };
  }
  const configured = process.env.GEMINI_CALL_SUMMARY_MODEL?.trim();
  const model = configured?.length ? configured : CALL_SUMMARY_DEFAULT_MODEL;
  const userText = `Call transcript:\n${clampTranscriptText(transcriptText)}`;
  const inputChars = SYSTEM_INSTRUCTION.length + userText.length;

  let text: string;
  let usage: Awaited<ReturnType<typeof geminiGenerateTextDetailed>>["usage"] = null;
  try {
    const res = await generate({
      apiKey,
      model,
      systemInstruction: SYSTEM_INSTRUCTION,
      userText,
      temperature: 0.2,
      maxOutputTokens: 800,
      responseMimeType: "application/json",
      thinkingLevel: "low"
    });
    text = res.text;
    usage = res.usage;
  } catch (err) {
    // Empty replies (thinking-only output) are still billed — meter them
    // before recording the retryable failure.
    if (err instanceof GeminiEmptyError) {
      await meter({
        businessId,
        model,
        surface: "call_summary",
        usage: err.usage,
        inputChars,
        outputChars: 0,
        client: db
      });
    }
    const detail = err instanceof Error ? err.message : String(err);
    await recordAttempt(detail);
    return { ok: false, reason: "gemini_failed", detail };
  }

  await meter({
    businessId,
    model,
    surface: "call_summary",
    usage,
    inputChars,
    outputChars: text.length,
    client: db
  });

  const parsed = parseCallSummaryJson(text);
  if (!parsed) {
    await recordAttempt("bad_json");
    return { ok: false, reason: "bad_json" };
  }

  const { error: writeErr } = await db
    .from("voice_call_transcripts")
    .update({
      summary: parsed.summary,
      sentiment: parsed.sentiment,
      summarized_at: new Date().toISOString(),
      summary_error: null
    })
    .eq("id", transcriptId);
  if (writeErr) {
    // The Gemini call already happened; leave the row retryable so the sweep
    // re-runs it (double-metering one cheap flash call beats a silent hole).
    await recordAttempt(`persist:${writeErr.message}`);
    return { ok: false, reason: "db_failed", detail: writeErr.message };
  }

  return { ok: true, summary: parsed.summary, sentiment: parsed.sentiment, turnCount: turns.length };
}
