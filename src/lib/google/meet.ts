/**
 * Google Meet links for booked appointments.
 *
 * Unlike Zoom (src/lib/zoom/meetings.ts), which creates a meeting through its
 * own API BEFORE the calendar event and then has to clean the meeting up on
 * every failure branch, a Meet link is created BY the Google Calendar event:
 * the insert carries `conferenceData.createRequest` and the query parameter
 * `conferenceDataVersion=1`, and Google answers with a `hangoutLink`.
 *
 * Three consequences shape this module, and they are why it is this small:
 *
 *   - There is nothing to roll back. A failed insert leaves no orphan
 *     conference, so none of Zoom's cleanup branches have a counterpart.
 *   - There is nothing to move or delete. A PATCH that changes only times
 *     leaves `conferenceData` alone (the default `conferenceDataVersion=0`
 *     means "this client does not speak conference data", which PRESERVES
 *     what is on the event rather than clearing it), and deleting the event
 *     takes the conference with it.
 *   - There is nothing to write into the event description. Google Calendar
 *     renders a native "Join with Google Meet" control on the event itself,
 *     so the `Video call (Zoom): <url>` line Zoom needs on CalDAV has no
 *     counterpart here. That matters practically: the link does not exist
 *     until the insert RESPONDS, so a description line would cost a second
 *     write to patch it back in.
 *
 * Everything here is pure. The proxy call itself stays in the booking core,
 * which owns the connection; this module only builds the request fragment and
 * reads the answer. It never throws: a Meet hiccup must degrade to "no video
 * link", never to a failed booking, exactly the contract Zoom carries.
 *
 * Two things the booking core must get right, which this module cannot
 * enforce on its own:
 *
 *   - **A rejected conference fails the whole insert.** Google answers 400
 *     ("Invalid conference type value") when the target calendar does not
 *     allow `hangoutsMeet`, and that is the SAME request that creates the
 *     appointment. So the core sends the Meet insert through the
 *     status-returning proxy and, on a 4xx, retries the insert once with no
 *     conference at all. Losing the video link is the acceptable outcome;
 *     losing the booking is not.
 *   - **The link only reaches the customer through our own channels.**
 *     Nothing in this repo sets `sendUpdates`, and Google's default is not
 *     `all`, so there is no invitation email carrying the link for us. The
 *     confirmation message, the confirmation email and the manage page are
 *     the delivery path, which is why reading the link back below is
 *     load-bearing rather than cosmetic.
 */

/**
 * The only conference solution we ask for. Google also accepts
 * `addOn`/`eventHangout` values, which are legacy or third-party and would
 * not produce a Meet link.
 */
export const MEET_CONFERENCE_SOLUTION = "hangoutsMeet" as const;

/** Sent as `?conferenceDataVersion=1`, the opt-in that makes Google read the conference block at all. */
export const MEET_CONFERENCE_DATA_VERSION = "1" as const;

export type MeetConferenceRequest = {
  createRequest: {
    requestId: string;
    conferenceSolutionKey: { type: typeof MEET_CONFERENCE_SOLUTION };
  };
};

/**
 * The `conferenceData` fragment for an event insert.
 *
 * `requestId` is Google's idempotency key: repeating one on the SAME event
 * returns the existing conference instead of minting a second one, so it must
 * be unique per booking attempt. Callers pass the booking's dedupe claim id,
 * which is already unique per attempt and already on hand.
 */
export function buildMeetConferenceRequest(requestId: string): MeetConferenceRequest {
  return {
    createRequest: {
      requestId,
      conferenceSolutionKey: { type: MEET_CONFERENCE_SOLUTION }
    }
  };
}

type MeetEntryPoint = { entryPointType?: unknown; uri?: unknown };

type GoogleEventBody = {
  hangoutLink?: unknown;
  conferenceData?: {
    entryPoints?: unknown;
    createRequest?: { status?: { statusCode?: unknown } | null } | null;
  } | null;
};

/**
 * The Meet join URL on a Google Calendar event body, or null when it is not
 * there yet (or at all).
 *
 * `hangoutLink` is the documented top-level shortcut and is what a settled
 * conference always carries. The `entryPoints` fallback covers the shape
 * where the conference is attached but the shortcut has not been populated,
 * and deliberately takes only `entryPointType === "video"`: the same array
 * also holds `phone` dial-in entries and an `more` info page, and handing a
 * customer a phone URI in place of a video link is worse than handing them
 * nothing.
 */
export function extractMeetJoinUrl(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const event = body as GoogleEventBody;

  if (typeof event.hangoutLink === "string" && event.hangoutLink.length > 0) {
    return event.hangoutLink;
  }

  const entryPoints = event.conferenceData?.entryPoints;
  if (!Array.isArray(entryPoints)) return null;
  for (const raw of entryPoints) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as MeetEntryPoint;
    if (entry.entryPointType !== "video") continue;
    if (typeof entry.uri === "string" && entry.uri.length > 0) return entry.uri;
  }
  return null;
}

/**
 * Whether Google is still working on the conference.
 *
 * `conferenceData.createRequest.status.statusCode` is `pending` while Google
 * provisions, `success` once it is done, and `failure` when it gave up. A
 * pending insert response can carry no link yet, which is the ONLY case worth
 * a second read: `failure` will never produce one, and a settled `success`
 * already gave us the link above.
 */
export function meetConferencePending(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const status = (body as GoogleEventBody).conferenceData?.createRequest?.status?.statusCode;
  return status === "pending";
}

/**
 * The Meet join URL for a just-inserted event, re-reading ONCE if Google
 * answered with a still-pending conference.
 *
 * One retry, never a loop: the booking is already confirmed by the time we
 * get here, so the only thing at stake is whether the confirmation message
 * carries a link. Spending a customer's wait on polling for it is the wrong
 * trade, and a caller that gets null still has a real appointment on a real
 * calendar with the Meet control rendered on the event itself.
 *
 * `reread` may throw or return anything; failures degrade to null.
 */
export async function resolveMeetJoinUrl(
  insertBody: unknown,
  reread: () => Promise<unknown>
): Promise<string | null> {
  const direct = extractMeetJoinUrl(insertBody);
  if (direct) return direct;
  if (!meetConferencePending(insertBody)) return null;

  try {
    return extractMeetJoinUrl(await reread());
  } catch {
    return null;
  }
}
