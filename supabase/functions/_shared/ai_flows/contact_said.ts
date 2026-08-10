/**
 * What the LEAD themselves has already said, rendered for a teammate.
 *
 * The gap this closes, seen on 2026-08-07: a Clever seller told the AI on the
 * phone to email comparables and talk on Monday. The offer Dave received said
 * `The call: spoke with them`. Nothing anywhere in the offer, claim, courtesy,
 * or fallback path carried a single word the lead actually said, so the person
 * deciding whether to take the lead, and the person who took it, both had to
 * open the dashboard to learn what had been promised on their behalf.
 *
 * Deliberately NOT `contact_context.ts`. That module is the model-facing
 * cross-channel timeline: it includes our own outbound messages (a model needs
 * to know what it already sent) and its voice arm reads
 * `voice_call_transcripts.summary`, which is tier-gated and written by a
 * five-minute sweep, so it is empty exactly when a just-finished call matters
 * most. A teammate needs the opposite: only the OTHER side, verbatim, and
 * available the moment the call ends. That means reading
 * `voice_call_transcript_turns` where `role = 'caller'`, which the VPS bridge
 * writes live, turn by turn.
 *
 * Formatting is pure and unit-tested; the loader is best-effort IO, because a
 * history lookup failing must never stop a lead from being offered.
 */
import { inboundSmsBody } from "../telnyx_sms_compliance.ts";
import { resolveContactNumbers } from "../contact_context.ts";

/** How far back the lead's own words still count as context. */
export const SAID_LOOKBACK_HOURS = 72;

/** Calls whose caller turns are read. Newest first. */
export const SAID_MAX_CALLS = 3;

/**
 * Caller turns kept per call. A lead's ask almost always lands in their last
 * few turns ("shoot me an email, then we can talk Monday"), while the opening
 * turns are greeting noise.
 */
export const SAID_MAX_TURNS_PER_CALL = 3;

export type SaidEvent = {
  /** ISO timestamp, for merge ordering. */
  at: string;
  channel: "text" | "call";
  /** The lead's own words. */
  text: string;
};

/** Collapse whitespace and cut to `max`, marking the cut. */
export function clipSaid(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Words in a turn, for the pleasantry test below. Empty text counts zero. */
function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * The caller turns worth repeating to a teammate.
 *
 * Two rules, both learned from the Aug 7 transcript ("Not really." / "What are
 * we going to talk about?" / "...shoot me an email then we can talk on
 * Monday." / "Thank you."):
 *
 *   - drop two-word pleasantries when the call contains anything longer, so
 *     "Thank you." never displaces the actual ask;
 *   - keep the LAST turns, because a lead states what they want at the end of
 *     a call, after the pitch.
 *
 * When every turn is short (a lead who only ever said "yeah, sure"), nothing
 * is dropped: short answers are all the call produced, and hiding them would
 * make a real call look silent.
 */
export function pickCallerHighlights(turns: readonly string[], maxTurns: number): string[] {
  const cleaned = turns.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleaned.length === 0) return [];
  const substantive = cleaned.filter((t) => wordCount(t) > 2);
  const pool = substantive.length > 0 ? substantive : cleaned;
  return pool.slice(-maxTurns);
}

/** "Aug 7" in the business's eyes; day precision is enough for a teammate. */
function shortDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  });
}

export type FormatSaidOptions = {
  /** Lead's display name, for the heading. Falls back to "this lead". */
  leadLabel?: string;
  /** Lines kept (newest). */
  maxItems: number;
  /** Per-line character cap. */
  maxLineChars: number;
};

/**
 * Render the lead's own words as a compact block, or null when they have said
 * nothing we hold. Newest LAST, so the block reads in conversation order and
 * ends on the most recent thing they said, which is usually the ask.
 */
export function formatContactSaid(
  events: readonly SaidEvent[],
  opts: FormatSaidOptions
): string | null {
  const usable = events
    .filter((e) => e.text.trim().length > 0 && e.at)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-opts.maxItems);
  if (usable.length === 0) return null;
  const who = opts.leadLabel?.trim() || "this lead";
  const lines = usable.map((e) => {
    const when = shortDate(e.at);
    const tag = when ? `${e.channel}, ${when}` : e.channel;
    return `- (${tag}) "${clipSaid(e.text, opts.maxLineChars)}"`;
  });
  return [`What ${who} has said so far:`, ...lines].join("\n");
}

// Minimal structural client, the _shared convention.
// deno-lint-ignore no-explicit-any
type AnyClient = any;

/**
 * Load the lead's own words across text and phone. Best-effort throughout: a
 * failing source degrades to that source missing, and a total failure returns
 * an empty list so the offer still goes out.
 */
export async function loadContactSaid(
  supabase: AnyClient,
  businessId: string,
  contactE164: string
): Promise<SaidEvent[]> {
  if (!contactE164) return [];
  const events: SaidEvent[] = [];
  try {
    const sinceIso = new Date(Date.now() - SAID_LOOKBACK_HOURS * 3_600_000).toISOString();
    // Merged contacts keep their message and call rows under the old number,
    // so query every number the profile spans (same reasoning as the
    // cross-channel timeline).
    const numbers = await resolveContactNumbers(supabase, businessId, contactE164);

    // Their texts. Inbound only: a teammate does not need to be told what we
    // already sent, and every extra line is a billed SMS segment.
    const inbound = await supabase
      .from("sms_inbound_jobs")
      .select("created_at, payload")
      .eq("business_id", businessId)
      .in("customer_e164", numbers)
      // Owner-soft-deleted messages must not resurface anywhere.
      .is("deleted_at", null)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(10);
    if (inbound.error) {
      console.error("contact_said: inbound sms", inbound.error);
    } else {
      for (const row of (inbound.data ?? []) as Array<{
        created_at: string | null;
        payload: Record<string, unknown> | null;
      }>) {
        const envelope = row.payload as { data?: { payload?: Record<string, unknown> } } | null;
        const inner = envelope?.data?.payload;
        const text = inner ? inboundSmsBody(inner) : "";
        if (text.trim()) events.push({ at: row.created_at ?? "", channel: "text", text });
      }
    }

    // Their side of recent calls, read from the live turn rows rather than the
    // sweep-written summary so a call that just ended is already usable.
    const calls = await supabase
      .from("voice_call_transcripts")
      .select("id, started_at")
      .eq("business_id", businessId)
      .in("caller_e164", numbers)
      .is("deleted_at", null)
      .gte("started_at", sinceIso)
      .order("started_at", { ascending: false })
      .limit(SAID_MAX_CALLS);
    if (calls.error) {
      console.error("contact_said: calls", calls.error);
    } else {
      const rows = (calls.data ?? []) as Array<{ id: string; started_at: string | null }>;
      for (const call of rows) {
        const turns = await supabase
          .from("voice_call_transcript_turns")
          .select("content, turn_index")
          .eq("transcript_id", call.id)
          .eq("role", "caller")
          .order("turn_index", { ascending: true })
          .limit(200);
        if (turns.error) {
          console.error("contact_said: turns", turns.error);
          continue;
        }
        const contents = ((turns.data ?? []) as Array<{ content: string | null }>)
          .map((t) => t.content ?? "")
          .filter((t) => t.trim().length > 0);
        const highlights = pickCallerHighlights(contents, SAID_MAX_TURNS_PER_CALL);
        if (highlights.length > 0) {
          events.push({
            at: call.started_at ?? "",
            channel: "call",
            text: highlights.join(" ")
          });
        }
      }
    }
  } catch (e) {
    console.error("contact_said: load", e);
  }
  return events;
}

/** Lines shown on an OFFER: brief, it only has to inform a yes or no. */
export const SAID_OFFER_MAX_ITEMS = 2;
export const SAID_OFFER_MAX_LINE_CHARS = 160;

/** Lines shown to whoever CLAIMED it: fuller, they have to act on it. */
export const SAID_CLAIM_MAX_ITEMS = 4;
export const SAID_CLAIM_MAX_LINE_CHARS = 240;
