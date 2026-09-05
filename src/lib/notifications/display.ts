/**
 * Pure presentation helpers for the dashboard notifications list: where a
 * notification should deep-link, and which payload fields are worth showing
 * in the expanded detail view. Kept out of the component so they sit under
 * the lib coverage gate and the row component stays render-only.
 */

export type NotificationLike = {
  kind: string | null;
  payload: Record<string, unknown> | null;
};

export type NotificationLink = { href: string; label: string };

/**
 * Same shape the SMS thread route validates its segment against
 * (`/dashboard/messages/[customerE164]`), short codes included. Applied
 * BEFORE building an href so a malformed payload can never produce a link
 * that 404s.
 */
const E164_RE = /^(\+[1-9]\d{6,15}|\d{3,8})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readString(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function readE164(payload: Record<string, unknown>, key: string): string | null {
  const v = readString(payload, key);
  return v && E164_RE.test(v) ? v : null;
}

function readUuid(payload: Record<string, unknown>, key: string): string | null {
  const v = readString(payload, key);
  return v && UUID_RE.test(v) ? v : null;
}

/**
 * An href is safe to render only when it stays inside the dashboard. "Starts
 * with /" alone is NOT enough, "//evil.example.com" is a protocol-relative
 * URL browsers resolve off-site, so a second leading slash is rejected (same
 * rule the redirect helpers apply).
 */
function isInternalHref(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

function messagesHref(e164: string): string {
  return `/dashboard/messages/${encodeURIComponent(e164)}`;
}

/**
 * Where a notification actually happened, derived from its kind + payload.
 *
 * Every row on the notifications page gets a destination: the owner clicks
 * the headline to land on the text thread, call, flow run or document the
 * alert is about, rather than on a list page they then have to search. When
 * the payload carries no usable id (or carries a malformed one), this falls
 * back to the closest surface instead of returning a broken link, so the
 * headline is never a dead end.
 *
 * Ids are shape-checked before they reach an href because `payload` is
 * free-form jsonb written by many producers.
 */
export function notificationLink(n: NotificationLike): NotificationLink {
  const p = n.payload ?? {};
  const kind = n.kind ?? "";
  const taskType = readString(p, "taskType") ?? "";

  // A producer that already computed the destination wins (link_click
  // stamps thread_href at dispatch time).
  const stamped = readString(p, "thread_href");
  if (stamped && isInternalHref(stamped)) {
    return { href: stamped, label: "Open thread" };
  }

  // A link click is always a text-thread event, so it stays on Messages even
  // when the stamped href is missing or was tampered with. The recipient
  // number is on the payload for the per-contact throttle, so use it.
  if (kind === "link_click") {
    const clicked = readE164(p, "to_e164");
    return clicked
      ? { href: messagesHref(clicked), label: "Open text thread" }
      : { href: "/dashboard/messages", label: "Open thread" };
  }

  // Voice alerts point at the transcript, which the notifications page
  // resolves server-side and stamps as `transcriptId`: the call detail route
  // keys on the transcript row UUID, NOT Telnyx's call_control_id, whose
  // literal ":" gets mangled in the routing layer (see
  // lib/db/voice-transcripts.getTranscriptById).
  if (kind === "voice_capture" || kind === "voice_team_notify") {
    const transcriptId = readUuid(p, "transcriptId");
    if (transcriptId) {
      return { href: `/dashboard/calls/${transcriptId}`, label: "Open call" };
    }
    // No transcript row (yet): the caller's profile still lists their calls.
    const caller = readE164(p, "callerPhone");
    if (caller) {
      return {
        href: `/dashboard/customers/${encodeURIComponent(caller)}`,
        label: "Open contact"
      };
    }
    return { href: "/dashboard/calls", label: "Open Calls" };
  }

  if (kind === "document_signed" || kind === "document_expired" || kind === "document_expiring") {
    const documentId = readUuid(p, "documentId");
    if (documentId) {
      return { href: `/dashboard/documents/${documentId}`, label: "Open document" };
    }
    return { href: "/dashboard/documents", label: "Open Documents" };
  }

  // Image cap: on the SMS surface the session key IS the texter's number.
  if (kind === "image_limit") {
    const sessionE164 = readString(p, "surface") === "sms" ? readE164(p, "sessionKey") : null;
    if (sessionE164) {
      return { href: messagesHref(sessionE164), label: "Open text thread" };
    }
    return { href: "/dashboard/chat", label: "Open Chat" };
  }

  // A booking alert asks the owner to look at (or assign) the person who
  // booked, so it lands on the contact, not on their text thread. Placed
  // above the generic contactE164 branch, and matching the email's own
  // button: the two must not point at different screens.
  if (kind === "unassigned_booking" || kind === "assigned_booking") {
    const bookingE164 = readE164(p, "contactE164");
    if (bookingE164) {
      return {
        href: `/dashboard/customers/${encodeURIComponent(bookingE164)}`,
        label: "Open contact"
      };
    }
    return { href: "/dashboard/bookings", label: "Open Bookings" };
  }

  if (kind === "email_coworker_handoff") {
    return { href: "/dashboard/emails", label: "Open Emails" };
  }

  // A bounced email to a contact: land on the person (phone and any other
  // address live there), matching the email and push CTA. The generic
  // contactE164 branch would open their text thread instead. Payload key is
  // `to_e164` because that is what the per-contact throttle already stamps;
  // contactE164 is accepted too so a future producer cannot miss.
  if (kind === "contact_email_bounce") {
    const bounceE164 = readE164(p, "to_e164") ?? readE164(p, "contactE164");
    if (bounceE164) {
      return {
        href: `/dashboard/customers/${encodeURIComponent(bounceE164)}`,
        label: "Open contact"
      };
    }
    return { href: "/dashboard/emails", label: "Open Emails" };
  }
  if (
    kind === "byon_port" ||
    kind === "byon_activation" ||
    kind === "calendar_connection_broken" ||
    kind === "meta_connection_broken"
  ) {
    return { href: "/dashboard/integrations", label: "Open Integrations" };
  }
  if (
    taskType === "sms_cap_reached" ||
    taskType === "chat_spend_cap_reached" ||
    // Auto-reload stopped for some reason the tenant has to act on. Every one
    // of these is fixed from the billing page (new card, raise the limit,
    // turn it back on), so they all land there.
    taskType.startsWith("auto_reload_")
  ) {
    return { href: "/dashboard/billing", label: "Open Billing" };
  }

  // Flow failures stamp the run (and, since this change, its flow) so the
  // runs page can expand that run's group instead of the whole log.
  if (taskType.includes("flow")) {
    const runId = readUuid(p, "runId");
    const flowId = readUuid(p, "flowId");
    if (runId) {
      const query = flowId ? `?flowId=${flowId}&run=${runId}` : `?run=${runId}`;
      return { href: `/dashboard/aiflows/runs${query}`, label: "Open flow run" };
    }
    return { href: "/dashboard/aiflows", label: "Open AiFlows" };
  }

  // Anything scoped to one texter: their thread. `customerPhone` comes from
  // the notify_team tool, `contactE164` from the needs-human and
  // customer-reply escalations.
  const threadE164 = readE164(p, "customerPhone") ?? readE164(p, "contactE164");
  if (threadE164) {
    return { href: messagesHref(threadE164), label: "Open text thread" };
  }

  if (taskType.includes("call") || taskType.includes("voice")) {
    return { href: "/dashboard/calls", label: "Open Calls" };
  }

  // Digests (their per-event links stay in the expanded detail) and anything
  // whose kind arrived after this function was written: the unified feed is
  // the closest thing to "where it happened".
  return { href: "/dashboard/activity", label: "Open Activity" };
}

export type NotificationDetailField = { label: string; value: string };

export type NotificationEventLink = { label: string; href: string; at?: string };

/**
 * Per-event deep links stored on digest notifications (payload.events,
 * written by the notifications-digest function). Validated defensively:
 * only objects with a non-empty label and a DASHBOARD-RELATIVE href are
 * returned (see isInternalHref), so a malformed or tampered payload can
 * never render an external link.
 */
export function notificationEventLinks(n: NotificationLike): NotificationEventLink[] {
  const raw = n.payload?.events;
  if (!Array.isArray(raw)) return [];
  const out: NotificationEventLink[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { label, href, at } = item as Record<string, unknown>;
    if (typeof label !== "string" || label.trim().length === 0) continue;
    if (typeof href !== "string" || !isInternalHref(href)) continue;
    out.push({
      label: label.trim(),
      href,
      ...(typeof at === "string" && at ? { at } : {})
    });
  }
  return out;
}

/** Digest text-thread events deep-link here, with the E.164 URL-encoded. */
const MESSAGES_HREF_PREFIX = "/dashboard/messages/";

/**
 * Extract the E.164 a digest event deep-links to, or null when it isn't a
 * text-thread link. The digest builder encodes the number into the href
 * (`/dashboard/messages/<encodeURIComponent(e164)>`); this reverses that so
 * the raw number embedded in the label can be swapped for a contact name.
 * decodeURIComponent can throw on a malformed (tampered) payload, treated as
 * "no number" rather than crashing the list render.
 */
export function eventLinkE164(href: string): string | null {
  if (!href.startsWith(MESSAGES_HREF_PREFIX)) return null;
  try {
    return decodeURIComponent(href.slice(MESSAGES_HREF_PREFIX.length));
  } catch {
    return null;
  }
}

/**
 * Swap raw phone numbers in digest event labels for known contact names using
 * the same resolver (`resolveContactNames`) the dashboard uses, so the
 * notifications list reads "Texts with Mike Haas, …" instead of a bare
 * +1602… number. Only text-thread events are rewritten, customer events
 * already carry the display name in their label, and only when the number is
 * actually known; everything else is returned unchanged.
 */
export function applyContactNamesToEventLinks(
  events: NotificationEventLink[],
  names: Map<string, string>
): NotificationEventLink[] {
  if (names.size === 0) return events;
  return events.map((ev) => {
    const e164 = eventLinkE164(ev.href);
    if (!e164) return ev;
    const name = names.get(e164);
    if (!name) return ev;
    return { ...ev, label: ev.label.split(e164).join(name) };
  });
}

/**
 * Human-labeled payload fields for the expanded row. Only fields with
 * presentable values are returned; internal keys (logId, reason, rendered
 * separately) are skipped.
 */
export function notificationDetailFields(n: NotificationLike): NotificationDetailField[] {
  const p = n.payload ?? {};
  const fields: NotificationDetailField[] = [];
  const str = (v: unknown): string | null => {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    return null;
  };

  const windowVal = str(p.window);
  if (windowVal) {
    fields.push({ label: "Window", value: windowVal === "weekly" ? "Weekly" : "Daily" });
  }
  const recipient = str(p.recipient);
  if (recipient) fields.push({ label: "Sent to", value: recipient });
  // Contact-scoped alerts go to whoever owns the lead, so say who that was
  // and why. Without this the owner sees an alert about their lead land on
  // someone else's phone with no explanation.
  const routedTo = str(p.routed_to);
  if (routedTo) {
    fields.push({
      label: "Routed to",
      value:
        routedTo === "contact_owner"
          ? (str(p.routed_member_name) ?? "The lead's owner")
          : "Business owner"
    });
  }
  const activitySummary = str(p.activitySummary);
  if (activitySummary) fields.push({ label: "Activity", value: activitySummary });
  // Prefer the untruncated original (notify_team stores it as
  // payload.message) over payload.summary, whose headline copy is capped for
  // the list title and can end mid-thought.
  const detail = str(p.message) ?? str(p.summary);
  if (detail) fields.push({ label: "Detail", value: detail });
  const taskType = str(p.taskType);
  if (taskType) fields.push({ label: "Event", value: taskType.replace(/_/g, " ") });
  const periodKey = str(p.period_key);
  if (periodKey) fields.push({ label: "Period", value: periodKey });
  return fields;
}
