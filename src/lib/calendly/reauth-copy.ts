/**
 * Pure Calendly reconnect copy: account labels, paused-trigger wording,
 * banner sentences, last-check formatting. No DB, so the dashboard and the
 * email template can share one phrasing without importing the notifier.
 */

export const CALENDLY_CALENDAR_PAUSED_COPY = "Paused until Calendly is reconnected.";

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
  locale = "en-US"
): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

export type CalendlyReauthBannerInput = {
  accountLabel: string;
  lastHealthyLabel: string | null;
};

/** Persistent dashboard banner body. Honest, no "token rejected". */
export function calendlyReauthBannerBody(input: CalendlyReauthBannerInput): string {
  const paused =
    `${input.accountLabel}'s Calendly needs a reconnect. ` +
    "Calendar follow-ups and booking checks for that account are paused";
  if (input.lastHealthyLabel) {
    return `${paused}, last successful check: ${input.lastHealthyLabel}.`;
  }
  return `${paused}.`;
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
