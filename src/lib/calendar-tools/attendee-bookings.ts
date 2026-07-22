/**
 * ONE provider-neutral answer to "does this attendee have an upcoming
 * booking with this business?" — the lookup that used to be implemented
 * three separate times (the AiFlow booking precheck, the SMS booking-status
 * preamble, and the dedupe ledger's upcoming-claim reads), each with its own
 * Calendly/Vagaro matching code, while the booking core consulted none of
 * them (the Truly double-booking of Jul 21 2026: a second appointment booked
 * minutes after the first, nothing in the write path able to see the first).
 *
 * Two layers:
 *
 *  - `lookupProviderBookingsForAttendee` — the connected provider's
 *    OFF-PLATFORM visibility, via a per-provider adapter registered in
 *    `ATTENDEE_BOOKING_LOOKUPS`. Calendly and Vagaro take bookings outside
 *    the platform (calendly.com, the merchant's own Vagaro book), so they
 *    need real adapters; Google/Microsoft/CalDAV only ever gain bookings
 *    through our booking core, so they are registered `ledger_only` — an
 *    EXPLICIT statement, so the registry parity test can tell "deliberate"
 *    from "forgot to wire the new provider".
 *
 *  - `findUpcomingBookingsForAttendee` — the full picture: the
 *    provider-neutral `calendar_booking_dedupe` ledger first (covers every
 *    platform-created booking on any provider, plus Vagaro's webhook-synced
 *    off-platform rows), then the provider adapter. This is what the booking
 *    core's duplicate guard consumes.
 *
 * Adding a calendar provider? Register it here (adapter or `ledger_only`)
 * or `tests/calendar-attendee-bookings.test.ts` fails your PR.
 *
 * Adapter modes (both preserved verbatim from the consumers this module was
 * extracted from, so the per-turn API budget did not change):
 *
 *  - `existence` (the precheck's shape): email known → ONE
 *    `invitee_email`-narrowed listing (`count=1`, an email-narrowed event IS
 *    a match, no invitee fetch); miss → full listing + budgeted invitee
 *    fetches matched on SMS-reminder numbers.
 *  - `detail` (the booking-context's shape): ONE listing (email-narrowed
 *    when the email is known — no phone-listing fallback), invitees always
 *    fetched so the result carries the event name and reschedule lineage
 *    (`old_invitee`).
 *
 * Failure contract: transport refusals (a null transport response) surface
 * as `{ ok: false, reason: "refused" }`; a missing provider connection as
 * `{ ok: false, reason: "not_connected" }`. Adapter functions may THROW on
 * unexpected trouble (e.g. a Vagaro listing exploding) — each consumer
 * catches with its own established fail-open logging, and
 * `findUpcomingBookingsForAttendee` catches for the booking guard.
 */
import {
  resolveCalendarConnection,
  CALENDLY_DIRECT_KEY,
  type ResolvedVoiceConnection
} from "@/lib/voice-tools/connections";
import { calendlyRequest, type CalendlyRequestConfig } from "@/lib/calendar-tools/calendly";
import {
  getActiveCalendlyConnectionUserUri,
  setCalendlyConnectionUserUri
} from "@/lib/db/calendly-connections";
import { digitsOf, phoneDigitsMatch } from "@/lib/calendar-tools/phone-match";
import {
  bookingAttendeeKey,
  findUpcomingBookingClaim,
  findUpcomingBookingClaimByPhone
} from "@/lib/calendar-tools/booking-dedupe";
import { getActiveVagaroConnection } from "@/lib/db/vagaro-connections";
import { listVagaroAppointments } from "@/lib/vagaro/client";
import { calendlyEventUuid } from "@/lib/ai-flows/calendly-poll";
import { logger } from "@/lib/logger";

/** Upcoming events scanned per Calendly listing. */
export const ATTENDEE_BOOKING_EVENT_SCAN = 25;
/** Per-lookup cap on Calendly invitee fetches. */
export const ATTENDEE_BOOKING_INVITEE_FETCH_CAP = 10;
/** How far ahead a booking's start may be and still count. */
export const ATTENDEE_BOOKING_HORIZON_DAYS = 90;

/** The attendee's identities, as every consumer already gathers them. */
export type AttendeeIdentifiers = {
  /** Phone numbers — E.164 or bare digits (matching is digit-based and
   * country-code-tolerant either way). */
  phones: string[];
  /** Lower-cased email, when known. */
  email: string | null;
  /** Display name — ledger fallback key only, never used to match provider data. */
  name?: string | null;
};

export type UpcomingAttendeeBooking = {
  /** Which source reported it ("ledger" = the platform booking ledger). */
  provider: "ledger" | "calendly" | "vagaro";
  /** Platform-created / ledger-synced vs discovered on the provider. */
  source: "platform" | "external";
  /** Provider event id; null when the source carries no stable id. */
  eventId: string | null;
  /** Event start (ISO). Empty string when the provider omitted it (the
   * precheck's email fast path trusts the narrowed listing without needing
   * the start). */
  startIso: string;
  /** Event/service name when the provider carries one. */
  name: string | null;
  /** Calendly lineage: this booking replaced an earlier (rescheduled) one.
   * Only populated when the lookup fetched invitees (detail mode / the
   * existence phone path). */
  rescheduled: boolean;
};

export type AttendeeBookingLookupResult =
  | { ok: true; bookings: UpcomingAttendeeBooking[] }
  | { ok: false; reason: "refused" | "not_connected" };

/** Injectable transports/caches — the same seams the precheck exposed. */
export type AttendeeBookingDeps = {
  /** Injectable Calendly transport (tests). */
  request?: (
    businessId: string,
    conn: ResolvedVoiceConnection,
    config: CalendlyRequestConfig
  ) => Promise<{ data: unknown } | null>;
  /** Injectable connection resolver (tests). */
  resolveConnection?: (businessId: string) => Promise<ResolvedVoiceConnection | null>;
  /** Injectable user-URI cache reads/writes (tests). */
  getCachedUserUri?: (businessId: string) => Promise<string | null>;
  persistUserUri?: (businessId: string, userUri: string) => Promise<void>;
  /** Injectable Vagaro connection lookup (tests). */
  getVagaroConnection?: typeof getActiveVagaroConnection;
  /** Injectable Vagaro appointments listing (tests). */
  listAppointments?: typeof listVagaroAppointments;
  /** Injectable ledger reads (tests). */
  findLedgerClaim?: typeof findUpcomingBookingClaim;
  findLedgerClaimByPhone?: typeof findUpcomingBookingClaimByPhone;
};

export type AttendeeBookingLookupOptions = {
  /** Lookup shape — see the module doc. Defaults to `existence`. */
  mode?: "existence" | "detail";
  /**
   * Shared invitee-fetch budget. Callers that run FURTHER provider scans in
   * the same turn (the booking-context's canceled scan) pass their own
   * budget object so the combined turn stays within one cap.
   */
  budget?: { remaining: number };
  /**
   * A Calendly user URI the caller already resolved this turn — skips the
   * adapter's own (cached) resolution so a turn never pays the /users/me
   * probe twice.
   */
  calendlyUserUri?: string;
};

/**
 * Resolve the connected Calendly account's user URI, preferring the cached
 * value on the direct-PAT connection row (poller parity — saves the
 * /users/me probe). Null when the transport refuses. Moved here from the
 * booking precheck so every consumer shares the cache discipline; the log
 * messages keep their historical "booking precheck:" prefix (production log
 * continuity + the precheck suite pins them).
 */
export async function resolveCalendlyUserUri(
  businessId: string,
  conn: ResolvedVoiceConnection,
  request: NonNullable<AttendeeBookingDeps["request"]>,
  getCachedUserUri: NonNullable<AttendeeBookingDeps["getCachedUserUri"]>,
  persistUserUri: NonNullable<AttendeeBookingDeps["persistUserUri"]>
): Promise<string | null> {
  const cacheable = conn.providerConfigKey === CALENDLY_DIRECT_KEY;
  if (cacheable) {
    try {
      const cached = await getCachedUserUri(businessId);
      if (cached) return cached;
    } catch (err) {
      logger.warn("booking precheck: user-uri cache read failed", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  const res = await request(businessId, conn, { endpoint: "/users/me", method: "GET" });
  const uri = (res?.data as { resource?: { uri?: string } } | undefined)?.resource?.uri;
  if (typeof uri !== "string" || uri.length === 0) return null;
  if (cacheable) {
    try {
      await persistUserUri(businessId, uri);
    } catch (err) {
      logger.warn("booking precheck: user-uri cache write failed", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return uri;
}

type ListedCalendlyEvent = { uri: string; name: string; start_time: string };

type ListedCalendlyInvitee = {
  status?: string;
  email?: string;
  text_reminder_number?: string;
  rescheduled?: boolean;
  old_invitee?: string | null;
};

/**
 * Whether an invitee is this attendee: exact (case-insensitive) email or a
 * country-code-tolerant SMS-reminder number. Canceled invitees never match
 * — a canceled invitee on an active event is someone who moved away from it.
 */
export function calendlyInviteeMatchesAttendee(
  invitee: ListedCalendlyInvitee,
  ids: AttendeeIdentifiers
): boolean {
  if (invitee?.status === "canceled") return false;
  const inviteeEmail = (invitee.email ?? "").trim().toLowerCase();
  if (ids.email && inviteeEmail && inviteeEmail === ids.email) return true;
  const inviteeDigits =
    typeof invitee.text_reminder_number === "string" ? digitsOf(invitee.text_reminder_number) : "";
  return (
    inviteeDigits.length > 0 &&
    ids.phones.some((p) => {
      const d = digitsOf(p);
      return d.length > 0 && phoneDigitsMatch(inviteeDigits, d);
    })
  );
}

function upcomingWindow(nowMs: number): { minIso: string; maxIso: string } {
  return {
    minIso: new Date(nowMs).toISOString(),
    maxIso: new Date(nowMs + ATTENDEE_BOOKING_HORIZON_DAYS * 24 * 60 * 60_000).toISOString()
  };
}

function calendlyBooking(
  event: { uri: string; name?: string; start_time?: string },
  rescheduled: boolean
): UpcomingAttendeeBooking {
  return {
    provider: "calendly",
    source: "external",
    eventId: calendlyEventUuid(event.uri),
    startIso: typeof event.start_time === "string" ? event.start_time : "",
    name: typeof event.name === "string" ? event.name : "Appointment",
    rescheduled
  };
}

/**
 * Calendly adapter. See the module doc for the two modes; both are verbatim
 * ports of the consumer they came from, call pattern included.
 */
async function calendlyListUpcomingForAttendee(
  businessId: string,
  conn: ResolvedVoiceConnection,
  ids: AttendeeIdentifiers,
  deps: AttendeeBookingDeps,
  opts: AttendeeBookingLookupOptions
): Promise<AttendeeBookingLookupResult> {
  const request = deps.request ?? calendlyRequest;
  const getCachedUserUri = deps.getCachedUserUri ?? getActiveCalendlyConnectionUserUri;
  const persistUserUri = deps.persistUserUri ?? setCalendlyConnectionUserUri;
  const mode = opts.mode ?? "existence";
  const budget = opts.budget ?? { remaining: ATTENDEE_BOOKING_INVITEE_FETCH_CAP };

  const userUri =
    opts.calendlyUserUri ??
    (await resolveCalendlyUserUri(businessId, conn, request, getCachedUserUri, persistUserUri));
  if (!userUri) return { ok: false, reason: "refused" };

  const { minIso, maxIso } = upcomingWindow(Date.now());
  const listParams: Record<string, string> = {
    user: userUri,
    status: "active",
    sort: "start_time:asc",
    min_start_time: minIso,
    max_start_time: maxIso
  };

  /** Budgeted invitee scan over listed events; first matching event wins. */
  const scanInvitees = async (
    events: Array<{ uri: string; name?: string; start_time?: string }>
  ): Promise<UpcomingAttendeeBooking | "no_match"> => {
    for (const event of events) {
      if (budget.remaining <= 0) break;
      budget.remaining -= 1;
      const invRes = await request(businessId, conn, {
        endpoint: `/scheduled_events/${encodeURIComponent(calendlyEventUuid(event.uri))}/invitees`,
        method: "GET",
        params: { count: "10" }
      });
      // A refused invitee fetch mid-scan degrades to "no match so far".
      if (!invRes) continue;
      const invitees = (
        (invRes.data as { collection?: ListedCalendlyInvitee[] })?.collection ?? []
      ).filter((i): i is ListedCalendlyInvitee => i != null && typeof i === "object");
      const match = invitees.find((i) => calendlyInviteeMatchesAttendee(i, ids));
      if (match) return calendlyBooking(event, Boolean(match.old_invitee));
    }
    return "no_match";
  };

  if (mode === "detail") {
    // ONE listing — email-narrowed when the contact's email is known (no
    // phone-listing fallback: the booking-context's shape), invitees always
    // fetched for the name/lineage. Events need a uri AND a start to be
    // reportable.
    const params: Record<string, string> = {
      ...listParams,
      count: String(ATTENDEE_BOOKING_EVENT_SCAN)
    };
    if (ids.email) params.invitee_email = ids.email;
    const res = await request(businessId, conn, {
      endpoint: "/scheduled_events",
      method: "GET",
      params
    });
    if (!res) return { ok: false, reason: "refused" };
    const listed = ((res.data as { collection?: Array<Partial<ListedCalendlyEvent>> })
      ?.collection ?? []).filter(
      (e): e is ListedCalendlyEvent =>
        typeof e?.uri === "string" &&
        e.uri.length > 0 &&
        typeof e.start_time === "string" &&
        e.start_time.length > 0
    );
    const match = await scanInvitees(listed);
    return { ok: true, bookings: match === "no_match" ? [] : [match] };
  }

  // Existence mode (the precheck's shape).
  // 1) Email fast path: one invitee_email-narrowed listing; a hit needs no
  //    invitee fetch (an email-narrowed event IS this attendee's).
  if (ids.email) {
    const res = await request(businessId, conn, {
      endpoint: "/scheduled_events",
      method: "GET",
      params: { ...listParams, invitee_email: ids.email, count: "1" }
    });
    if (!res) return { ok: false, reason: "refused" };
    const listed = ((res.data as { collection?: Array<{ uri?: string }> })?.collection ?? [])
      .filter((e): e is { uri: string } => typeof e?.uri === "string" && e.uri.length > 0);
    if (listed.length > 0) {
      return { ok: true, bookings: [calendlyBooking(listed[0], false)] };
    }
  }

  // 2) Phone path: scan upcoming events, match invitee SMS numbers.
  if (ids.phones.some((p) => digitsOf(p).length > 0)) {
    const res = await request(businessId, conn, {
      endpoint: "/scheduled_events",
      method: "GET",
      params: { ...listParams, count: String(ATTENDEE_BOOKING_EVENT_SCAN) }
    });
    if (!res) return { ok: false, reason: "refused" };
    const listed = ((res.data as { collection?: Array<{ uri?: string }> })?.collection ?? [])
      .filter((e): e is { uri: string } => typeof e?.uri === "string" && e.uri.length > 0);
    const match = await scanInvitees(listed);
    if (match !== "no_match") return { ok: true, bookings: [match] };
  }

  return { ok: true, bookings: [] };
}

/** Whether a Vagaro appointment belongs to this attendee (same tolerance). */
export function vagaroAppointmentMatchesAttendee(
  item: { customerEmail?: string | null; customerPhone?: string | null },
  ids: AttendeeIdentifiers
): boolean {
  return calendlyInviteeMatchesAttendee(
    {
      email: item.customerEmail ?? undefined,
      text_reminder_number: item.customerPhone ?? undefined
    },
    ids
  );
}

/**
 * Vagaro adapter: one bounded upcoming-appointments listing, matched on the
 * customer's phone (country-code-tolerant) or email, soonest first. May
 * THROW on transport trouble (see the module's failure contract).
 */
async function vagaroListUpcomingForAttendee(
  businessId: string,
  _conn: ResolvedVoiceConnection,
  ids: AttendeeIdentifiers,
  deps: AttendeeBookingDeps
): Promise<AttendeeBookingLookupResult> {
  const getVagaroConnection = deps.getVagaroConnection ?? getActiveVagaroConnection;
  const listAppointments = deps.listAppointments ?? listVagaroAppointments;
  const row = await getVagaroConnection(businessId);
  if (!row) return { ok: false, reason: "not_connected" };
  const nowMs = Date.now();
  const { minIso, maxIso } = upcomingWindow(nowMs);
  const items = await listAppointments(row, { startIso: minIso, endIso: maxIso });
  const bookings = items
    .filter(
      (i) =>
        !i.cancelled &&
        Number.isFinite(Date.parse(i.startIso)) &&
        Date.parse(i.startIso) > nowMs &&
        vagaroAppointmentMatchesAttendee(i, ids)
    )
    .sort((a, b) => Date.parse(a.startIso) - Date.parse(b.startIso))
    .map(
      (i): UpcomingAttendeeBooking => ({
        provider: "vagaro",
        source: "external",
        eventId: i.id || null,
        startIso: i.startIso,
        name: i.serviceName ?? null,
        rescheduled: false
      })
    );
  return { ok: true, bookings };
}

export type AttendeeBookingLookup =
  | {
      kind: "adapter";
      listUpcomingForAttendee: (
        businessId: string,
        conn: ResolvedVoiceConnection,
        ids: AttendeeIdentifiers,
        deps: AttendeeBookingDeps,
        opts: AttendeeBookingLookupOptions
      ) => Promise<AttendeeBookingLookupResult>;
    }
  | {
      /**
       * The provider only ever gains bookings through our booking core, so
       * the platform ledger IS its complete truth — an explicit statement,
       * not a missing adapter.
       */
      kind: "ledger_only";
    };

/**
 * EVERY provider `resolveCalendarConnection` can return must be registered
 * here — adapter for providers that take bookings off-platform, explicit
 * `ledger_only` for providers whose bookings all flow through our core.
 * Pinned by tests/calendar-attendee-bookings.test.ts: adding a provider
 * without deciding its booking-visibility story fails CI.
 */
export const ATTENDEE_BOOKING_LOOKUPS: Record<
  ResolvedVoiceConnection["provider"],
  AttendeeBookingLookup
> = {
  google: { kind: "ledger_only" },
  microsoft: { kind: "ledger_only" },
  caldav: { kind: "ledger_only" },
  calendly: { kind: "adapter", listUpcomingForAttendee: calendlyListUpcomingForAttendee },
  vagaro: { kind: "adapter", listUpcomingForAttendee: vagaroListUpcomingForAttendee }
};

/**
 * The connected provider's OFF-PLATFORM upcoming bookings for this
 * attendee (adapter layer only — no ledger read). Ledger-only providers
 * answer an empty ok (nothing off-platform can exist for them). May THROW
 * (Vagaro transport trouble) — callers own their fail-open handling.
 */
export async function lookupProviderBookingsForAttendee(
  businessId: string,
  conn: ResolvedVoiceConnection,
  ids: AttendeeIdentifiers,
  deps: AttendeeBookingDeps = {},
  opts: AttendeeBookingLookupOptions = {}
): Promise<AttendeeBookingLookupResult> {
  const lookup = ATTENDEE_BOOKING_LOOKUPS[conn.provider];
  if (lookup.kind === "ledger_only") return { ok: true, bookings: [] };
  return lookup.listUpcomingForAttendee(businessId, conn, ids, deps, opts);
}

/**
 * The FULL picture for the booking core's duplicate guard: the platform
 * ledger's soonest upcoming confirmed claim for this attendee (exact key,
 * then phone-tolerant), plus the connected provider's off-platform view.
 * Sorted soonest-first, de-duplicated by event id. Fail-open throughout: a
 * refused/throwing provider lookup or ledger error just narrows the result
 * — callers must treat an empty list as "no duplicate visible", never
 * "proven none".
 */
export async function findUpcomingBookingsForAttendee(
  businessId: string,
  ids: AttendeeIdentifiers,
  deps: AttendeeBookingDeps = {},
  opts: AttendeeBookingLookupOptions = {}
): Promise<UpcomingAttendeeBooking[]> {
  const findLedgerClaim = deps.findLedgerClaim ?? findUpcomingBookingClaim;
  const findLedgerClaimByPhone = deps.findLedgerClaimByPhone ?? findUpcomingBookingClaimByPhone;
  const resolveConnection = deps.resolveConnection ?? resolveCalendarConnection;

  const bookings: UpcomingAttendeeBooking[] = [];

  // 1) Ledger: exact attendee key, then the phone-tolerant fallback. (Both
  //    ledger reads fail open to null internally.)
  const attendeeKey = bookingAttendeeKey(ids.phones[0], ids.email, ids.name);
  let claim = await findLedgerClaim(businessId, attendeeKey);
  if (!claim && ids.phones[0]) {
    claim = await findLedgerClaimByPhone(businessId, ids.phones[0]);
  }
  if (claim) {
    bookings.push({
      provider: "ledger",
      source: "platform",
      eventId: claim.eventId,
      startIso: new Date(claim.startAt).toISOString(),
      name: null,
      rescheduled: false
    });
  }

  // 2) The connected provider's off-platform view (adapter providers only).
  try {
    const conn = await resolveConnection(businessId);
    if (conn) {
      const res = await lookupProviderBookingsForAttendee(businessId, conn, ids, deps, opts);
      if (res.ok) {
        for (const b of res.bookings) {
          const dup = bookings.some((k) => k.eventId != null && k.eventId === b.eventId);
          if (!dup) bookings.push(b);
        }
      }
    }
  } catch (err) {
    logger.warn("attendee bookings: provider lookup failed (fail-open)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  // Unknown starts (the email fast path can answer without one) sort last —
  // a known-time booking is always the more useful thing to surface first.
  const startMs = (b: UpcomingAttendeeBooking) => {
    const ms = Date.parse(b.startIso);
    return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
  };
  return bookings.sort((a, b) => startMs(a) - startMs(b));
}
