/**
 * Cross-channel contact interaction timeline.
 *
 * One merged, capped, oldest-first view of everything the platform recently
 * exchanged with ONE contact, regardless of channel or author:
 *
 *   - inbound SMS (sms_inbound_jobs payload text — INCLUDING rows a flow
 *     consumed/suppressed, which carry no assistant_reply_text and were
 *     invisible to the older sms_transcript loader),
 *   - outbound SMS (sms_outbound_log, ALL sources: AI replies, AiFlow
 *     sends, scheduled),
 *   - voice calls (voice_call_transcripts.summary when the call summarizer
 *     has run; a placeholder line when it hasn't).
 *
 * Why: the 2026-07-14 Truly incident class. Mid-conversation, the
 * cross-channel rollup (contacts.summary_md) is EMPTY — the summarize
 * sweep hasn't run yet — exactly when a freshly-rooted model turn needs to
 * know what was just said. The rollup stays the long-term memory; this
 * timeline covers the recent window raw.
 *
 * Consumers:
 *   - sms-inbound-worker: injected into the system preamble on FRESH
 *     Rowboat threads (a continued thread already holds its own SMS
 *     history server-side — re-sending it every turn would bloat and
 *     contradict it; voice/flow context on continued threads flows through
 *     customer_lookup_by_phone below).
 *   - customer_lookup_by_phone (src/lib/customer-tools/handlers.ts): the
 *     tool every agent surface (SMS, voice, dashboard) is instructed to
 *     call — `recentInteractions` gives ANY surface the cross-channel
 *     window on demand.
 *
 * Formatting is pure and unit-tested; the loader is a thin best-effort IO
 * wrapper — a context failure must never break a reply path. Same module
 * conventions as ai_flows/run_context.ts (importable from Deno edge AND
 * the Next runtime).
 */
import { inboundSmsBody } from "./telnyx_sms_compliance.ts";

/** How far back an interaction still counts as recent context. */
export const CONTACT_TIMELINE_LOOKBACK_HOURS = 72;

/** Most timeline lines included (newest kept when over). */
export const TIMELINE_MAX_EVENTS = 14;

/** Per-line excerpt cap — keeps one chatty message from dominating. */
export const TIMELINE_MAX_LINE_CHARS = 260;

export type ContactTimelineEvent = {
  /** ISO timestamp used for merge ordering (and shown day-precision). */
  at: string;
  channel: "sms_in" | "sms_out" | "voice";
  text: string;
};

function clip(s: string): string {
  const trimmed = s.trim().replace(/\s+/g, " ");
  return trimmed.length <= TIMELINE_MAX_LINE_CHARS
    ? trimmed
    : `${trimmed.slice(0, TIMELINE_MAX_LINE_CHARS - 1)}…`;
}

function labelFor(event: ContactTimelineEvent): string {
  switch (event.channel) {
    case "sms_in":
      return "Contact (SMS)";
    case "sms_out":
      return "Business (SMS)";
    case "voice":
      return "Phone call";
  }
}

/**
 * Render the merged timeline (any input order) into a prompt block. Null
 * when there is nothing to say. Events are sorted by timestamp, capped to
 * the NEWEST TIMELINE_MAX_EVENTS, and rendered oldest-first.
 */
export function formatContactTimeline(events: ContactTimelineEvent[]): string | null {
  const usable = events
    .filter((e) => e.text.trim().length > 0 && e.at)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-TIMELINE_MAX_EVENTS);
  if (usable.length === 0) return null;
  const lines = usable.map((e) => `- [${labelFor(e)}] ${clip(e.text)}`);
  return [
    "Recent interactions with this contact across ALL channels (oldest " +
      "first; SMS lines are verbatim, phone calls are summaries). This has " +
      "already happened, treat it as the live conversation state: never " +
      "re-ask anything answered below, never repeat a line the business " +
      "already sent, and read a short new message as a continuation of it.",
    ...lines
  ].join("\n");
}

// Minimal structural client (the _shared convention): only the query shapes
// this module uses, so both the edge runtime client and test fakes fit.
// deno-lint-ignore no-explicit-any
type AnyClient = any;

type InboundJobRow = {
  created_at: string | null;
  payload: Record<string, unknown> | null;
};

type OutboundLogRow = {
  created_at: string | null;
  body: string | null;
};

type VoiceCallRow = {
  started_at: string | null;
  created_at: string | null;
  direction: string | null;
  summary: string | null;
  status: string | null;
};

/** Inbound text from a stored job envelope ({ data: { payload } }). */
function jobInboundText(payload: Record<string, unknown> | null): string {
  const envelope = payload as { data?: { payload?: Record<string, unknown> } } | null;
  const inner = envelope?.data?.payload;
  return inner ? inboundSmsBody(inner) : "";
}

/** Cap on numbers queried per contact (primary + merged-away aliases). */
export const TIMELINE_MAX_NUMBERS = 6;

/**
 * Every number this contact's history may live under: the queried number
 * plus the profile's surviving primary and merged-away aliases
 * (merge_customer_memories moves the PROFILE, not the per-number message
 * logs — so a merged contact's SMS/call rows stay keyed on the old
 * number). Best-effort: on any failure the queried number alone is used.
 */
async function resolveContactNumbers(
  supabase: AnyClient,
  businessId: string,
  contactE164: string
): Promise<string[]> {
  const numbers = [contactE164];
  try {
    const { data, error } = await supabase
      .from("contacts")
      .select("customer_e164, alias_e164s")
      .eq("business_id", businessId)
      .or(`customer_e164.eq.${contactE164},alias_e164s.cs.{${contactE164}}`)
      .maybeSingle();
    if (error) {
      console.error("contact_context: contact resolve", error);
      return numbers;
    }
    const row = data as { customer_e164?: string | null; alias_e164s?: string[] | null } | null;
    if (row?.customer_e164) numbers.push(row.customer_e164);
    for (const alias of row?.alias_e164s ?? []) {
      if (typeof alias === "string" && alias) numbers.push(alias);
    }
  } catch (e) {
    console.error("contact_context: contact resolve", e);
  }
  return [...new Set(numbers)].slice(0, TIMELINE_MAX_NUMBERS);
}

/**
 * Load + format the merged timeline for one contact. Best-effort: any
 * failure returns null and the caller proceeds without it. Per-source
 * failures degrade to that source missing (never the whole block).
 *
 * @param excludeInboundJobId the job being processed right now, when called
 *   from the SMS worker — its inbound line is already the current user
 *   message and must not appear twice.
 */
export async function loadContactTimeline(
  supabase: AnyClient,
  businessId: string,
  contactE164: string,
  opts: { excludeInboundJobId?: string } = {}
): Promise<string | null> {
  if (!contactE164) return null;
  try {
    const sinceIso = new Date(
      Date.now() - CONTACT_TIMELINE_LOOKBACK_HOURS * 3_600_000
    ).toISOString();
    // Merged-alias awareness: a contact whose old number was merged into
    // another profile keeps its message/call rows keyed on the OLD number,
    // so the timeline must query every number the profile spans (Bugbot on
    // PR #608 — the surfaced number alone missed the primary's history).
    const numbers = await resolveContactNumbers(supabase, businessId, contactE164);
    const events: ContactTimelineEvent[] = [];

    // Inbound SMS — every stored job for this contact, including rows an
    // AiFlow consumed (suppress_reply) whose text never got an AI reply.
    let inboundQuery = supabase
      .from("sms_inbound_jobs")
      .select("created_at, payload")
      .eq("business_id", businessId)
      .in("customer_e164", numbers)
      // Owner-soft-deleted messages must not feed AI context.
      .is("deleted_at", null)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(TIMELINE_MAX_EVENTS);
    if (opts.excludeInboundJobId) {
      inboundQuery = inboundQuery.neq("id", opts.excludeInboundJobId);
    }
    const inbound = await inboundQuery;
    if (inbound.error) {
      console.error("contact_context: inbound lookup", inbound.error);
    } else {
      for (const row of (inbound.data ?? []) as InboundJobRow[]) {
        events.push({
          at: row.created_at ?? "",
          channel: "sms_in",
          text: jobInboundText(row.payload)
        });
      }
    }

    // Outbound SMS — every source (AI reply, AiFlow send, scheduled): the
    // contact experienced them all as one thread.
    const outbound = await supabase
      .from("sms_outbound_log")
      .select("created_at, body")
      .eq("business_id", businessId)
      .in("to_e164", numbers)
      .is("deleted_at", null)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(TIMELINE_MAX_EVENTS);
    if (outbound.error) {
      console.error("contact_context: outbound lookup", outbound.error);
    } else {
      for (const row of (outbound.data ?? []) as OutboundLogRow[]) {
        events.push({
          at: row.created_at ?? "",
          channel: "sms_out",
          text: row.body ?? ""
        });
      }
    }

    // Voice — the call summarizer's one-paragraph summaries; a call that
    // ended but isn't summarized yet still shows up as a placeholder so the
    // model knows a conversation happened.
    const calls = await supabase
      .from("voice_call_transcripts")
      .select("started_at, created_at, direction, summary, status")
      .eq("business_id", businessId)
      .in("caller_e164", numbers)
      .is("deleted_at", null)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(3);
    if (calls.error) {
      console.error("contact_context: voice lookup", calls.error);
    } else {
      for (const row of (calls.data ?? []) as VoiceCallRow[]) {
        const when = row.started_at ?? row.created_at ?? "";
        const dir = row.direction === "outbound" ? "outbound call" : "inbound call";
        const summary = row.summary?.trim();
        events.push({
          at: when,
          channel: "voice",
          text: summary
            ? `(${dir}) ${summary}`
            : `(${dir}) call took place; summary not available yet`
        });
      }
    }

    return formatContactTimeline(events);
  } catch (e) {
    console.error("loadContactTimeline", e);
    return null;
  }
}
