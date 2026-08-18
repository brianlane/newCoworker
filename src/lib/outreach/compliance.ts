/**
 * Prospecting, the compliance gates, in code rather than in policy.
 *
 * Cold commercial email is CAN-SPAM territory: an accurate From, a
 * non-deceptive subject, a working opt-out, and a physical postal address.
 * Three of those are structural elsewhere (the mail is sent from the tenant's
 * own connected mailbox, the subject names the finding, and the DB refuses to
 * leave 'off' without a postal address). This module owns the fourth, plus the
 * pacing rules that keep a sending domain's reputation intact.
 *
 * The unsubscribe token is prospect-scoped rather than contact-scoped: a
 * prospect is not a contact yet when the pitch goes out (the outreach flow
 * files them), so there is no contact id to sign. It mirrors
 * `marketingUnsubscribeToken` (src/lib/campaigns/send.ts) exactly, with a
 * different HMAC label so a campaign token can never unsubscribe a prospect
 * or the reverse.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/* c8 ignore next 2 -- key presence is environment wiring */
const signingSecret = (): string =>
  process.env.INTEGRATIONS_ENCRYPTION_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/** HMAC over business + prospect ids: a link only unsubscribes its own row. */
export function outreachUnsubscribeToken(businessId: string, prospectId: string): string {
  return createHmac("sha256", signingSecret())
    .update(`outreach-unsub:${businessId}:${prospectId}`)
    .digest("hex")
    .slice(0, 32);
}

/** Constant-time token check. */
export function verifyOutreachUnsubscribeToken(
  businessId: string,
  prospectId: string,
  token: string
): boolean {
  const expected = outreachUnsubscribeToken(businessId, prospectId);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildOutreachUnsubscribeUrl(
  appUrl: string,
  businessId: string,
  prospectId: string
): string {
  const base = appUrl.replace(/\/+$/, "");
  const token = outreachUnsubscribeToken(businessId, prospectId);
  return `${base}/api/outreach/unsubscribe?bid=${encodeURIComponent(businessId)}&p=${encodeURIComponent(prospectId)}&t=${token}`;
}

/** Weekday + hour of an instant in a timezone. Invalid zones fall back to UTC. */
export function localWeekdayAndHour(
  instant: Date,
  timeZone: string | null | undefined
): { weekday: number; hour: number } {
  const zone = timeZone?.trim() || "UTC";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      weekday: "short",
      hour: "2-digit"
    }).formatToParts(instant);
  } catch {
    // An unknown zone must not stop a tenant's outreach; UTC is the honest
    // fallback and the window is still respected, just in UTC.
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      hourCycle: "h23",
      weekday: "short",
      hour: "2-digit"
    }).formatToParts(instant);
  }
  // Both fallback arms are unreachable: Intl always emits every requested
  // part (the same note wallClockInZone carries in calendar-tools).
  /* c8 ignore next */
  const weekdayName = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  /* c8 ignore next */
  const hourText = parts.find((p) => p.type === "hour")?.value ?? "0";
  return { weekday: weekdayIndex(weekdayName), hour: Number(hourText) };
}

/**
 * Short weekday name to a Sunday-zero index. Exported so the unmatched case
 * is testable: it cannot arise from `en-US` today, but an unrecognized name
 * must resolve to a real day rather than to -1, which would read as neither a
 * weekend nor a weekday and quietly send outside the window.
 */
export function weekdayIndex(shortName: string): number {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const index = names.indexOf(shortName);
  return index === -1 ? 0 : index;
}

/**
 * True when now is inside the tenant's weekday send window. Weekends never
 * send: a cold email that lands on Saturday is read on Monday alongside the
 * weekend's spam, if at all.
 */
export function isWithinSendWindow(
  now: Date,
  timeZone: string | null | undefined,
  startHour: number,
  endHour: number
): boolean {
  const { weekday, hour } = localWeekdayAndHour(now, timeZone);
  if (weekday === 0 || weekday === 6) return false;
  return hour >= startHour && hour < endHour;
}

/** Start of the current UTC day, the daily cap's window. */
export function utcDayStartIso(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  ).toISOString();
}

/**
 * Explicit instructions to stop. Deliberately narrow: every phrase here is a
 * request, not an opinion.
 *
 * "Not interested" and "no thanks" are NOT here, though they look like they
 * belong. They are ordinary replies, and treating them as opt-outs would
 * permanently suppress a prospect who was mid-sentence ("not interested in the
 * booking part, but tell me about the texting") and stop the coworker from
 * answering. Nothing is lost by leaving them out: ANY reply cancels the
 * follow-up, because the nudge only chases silence. A real opt-out gets the
 * permanent treatment; a lukewarm reply gets a human answer.
 */
const STOP_PHRASES = [
  "unsubscribe",
  "remove me",
  "take me off",
  "stop emailing",
  "stop contacting",
  "do not contact",
  "don't contact",
  "opt out",
  "opt-out"
];

/** Quote markers the common clients insert above the history they append. */
const QUOTE_MARKERS = [
  /^>/,
  /^-{2,}\s*original message/i,
  /^on\b.*\bwrote:\s*$/i,
  /^from:\s/i,
  /^sent from my /i
];

/**
 * What the person actually typed: everything above the quoted history.
 *
 * This is load-bearing rather than tidy. Our own pitch footer says "You can
 * unsubscribe here", so a reply that quotes the thread carries the word
 * "unsubscribe" in its body. Matching the whole body would read a warm reply
 * as an opt-out and permanently suppress the prospect.
 */
export function topReplyText(body: string): string {
  const kept: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (QUOTE_MARKERS.some((re) => re.test(trimmed))) break;
    kept.push(line);
  }
  return kept.join("\n");
}

/** True when the reply, above any quoted history, asks us to stop. */
export function looksLikeOptOut(replyText: string): boolean {
  const text = topReplyText(replyText).toLowerCase();
  return STOP_PHRASES.some((p) => text.includes(p));
}
