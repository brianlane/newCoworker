/**
 * GET /api/calendar/<ncbf_token>.ics, the subscribable booking feed.
 *
 * Public by design: the token IS the capability, same posture as the
 * booking page's `ncb_` token, and calendar apps fetch this URL on their
 * own schedule with no session. Rate limiting is durable (cross-instance)
 * for the same reason the public booking endpoints' is: subscribers poll
 * from Google's and Apple's fetch fleets, not from one IP.
 *
 * Responses carry no phone numbers or emails, only display names, a
 * forwarded calendar link must not become a contact-list leak.
 */
import {
  findBusinessByCalendarFeedToken,
  parseCalendarFeedToken
} from "@/lib/db/calendar-feed";
import { renderCalendarFeed } from "@/lib/calendar-tools/feed";
import { rateLimitDurable } from "@/lib/rate-limit";
import { handleRouteError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/** Calendar apps poll every 15 minutes to daily; 30/5min absorbs that with
 * slack for a household of devices while capping token-guessing. */
const FEED_RATE = { interval: 5 * 60 * 1000, maxRequests: 30 };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token: raw } = await params;
    const token = parseCalendarFeedToken(raw);
    // Fail closed on shape alone: no DB hit, no rate-limit slot, and a 404
    // that does not distinguish garbage from a rotated token.
    if (!token) return new Response("Not found", { status: 404 });

    const limited = await rateLimitDurable(`calendar-feed:${token}`, FEED_RATE);
    if (!limited.success) {
      return new Response("Too many requests", { status: 429 });
    }

    const businessId = await findBusinessByCalendarFeedToken(token);
    if (!businessId) return new Response("Not found", { status: 404 });

    const ics = await renderCalendarFeed(businessId, Date.now());
    if (ics === null) return new Response("Not found", { status: 404 });

    return new Response(ics, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="bookings.ics"',
        // Subscribers poll; a short shared cache absorbs a burst without
        // making a rotation or a new booking invisible for long.
        "Cache-Control": "private, max-age=300"
      }
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
