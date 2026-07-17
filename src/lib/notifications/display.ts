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
 * Deep-link target for a notification, derived from its kind + payload.
 * Returns null when there is no obviously better place than the list itself
 * (e.g. digests, which expand in place instead).
 */
export function notificationLink(n: NotificationLike): NotificationLink | null {
  const taskType = typeof n.payload?.taskType === "string" ? n.payload.taskType : "";
  if (taskType === "sms_cap_reached" || taskType === "chat_spend_cap_reached") {
    return { href: "/dashboard/billing", label: "Open Billing" };
  }
  if (taskType.includes("flow")) {
    return { href: "/dashboard/aiflows", label: "Open AiFlows" };
  }
  if (n.kind === "voice_capture" || taskType.includes("call") || taskType.includes("voice")) {
    return { href: "/dashboard/calls", label: "Open Calls" };
  }
  if (n.kind === "link_click") {
    const href =
      typeof n.payload?.thread_href === "string" && n.payload.thread_href.startsWith("/")
        ? n.payload.thread_href
        : "/dashboard/messages";
    return { href, label: "Open thread" };
  }
  if (n.kind === "urgent_alert") {
    return { href: "/dashboard", label: "Open Dashboard" };
  }
  return null;
}

export type NotificationDetailField = { label: string; value: string };

export type NotificationEventLink = { label: string; href: string; at?: string };

/**
 * Per-event deep links stored on digest notifications (payload.events,
 * written by the notifications-digest function). Validated defensively:
 * only objects with a non-empty label and a DASHBOARD-RELATIVE href are
 * returned, so a malformed or tampered payload can never render an external
 * link. "Starts with /" alone is NOT enough — "//evil.example.com" is a
 * protocol-relative URL browsers resolve off-site, so a second leading slash
 * is rejected (same rule the redirect helpers apply).
 */
export function notificationEventLinks(n: NotificationLike): NotificationEventLink[] {
  const raw = n.payload?.events;
  if (!Array.isArray(raw)) return [];
  const out: NotificationEventLink[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { label, href, at } = item as Record<string, unknown>;
    if (typeof label !== "string" || label.trim().length === 0) continue;
    if (typeof href !== "string" || !href.startsWith("/") || href.startsWith("//")) continue;
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
 * decodeURIComponent can throw on a malformed (tampered) payload — treated as
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
 * notifications list reads "Texts with Mike Haas — …" instead of a bare
 * +1602… number. Only text-thread events are rewritten — customer events
 * already carry the display name in their label — and only when the number is
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
 * presentable values are returned; internal keys (logId, reason — rendered
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
  const activitySummary = str(p.activitySummary);
  if (activitySummary) fields.push({ label: "Activity", value: activitySummary });
  const summary = str(p.summary);
  if (summary) fields.push({ label: "Detail", value: summary });
  const taskType = str(p.taskType);
  if (taskType) fields.push({ label: "Event", value: taskType.replace(/_/g, " ") });
  const periodKey = str(p.period_key);
  if (periodKey) fields.push({ label: "Period", value: periodKey });
  return fields;
}
