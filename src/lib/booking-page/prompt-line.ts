/**
 * Teach the coworker its own booking link.
 *
 * The Beth delegation surfaced the gap (Jul 2026): the owner asks the
 * coworker to schedule Liz by emailing her assistant, and the RIGHT email
 * often is not a list of times, it is the business's public booking page,
 * where the assistant picks a slot against live availability. But no AI
 * surface knew the page existed, let alone its vanity URL or public title,
 * so the model could only negotiate times or invent a URL.
 *
 * One line, computed per turn (the slug and title are owner-editable), and
 * best-effort by contract: a page read failing must never cost the turn,
 * it only costs this hint.
 */

import { getBookingPageForBusiness } from "@/lib/booking-page/db";
import { getBusiness } from "@/lib/db/businesses";
import { logger } from "@/lib/logger";

export type PublicBookingLink = {
  /** Absolute URL, vanity slug preferred over the raw token. */
  url: string;
  /** The title visitors see on the page. */
  title: string;
};

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
 * The line itself, pure so the live-model e2e can build its system prompt
 * from the REAL string (imported, not paraphrased) without a database.
 */
export function formatBookingLinkPromptLine(link: PublicBookingLink): string {
  return (
    `SCHEDULING LINK. This business has a public self-serve booking page: ${link.url} ` +
    `(visitors see it titled "${link.title}"). When you write to someone so THEY choose ` +
    `the time, for example emailing an assistant who books on someone's behalf, prefer ` +
    `sending that exact link over listing available times: the page always shows live ` +
    `availability, while a list of times goes stale. If the owner explicitly asked for ` +
    `specific times to be listed, list them as asked. Never invent a different booking URL.`
  );
}

/**
 * The system-prompt line for owner-facing surfaces (dashboard chat, owner
 * SMS, the email coworker). Null when the business has no enabled page or
 * the read fails, which simply leaves the surface as it was.
 */
export async function bookingLinkPromptLine(businessId: string): Promise<string | null> {
  try {
    const link = await publicBookingLink(businessId);
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
