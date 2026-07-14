/**
 * Cross-channel contact timeline → voice-bridge mirror. Mirrors
 * `supabase/functions/_shared/contact_context.ts` (the bridge is rsynced to
 * the VPS standalone, so it can't import across the repo) — the DATA rules
 * (query predicates, lookback, caps, merge/order) must stay identical to
 * the shared module; only the surrounding wording is voice-specific.
 * tests/voice-bridge-contact-context.test.ts pins the two implementations
 * against each other so a one-sided edit is loud.
 *
 * Why this exists: a lead who was just texting the business may CALL
 * instead of texting back. Mid-first-conversation the rolling summary
 * (contacts.summary_md) is still empty — the summarize sweep runs later —
 * so without this the receptionist knew nothing about an SMS exchange from
 * minutes ago (the voice twin of the 2026-07-14 Truly SMS incident).
 *
 * Kept dependency-free in its own module so repo-root tests and typecheck
 * can import it without the bridge's VPS-only runtime deps.
 */

/** How far back an interaction still counts as recent context. */
export const CONTACT_TIMELINE_LOOKBACK_HOURS = 72;

/** Most timeline lines included (newest kept when over). */
export const TIMELINE_MAX_EVENTS = 14;

/** Per-line excerpt cap — keeps one chatty message from dominating. */
export const TIMELINE_MAX_LINE_CHARS = 260;

export type ContactTimelineEvent = {
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
      return "Caller (SMS)";
    case "sms_out":
      return "Business (SMS)";
    case "voice":
      return "Phone call";
  }
}

/**
 * Render the merged timeline (any input order) into a prompt block. Null
 * when there is nothing to say. Sort/cap/clip rules are pinned against the
 * shared module by the parity test; only the header wording is
 * voice-specific.
 */
export function formatVoiceContactTimeline(events: ContactTimelineEvent[]): string | null {
  const usable = events
    .filter((e) => e.text.trim().length > 0 && e.at)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-TIMELINE_MAX_EVENTS);
  if (usable.length === 0) return null;
  const lines = usable.map((e) => `- [${labelFor(e)}] ${clip(e.text)}`);
  return [
    "Recent interactions with this caller across ALL channels (oldest " +
      "first; SMS lines are verbatim, phone calls are summaries). This has " +
      "already happened — treat it as the live conversation state: never " +
      "re-ask anything answered below, never repeat something the business " +
      "already sent them, and expect the call to continue that thread.",
    ...lines
  ].join("\n");
}

// Minimal structural client, mirroring the shared module's shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

/**
 * Inbound text from a stored job envelope ({ data: { payload } }) — a
 * dependency-free vendored copy of telnyx_sms_compliance.inboundSmsBody
 * (text / body string / RCS body object), pinned by the parity test.
 */
export function voiceJobInboundText(payload: Record<string, unknown> | null): string {
  const envelope = payload as { data?: { payload?: Record<string, unknown> } } | null;
  const inner = envelope?.data?.payload;
  if (!inner) return "";
  const t = inner["text"];
  if (typeof t === "string") return t;
  const body = inner["body"];
  if (typeof body === "string") return body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    if (typeof b["text"] === "string") return b["text"] as string;
    const suggestion = b["suggestion_response"];
    if (suggestion && typeof suggestion === "object" && !Array.isArray(suggestion)) {
      const s = suggestion as Record<string, unknown>;
      if (typeof s["text"] === "string") return s["text"] as string;
    }
  }
  return "";
}

/**
 * Load + format the merged timeline for one caller. Best-effort: any
 * failure returns null and the call proceeds without it; per-source
 * failures degrade to that source missing.
 */
export async function loadVoiceContactTimeline(
  supabase: AnyClient,
  businessId: string,
  contactE164: string
): Promise<string | null> {
  if (!contactE164) return null;
  try {
    const sinceIso = new Date(
      Date.now() - CONTACT_TIMELINE_LOOKBACK_HOURS * 3_600_000
    ).toISOString();
    const events: ContactTimelineEvent[] = [];

    const inbound = await supabase
      .from("sms_inbound_jobs")
      .select("created_at, payload")
      .eq("business_id", businessId)
      .eq("customer_e164", contactE164)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(TIMELINE_MAX_EVENTS);
    if (inbound.error) {
      console.error("contact-context: inbound lookup", inbound.error);
    } else {
      for (const row of (inbound.data ?? []) as InboundJobRow[]) {
        events.push({
          at: row.created_at ?? "",
          channel: "sms_in",
          text: voiceJobInboundText(row.payload)
        });
      }
    }

    const outbound = await supabase
      .from("sms_outbound_log")
      .select("created_at, body")
      .eq("business_id", businessId)
      .eq("to_e164", contactE164)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(TIMELINE_MAX_EVENTS);
    if (outbound.error) {
      console.error("contact-context: outbound lookup", outbound.error);
    } else {
      for (const row of (outbound.data ?? []) as OutboundLogRow[]) {
        events.push({
          at: row.created_at ?? "",
          channel: "sms_out",
          text: row.body ?? ""
        });
      }
    }

    const calls = await supabase
      .from("voice_call_transcripts")
      .select("started_at, created_at, direction, summary, status")
      .eq("business_id", businessId)
      .eq("caller_e164", contactE164)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(3);
    if (calls.error) {
      console.error("contact-context: voice lookup", calls.error);
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

    return formatVoiceContactTimeline(events);
  } catch (e) {
    console.error("loadVoiceContactTimeline", e);
    return null;
  }
}
