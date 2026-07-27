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
 * slug, title, and provider are all owner-editable) and best-effort by
 * contract: a failed read costs only this hint, never the turn.
 */

import { getBookingPageForBusiness } from "@/lib/booking-page/db";
import { getBusiness } from "@/lib/db/businesses";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { pickCalendlyEventType } from "@/lib/calendar-tools/calendly";
import { logger } from "@/lib/logger";

export type PublicBookingLink = {
  /** Absolute URL, vanity slug preferred over the raw token. */
  url: string;
  /** The title visitors see on the page. */
  title: string;
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

/** The enabled page's public URL and title, or null when there is none. */
export async function publicBookingLink(businessId: string): Promise<PublicBookingLink | null> {
  const page = await getBookingPageForBusiness(businessId);
  if (!page || !page.enabled) return null;
  const site = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const business = await getBusiness(businessId);
  return {
    url: `${site}/book/${page.slug ?? page.token}`,
    // Same fallback the public page renders when no custom title is set.
    title: page.title?.trim() || `Book a call with ${business?.name?.trim() || "us"}`
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
 *   native booking page when it is enabled.
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
        kind: "calendly"
      };
    }
    return null;
  }
  if (conn?.provider === "vagaro") return null;
  const page = await publicBookingLink(businessId);
  return page ? { ...page, kind: "booking_page" } : null;
}

/**
 * The line itself, pure so the live-model e2e can build its system prompt
 * from the REAL string (imported, not paraphrased) without a database.
 */
export function formatBookingLinkPromptLine(link: SchedulingLink): string {
  const surface =
    link.kind === "calendly"
      ? `This business schedules through Calendly: ${link.url} (the event is called "${link.title}").`
      : `This business has a public self-serve booking page: ${link.url} (visitors see it titled "${link.title}").`;
  return (
    `SCHEDULING LINK. ${surface} When you write to someone so THEY choose the time, for ` +
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
