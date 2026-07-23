/**
 * Compact recent-SMS-thread transcript for the stateless Rowboat retry.
 *
 * When callSmsRowboatWithStatelessFallback drops a continuation, Rowboat
 * roots a brand-new conversation that knows only the current inbound line —
 * production showed the model restarting lead intake mid-thread ("what
 * prompted you to shop around?", Truly Insurance 2026-07-13). The worker
 * reconstructs the recent exchange from completed sms_inbound_jobs (the
 * durable inbound text + assistant_reply_text pairs) and passes it as
 * `statelessContextExtra`, so even a reset turn continues the thread.
 *
 * Formatting is pure and unit-tested; the loader is a thin best-effort IO
 * wrapper — a transcript failure must never break the reply path.
 */
import { inboundSmsBody } from "./telnyx_sms_compliance.ts";

/** Most recent exchanges included (each = one inbound + its reply). */
export const TRANSCRIPT_MAX_EXCHANGES = 6;

/** Per-line excerpt cap — keeps a chatty thread from dominating the prompt. */
export const TRANSCRIPT_MAX_LINE_CHARS = 300;

export type SmsExchange = {
  inbound: string;
  reply: string | null;
};

function clip(s: string): string {
  const trimmed = s.trim();
  return trimmed.length <= TRANSCRIPT_MAX_LINE_CHARS
    ? trimmed
    : `${trimmed.slice(0, TRANSCRIPT_MAX_LINE_CHARS - 1)}…`;
}

/**
 * Render exchanges (oldest first) into the prompt block. Null when there is
 * nothing worth saying — the retry then behaves exactly as before this fix.
 */
export function formatSmsTranscript(exchanges: SmsExchange[]): string | null {
  const lines: string[] = [];
  for (const ex of exchanges.slice(-TRANSCRIPT_MAX_EXCHANGES)) {
    const inbound = ex.inbound.trim();
    const reply = ex.reply?.trim();
    if (inbound) lines.push(`Texter: ${clip(inbound)}`);
    if (reply) lines.push(`You: ${clip(reply)}`);
  }
  if (lines.length === 0) return null;
  return [
    "Recent SMS conversation with this texter (oldest first). This has " +
      "ALREADY been said, continue from it. Do not greet or introduce " +
      "yourself again, do not re-ask anything already asked or answered " +
      "below, and never repeat a line you already sent.",
    ...lines
  ].join("\n");
}

// Minimal structural client (the _shared convention): only the query shapes
// this module uses, so both the edge runtime client and test fakes fit.
// deno-lint-ignore no-explicit-any
type AnyClient = any;

type JobHistoryRow = {
  payload: Record<string, unknown> | null;
  assistant_reply_text: string | null;
};

/** Inbound text from a stored job envelope ({ data: { payload } }). */
function jobInboundText(payload: Record<string, unknown> | null): string {
  const envelope = payload as { data?: { payload?: Record<string, unknown> } } | null;
  const inner = envelope?.data?.payload;
  return inner ? inboundSmsBody(inner) : "";
}

/**
 * Load + format the recent thread for one contact, excluding the job being
 * processed (its inbound line is already the current user message).
 * Best-effort: any failure returns null and the retry proceeds bare.
 */
export async function loadRecentSmsTranscript(
  supabase: AnyClient,
  businessId: string,
  customerE164: string,
  excludeJobId: string
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("sms_inbound_jobs")
      .select("payload, assistant_reply_text")
      .eq("business_id", businessId)
      .eq("customer_e164", customerE164)
      .eq("status", "done")
      .neq("id", excludeJobId)
      .order("created_at", { ascending: false })
      .limit(TRANSCRIPT_MAX_EXCHANGES);
    if (error) {
      console.error("sms_transcript: history lookup", error);
      return null;
    }
    const rows = (data ?? []) as JobHistoryRow[];
    // Query is newest-first for the LIMIT; the prompt reads oldest-first.
    const exchanges: SmsExchange[] = rows
      .reverse()
      .map((row) => ({
        inbound: jobInboundText(row.payload),
        reply: row.assistant_reply_text
      }));
    return formatSmsTranscript(exchanges);
  } catch (e) {
    console.error("loadRecentSmsTranscript", e);
    return null;
  }
}
