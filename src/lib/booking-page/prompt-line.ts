/**
 * Teach the coworker the business's scheduling link, whichever calendar
 * the business actually books with.
 *
 * The Beth delegation surfaced the gap (Jul 2026): the owner asks the
 * coworker to schedule Liz by emailing her assistant, and the RIGHT email
 * usually is not a list of times, it is the business's scheduling link,
 * where the assistant picks a slot against live availability. But no AI
 * surface knew the link existed, so the model could only negotiate times
 * or invent a URL.
 *
 * Provider-aware, because "our booking link" means different things per
 * tenant: HQ books through the native booking page, a Calendly tenant
 * books through their Calendly event type, and a Vagaro tenant books
 * through Vagaro's own site (whose URL the platform does not hold, so no
 * link is offered rather than an invented one). Computed per turn (the
 * slug, the meetings, and the provider are all owner-editable) and
 * best-effort by contract: a failed read costs only this hint, never the
 * turn.
 */

import { getBookingPageForBusiness, upsertBookingPage } from "@/lib/booking-page/db";
import { listMeetingTypes, visibleMeetingTypes } from "@/lib/booking-page/meeting-types";
import { getBusiness } from "@/lib/db/businesses";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { pickCalendlyEventType } from "@/lib/calendar-tools/calendly";
import { logger } from "@/lib/logger";

/**
 * One bookable meeting, named AND timed.
 *
 * The duration is not decoration. A visitor who clicks the link books the
 * meeting type's own length, but an AI-made booking carries no
 * `meeting_type_id` at all (README, "Public self-serve booking page"), so the
 * coworker's `calendar_find_slots` call falls back to its 30-minute schema
 * default. That is how HQ ended up advertising a "15-minute discovery call"
 * for a meeting configured at 60, bookable at 30 by reply: three lengths for
 * one call (Jul 30 2026). Naming the minutes here is the only channel by
 * which the model can learn the real one.
 */
export type BookingMeeting = {
  name: string;
  durationMinutes: number;
};

export type PublicBookingLink = {
  /** Absolute URL, vanity slug preferred over the raw token. */
  url: string;
  /** What the link books, for the coworker to name it by. */
  title: string;
  /**
   * The meetings a visitor can pick from, so the coworker can name them
   * instead of guessing. One entry for a Calendly event type; empty only
   * when a page somehow has no meeting to offer.
   */
  meetings: BookingMeeting[];
};

export type SchedulingLink = PublicBookingLink & {
  /** Which surface actually takes the booking. */
  kind: "booking_page" | "calendly";
};

/**
 * A discovery-call-shaped default when picking among Calendly event types;
 * pickCalendlyEventType chooses whichever active type sits closest.
 */
const CALENDLY_DEFAULT_DURATION_MINUTES = 30;

/**
 * The enabled page's public URL and title, or null when there is none.
 *
 * `provisionIfMissing` creates the page when NO row exists at all, exactly
 * the way the dashboard's first view does (enabled from birth is safe: the
 * token is unguessable until somebody shares it). A tenant delegating
 * scheduling before ever opening the Bookings dashboard should not lose
 * the link to a visit they never made. A row that EXISTS but is disabled
 * is the owner's off switch, and it stays off.
 */
export async function publicBookingLink(
  businessId: string,
  opts: { provisionIfMissing?: boolean } = {}
): Promise<PublicBookingLink | null> {
  let page = await getBookingPageForBusiness(businessId);
  if (!page && opts.provisionIfMissing) {
    try {
      page = await upsertBookingPage(businessId, { enabled: true });
    } catch (err) {
      // Two concurrent first-time turns can race the insert; the loser hits
      // the business_id unique constraint. Re-read the winner's row and
      // only give up when there is genuinely no page.
      page = await getBookingPageForBusiness(businessId);
      if (!page) throw err;
    }
  }
  if (!page || !page.enabled) return null;
  const site = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const [business, meetingTypes] = await Promise.all([
    getBusiness(businessId),
    listMeetingTypes(businessId)
  ]);
  // The meetings name the link, because they are what a visitor actually
  // sees: one meeting IS the page, so the coworker can say "book the
  // discovery call", and several mean the link opens a choice.
  const meetings = visibleMeetingTypes(meetingTypes).map((t) => ({
    name: t.name,
    durationMinutes: t.duration_minutes
  }));
  return {
    url: `${site}/book/${page.slug ?? page.token}`,
    title:
      meetings.length === 1
        ? meetings[0].name
        : `Book a call with ${business?.name?.trim() || "us"}`,
    meetings
  };
}

/**
 * The link this business actually schedules through, following the same
 * provider resolution the calendar tools use:
 *
 * - Calendly tenants get their Calendly event type's scheduling URL (the
 *   native page is deliberately not provisioned for them).
 * - Vagaro tenants get NO link: their booking site's URL is not held by
 *   the platform, and no link beats an invented one.
 * - Everyone else (Google, Microsoft, CalDAV, platform mode) gets the
 *   native booking page, provisioned on first need if the owner has never
 *   opened the Bookings dashboard.
 */
export async function schedulingLink(businessId: string): Promise<SchedulingLink | null> {
  const conn = await resolveCalendarConnection(businessId);
  if (conn?.provider === "calendly") {
    const picked = await pickCalendlyEventType(
      businessId,
      conn,
      CALENDLY_DEFAULT_DURATION_MINUTES
    );
    if (typeof picked === "object" && picked.eventType.schedulingUrl) {
      return {
        url: picked.eventType.schedulingUrl,
        title: picked.eventType.name,
        meetings: [
          { name: picked.eventType.name, durationMinutes: picked.eventType.duration }
        ],
        kind: "calendly"
      };
    }
    return null;
  }
  // Vagaro and Acuity merchants book on their own site, and we do not hold
  // its URL, so there is no link to hand out at all.
  if (conn?.provider === "vagaro" || conn?.provider === "acuity") return null;
  // Provision on first need: the same rule as the dashboard's first view,
  // and only reachable for the providers the page supports (the Vagaro,
  // Acuity and Calendly branches above never get here).
  const page = await publicBookingLink(businessId, { provisionIfMissing: true });
  return page ? { ...page, kind: "booking_page" } : null;
}

/**
 * The scheduling link a COLD EMAIL should carry.
 *
 * Same resolution as `schedulingLink`, with one addition: when the owner has
 * named a meeting for outreach, the link goes straight to that meeting rather
 * than to the page's chooser.
 *
 * Why outreach gets its own answer. The chooser asks "what would you like to
 * book?", which is a reasonable question for somebody who arrived on purpose
 * and a bad one for a stranger who has read one paragraph about missed calls.
 * A named meeting turns the click into a calendar. The coworker still offers
 * the whole menu on every other surface, because there the question is fair.
 *
 * Falls back to the page link, never to nothing, in all three ways this can
 * come apart: a Calendly tenant (whose event types are not ours to deep link,
 * and whose URL is already one specific event), a meeting since deleted or
 * disabled, and no choice made at all. A cold email with the chooser link is
 * worse than one with a named meeting; a cold email with a dead link is worse
 * than both.
 */
export async function outreachSchedulingLink(
  businessId: string,
  meetingTypeId: string | null
): Promise<SchedulingLink | null> {
  const base = await schedulingLink(businessId);
  if (!base || !meetingTypeId || base.kind !== "booking_page") return base;
  const chosen = (await listMeetingTypes(businessId)).find((t) => t.id === meetingTypeId);
  // `enabled` is re-checked here rather than trusted from the stored id: the
  // owner can switch a meeting off in Bookings long after choosing it here,
  // and a direct link to a disabled type shows the visitor "not available".
  if (!chosen || !chosen.enabled) return base;
  return {
    ...base,
    url: `${base.url}/${chosen.slug}`,
    title: chosen.name,
    meetings: [{ name: chosen.name, durationMinutes: chosen.duration_minutes }]
  };
}

/**
 * The line itself, pure so the live-model e2e can build its system prompt
 * from the REAL string (imported, not paraphrased) without a database.
 */
/** "Discovery Call (60 minutes)", how a meeting is named to the model. */
function describeMeeting(meeting: BookingMeeting): string {
  return `${meeting.name} (${meeting.durationMinutes} minutes)`;
}

export function formatBookingLinkPromptLine(link: SchedulingLink): string {
  // One shared read, so the length is stated the same way whichever surface
  // takes the booking and no branch needs a made-up default.
  const [only] = link.meetings;
  const surface =
    link.kind === "calendly"
      ? `This business schedules through Calendly: ${link.url} (the event is called ` +
        `"${link.title}"${only ? ` and runs ${only.durationMinutes} minutes` : ""}).`
      : link.meetings.length > 1
        ? `This business has a public self-serve booking page: ${link.url}, where the visitor ` +
          `chooses one of these meetings and then a time: ` +
          `${link.meetings.map(describeMeeting).join(", ")}.`
        : only
          ? `This business has a public self-serve booking page: ${link.url}, which books ` +
            `"${only.name}" and runs ${only.durationMinutes} minutes.`
          : `This business has a public self-serve booking page: ${link.url}, where the ` +
            `visitor picks a time.`;
  // The length is stated as a booking INSTRUCTION, not trivia: an AI-made
  // booking carries no meeting type, so without this the model silently books
  // the tool's 30-minute default and quotes whatever number the flow copy
  // happened to hardcode.
  const durationRule = link.meetings.length
    ? ` When you book one of these yourself, use that meeting's stated length as the ` +
      `appointment duration, and quote that same length to the person: never guess a ` +
      `different number and never describe it as shorter than it is.`
    : "";
  return (
    `SCHEDULING LINK. ${surface}${durationRule} When you write to someone so THEY choose the time, for ` +
    `example emailing an assistant who books on someone's behalf, send that exact link by ` +
    `default: it always shows live availability, while a list of times goes stale. Do NOT ` +
    `ask the owner whether to send the link or list times; the link IS the default, and ` +
    `you list specific times only when the owner explicitly asked for times. When the ` +
    `owner asks you to schedule someone through a contact and gives you that contact's ` +
    `address, that request IS the instruction to send the email: compose it with the link ` +
    `and send it, without asking which approach to use. Never invent a different booking URL.`
  );
}

/**
 * The system-prompt line for owner-facing surfaces (dashboard chat, owner
 * SMS, the email coworker). Null when the business has no scheduling link
 * or the read fails, which simply leaves the surface as it was.
 */
export async function bookingLinkPromptLine(businessId: string): Promise<string | null> {
  try {
    const link = await schedulingLink(businessId);
    if (!link) return null;
    return formatBookingLinkPromptLine(link);
  } catch (err) {
    logger.warn("booking-page: prompt line unavailable", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
