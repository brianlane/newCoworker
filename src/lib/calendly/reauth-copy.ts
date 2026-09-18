/**
 * Pure Calendly reconnect copy: account labels, paused-trigger wording,
 * last-check formatting. No DB, so the dashboard and the email template
 * can share one phrasing without importing the notifier.
 */

const CALENDLY_CALENDAR_PAUSED_COPY = "Paused until Calendly is reconnected.";

/** App-relative deep link that opens Reconnect on one connection row. */
export function calendlyReconnectPath(connectionId: string): string {
  return `/dashboard/integrations/calendly?reconnect=${encodeURIComponent(connectionId)}`;
}

/** The name the owner already knows this Calendly by. */
export function calendlyAccountLabel(row: {
  account_name?: string | null;
  account_email?: string | null;
}): string {
  const name = row.account_name?.trim() || "";
  const email = row.account_email?.trim() || "";
  if (name) return name;
  if (email) return email;
  return "Calendly";
}

/** Last successful check as a short owner-facing stamp, or null if unusable. */
export function formatCalendlyLastHealthy(
  iso: string | null | undefined,
  locale = "en-US",
  timeZone?: string | null
): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  };
  const tz = timeZone?.trim() || undefined;
  if (!tz) {
    return new Date(ms).toLocaleString(locale, options);
  }
  try {
    return new Date(ms).toLocaleString(locale, { ...options, timeZone: tz });
  } catch {
    return new Date(ms).toLocaleString(locale, { ...options, timeZone: "UTC" });
  }
}

/**
 * Calendar-trigger paused copy. Only when EVERY Calendly account on the
 * business needs reconnect (a sibling healthy account still runs).
 */
export function calendlyCalendarPausedCopy(args: {
  hasHealthyCalendly: boolean;
  hasCalendlyNeedingReauth: boolean;
}): string | null {
  if (args.hasCalendlyNeedingReauth && !args.hasHealthyCalendly) {
    return CALENDLY_CALENDAR_PAUSED_COPY;
  }
  return null;
}

/**
 * Dashboard trigger-status pause copy. Calendar follow-ups actually run
 * on whichever provider `resolveCalendarConnection` returns (Vagaro,
 * Acuity, Google, Outlook, CalDAV beat Calendly). Showing "Paused until
 * Calendly is reconnected" on those tenants would be a lie: their
 * follow-ups are not paused. Null provider (nothing connected) still
 * shows the Calendly pause, because that is why there is no calendar.
 */
export function calendlyUiPauseCopy(args: {
  pausedCopy: string | null;
  resolvedCalendarProvider?: string | null;
}): string | null {
  if (!args.pausedCopy) return null;
  const provider = args.resolvedCalendarProvider?.trim() || null;
  if (provider && provider !== "calendly") return null;
  return args.pausedCopy;
}

export function isCalendlyTokenRejected(err: unknown): boolean {
  return err instanceof Error && err.message === "calendly_token_rejected";
}

/** True when the primary trigger or any extra trigger watches a calendar. */
export function flowHasCalendarTrigger(def: {
  trigger?: { channel?: string };
  triggers?: Array<{ channel?: string }>;
}): boolean {
  if (def.trigger?.channel === "calendar") return true;
  return (def.triggers ?? []).some((t) => t.channel === "calendar");
}
