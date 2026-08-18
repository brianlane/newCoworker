/**
 * Cancellation-waitlist fill: when an appointment slot FREES UP (a cancel,
 * a reschedule vacating its old start, or an off-platform cancellation
 * observed by the calendar poll / Vagaro webhook), offer it to the oldest
 * matching waitlist entry over SMS, one candidate at a time.
 *
 * The real-life contract this encodes: "I'll let you know if I have a
 * cancellation." The customer joined the waitlist through the
 * calendar_join_waitlist coworker tool (or the booking page opt-in); a
 * freed slot earlier than what they hold triggers ONE text with a TTL
 * hold. Reply handling rides the normal texting-coworker conversation: a
 * pending offer is surfaced to the model as a preamble line
 * (`pendingWaitlistOfferLine`, consumed by
 * /api/internal/contact-booking-context), and acceptance runs the existing
 * calendar_reschedule_appointment / calendar_book_appointment tools.
 *
 * Idempotence and races (freed slots are observed repeatedly, the
 * calendar poll re-lists a cancellation for its whole lookback):
 *  - a live OFFERED row for the same slot short-circuits before any
 *    provider call (one pending offer per slot);
 *  - `last_offered_start_at` keeps a lapsed offer from bouncing back to
 *    the same person (the sweep hands it to the NEXT candidate);
 *  - `markWaitlistOffered` is compare-and-set on status, so two racing
 *    observers cannot double-text one entry;
 *  - the slot is re-verified against live provider availability right
 *    before the text, so a re-taken slot is never offered.
 *
 * EVERYTHING here is best-effort by contract: a waitlist failure must
 * never affect the cancel/reschedule/poll result that triggered it.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  resolveCalendarConnection,
  type ResolvedVoiceConnection
} from "@/lib/voice-tools/connections";
import {
  formatBookingStartLocal,
  getWorkspaceBusyBlocks,
  resolveToolTimezone
} from "@/lib/calendar-tools/handlers";
import { isLedgerSlotOpen } from "@/lib/calendar-tools/booking-dedupe";
import { getCaldavBusyBlocks } from "@/lib/calendar-tools/caldav";
import { findVagaroSlots } from "@/lib/calendar-tools/vagaro";
import { findAcuitySlots } from "@/lib/calendar-tools/acuity";
import { digitsOf, phoneDigitsMatch } from "@/lib/calendar-tools/phone-match";
import { cancelWaitlistForAttendee } from "@/lib/calendar-tools/waitlist-resolve";
import {
  findLiveWaitlistEntriesForAttendee,
  getWaitlistSettings,
  listExpiredWaitlistOffers,
  listLapsedWaitlistEntries,
  listLiveWaitlistEntries,
  markWaitlistOffered,
  revertWaitlistOfferToWaiting,
  setWaitlistStatus,
  type BookingWaitlistRow
} from "@/lib/db/booking-waitlist";
import { getBusiness } from "@/lib/db/businesses";
import { getContactLanguage } from "@/lib/db/contact-language";
import { checkSmsOptOut } from "@/lib/sms/opt-outs";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** sms_outbound_log source tag for offer texts (renders in Text history). */
export const WAITLIST_OFFER_SMS_SOURCE = "waitlist_offer";

/**
 * Candidates tried per freed slot. Bounds provider verification calls; in
 * practice the first waiting candidate takes the offer or the slot is gone.
 */
export const WAITLIST_OFFER_CANDIDATE_CAP = 3;

export type WaitlistFillDeps = {
  /** Injectable service client (tests). */
  client?: SupabaseClient;
  /** Injectable connection resolver (tests). */
  resolveConnection?: typeof resolveCalendarConnection;
  /** Platform-mode slot check (no calendar connected). */
  isLedgerSlotOpen?: typeof isLedgerSlotOpen;
  /** Injectable workspace free/busy fetch (tests). */
  getBusyBlocks?: typeof getWorkspaceBusyBlocks;
  /** Injectable CalDAV busy fetch (tests). */
  getCaldavBusy?: typeof getCaldavBusyBlocks;
  /** Injectable Vagaro slot search (tests). */
  findVagaro?: typeof findVagaroSlots;
  /** Injectable Acuity availability search (tests). */
  findAcuity?: typeof findAcuitySlots;
  /** Injectable timezone resolution (tests). */
  resolveTimezone?: typeof resolveToolTimezone;
  /** Injectable business read (tests). */
  getBusinessRow?: typeof getBusiness;
  /** Injectable contact-language read (tests). */
  getLanguage?: typeof getContactLanguage;
  /** Injectable opt-out check (tests). */
  checkOptOut?: typeof checkSmsOptOut;
  /** Injectable Telnyx config resolver (tests). */
  getMessaging?: typeof getTelnyxMessagingForBusiness;
  /** Injectable SMS send (tests). */
  sendSms?: typeof sendTelnyxSms;
  /** Injectable clock (tests). */
  now?: () => Date;
};

export type OfferFreedSlotOutcome =
  | "offered"
  | "skipped_disabled"
  | "skipped_invalid"
  | "skipped_past"
  | "no_candidates"
  | "slot_already_offered"
  | "slot_not_open"
  | "offer_failed";

/**
 * The offer text, in the customer's language. Plain sentences, under 300
 * chars, and NEVER an em dash (repo writing rule). `hasBooking` switches
 * "move your appointment" vs "book it for you".
 */
export function waitlistOfferSmsBody(opts: {
  businessName: string;
  startLocal: string;
  ttlMinutes: number;
  hasBooking: boolean;
  language: "en" | "es";
}): string {
  if (opts.language === "es") {
    const action = opts.hasBooking
      ? "le cambiamos su cita a ese horario"
      : "la reservamos para usted";
    return (
      `Buenas noticias de ${opts.businessName}: se abrió un horario más temprano, ` +
      `${opts.startLocal}. Responda SÍ en los próximos ${opts.ttlMinutes} minutos y ` +
      `${action}. Si no le interesa, ignore este mensaje.`
    );
  }
  const action = opts.hasBooking
    ? "we will move your appointment to it"
    : "we will book it for you";
  return (
    `Good news from ${opts.businessName}: an earlier appointment time just opened up, ` +
    `${opts.startLocal}. Reply YES in the next ${opts.ttlMinutes} minutes and ${action}. ` +
    `Not interested? Just ignore this text.`
  );
}

/**
 * Is [startMs, endMs) actually open on the connected calendar right now?
 * The freed-slot observation may be minutes old (poll lookback) or already
 * re-taken; never text an offer for a slot that is gone.
 *
 * Fail CLOSED: any provider trouble answers false, a missed offer is a
 * nuisance, a false offer is a broken promise.
 *
 * Calendly answers true by design: link-mode acceptance sends the customer
 * through Calendly's own page, which enforces availability itself.
 */
export async function verifyFreedSlotOpen(
  businessId: string,
  conn: ResolvedVoiceConnection,
  startMs: number,
  endMs: number,
  deps: WaitlistFillDeps = {}
): Promise<boolean> {
  try {
    if (conn.provider === "calendly") return true;
    const windowStart = new Date(startMs);
    const windowEnd = new Date(endMs);
    if (conn.provider === "vagaro" || conn.provider === "acuity") {
      const durationMinutes = Math.max(1, Math.round((endMs - startMs) / 60_000));
      const find =
        conn.provider === "vagaro"
          ? (deps.findVagaro ?? findVagaroSlots)
          : (deps.findAcuity ?? findAcuitySlots);
      // The business timezone, NOT a hardcoded UTC. This is load-bearing for
      // Acuity: its availability is keyed by LOCAL CALENDAR DATE, so asking
      // in the wrong zone asks about the wrong day for any merchant outside
      // UTC, the freed slot never appears, and the check fails closed,
      // silently swallowing a waitlist offer that should have gone out.
      // Cosmetic for Vagaro (range-scoped search, the zone only labels the
      // response), but both paths agreeing with findCalendarSlots is the
      // point. resolveToolTimezone never throws; it degrades to UTC.
      const timezone = await (deps.resolveTimezone ?? resolveToolTimezone)(businessId, undefined);
      const found = await find(businessId, {
        windowStart,
        windowEnd,
        durationMinutes,
        timezone
      });
      const slots = ((found.data ?? {}) as { slots?: Array<{ startIso?: string }> }).slots ?? [];
      return found.ok && slots.some((s) => Date.parse(s.startIso ?? "") === startMs);
    }
    if (conn.provider === "caldav") {
      const res = await (deps.getCaldavBusy ?? getCaldavBusyBlocks)(
        businessId,
        windowStart,
        windowEnd
      );
      if (!res.ok) return false;
      return res.busy.every((b) => b.end.getTime() <= startMs || b.start.getTime() >= endMs);
    }
    const busy = await (deps.getBusyBlocks ?? getWorkspaceBusyBlocks)(
      businessId,
      conn,
      windowStart,
      windowEnd
    );
    if (busy === null) return false;
    // Same rule as the null case: an incomplete read cannot prove a slot is
    // free, and this path only ever offers a slot it believes is free.
    if (!busy.complete) return false;
    return busy.busy.every((b) => b.end.getTime() <= startMs || b.start.getTime() >= endMs);
  } catch (err) {
    logger.warn("waitlist-fill: slot verification failed (treating as taken)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}

/**
 * Send the offer text through the metered customer-facing SMS path
 * (monthly cap + throttle apply; STOP list checked fail-closed) and log it
 * to sms_outbound_log so the thread shows it. True only when the text
 * actually went out.
 */
async function sendOfferSms(
  businessId: string,
  entry: BookingWaitlistRow,
  body: string,
  deps: WaitlistFillDeps
): Promise<boolean> {
  try {
    const optOut = await (deps.checkOptOut ?? checkSmsOptOut)(businessId, entry.phone);
    if (!optOut.ok || optOut.optedOut) return false;
    const config = await (deps.getMessaging ?? getTelnyxMessagingForBusiness)(
      businessId,
      undefined,
      { resolveRcs: true }
    );
    const { id: messageId, channel } = await (deps.sendSms ?? sendTelnyxSms)(
      config,
      entry.phone,
      body,
      { meterBusinessId: businessId }
    );
    try {
      const db = deps.client ?? (await createSupabaseServiceClient());
      await db.from("sms_outbound_log").insert({
        business_id: businessId,
        to_e164: entry.phone,
        from_e164: config.fromE164 ?? null,
        body,
        source: WAITLIST_OFFER_SMS_SOURCE,
        run_id: null,
        flow_id: null,
        telnyx_message_id: messageId,
        channel
      });
    } catch (logErr) {
      logger.error("waitlist-fill: outbound log insert failed", {
        businessId,
        error: logErr instanceof Error ? logErr.message : String(logErr)
      });
    }
    return true;
  } catch (err) {
    logger.warn("waitlist-fill: offer SMS failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}

/** The attendee whose action freed the slot (never offered their own slot). */
export type WaitlistOfferExclusion = {
  phones: string[];
  email?: string | null;
};

function matchesExclusion(entry: BookingWaitlistRow, exclude: WaitlistOfferExclusion): boolean {
  const entryDigits = digitsOf(entry.phone);
  if (
    entryDigits.length > 0 &&
    exclude.phones.some((p) => {
      const d = digitsOf(p);
      return d.length > 0 && phoneDigitsMatch(entryDigits, d);
    })
  ) {
    return true;
  }
  const excludeEmail = exclude.email?.trim().toLowerCase() || null;
  return excludeEmail !== null && (entry.email ?? "") === excludeEmail;
}

/** Waiting entries eligible for a slot starting at `startMs`, oldest first. */
export function eligibleWaitlistCandidates(
  entries: BookingWaitlistRow[],
  startMs: number,
  exclude?: WaitlistOfferExclusion
): BookingWaitlistRow[] {
  return entries.filter((e) => {
    if (e.status !== "waiting") return false;
    // The person who just canceled/moved this very slot must never be
    // texted an offer for it (Bugbot Medium on PR #903).
    if (exclude && matchesExclusion(e, exclude)) return false;
    if (Date.parse(e.earliest_at) > startMs) return false;
    if (e.latest_at !== null && Date.parse(e.latest_at) < startMs) return false;
    if (
      e.current_booking_start_at !== null &&
      Date.parse(e.current_booking_start_at) <= startMs
    ) {
      return false;
    }
    if (e.last_offered_start_at !== null && Date.parse(e.last_offered_start_at) === startMs) {
      return false;
    }
    return true;
  });
}

/**
 * A slot just freed at `freedStartIso`, offer it to the best candidate.
 * The slot END is derived per candidate (start + their duration), so the
 * caller never needs to know the canceled event's length.
 */
export async function offerFreedSlot(
  businessId: string,
  freedStartIso: string,
  deps: WaitlistFillDeps = {},
  exclude?: WaitlistOfferExclusion
): Promise<OfferFreedSlotOutcome> {
  try {
    const now = deps.now?.() ?? new Date();
    const startMs = Date.parse(freedStartIso);
    if (!Number.isFinite(startMs)) return "skipped_invalid";
    if (startMs <= now.getTime()) return "skipped_past";

    const settings = await getWaitlistSettings(businessId, deps.client);
    if (!settings.enabled) return "skipped_disabled";

    const entries = await listLiveWaitlistEntries(businessId, deps.client);
    if (entries.length === 0) return "no_candidates";

    // One pending offer per slot: while somebody holds it, nobody else is
    // texted about it (the sweep re-runs this after the hold lapses).
    const held = entries.some(
      (e) =>
        e.status === "offered" &&
        e.offered_start_at !== null &&
        Date.parse(e.offered_start_at) === startMs
    );
    if (held) return "slot_already_offered";

    const candidates = eligibleWaitlistCandidates(entries, startMs, exclude);
    if (candidates.length === 0) return "no_candidates";

    // No calendar connected is PLATFORM mode, not "no calendar": the
    // booking ledger is that tenant's calendar of record, so the slot is
    // verified against it instead of refusing to offer at all (which
    // silently switched the waitlist off for every ledger-only business).
    const conn = await (deps.resolveConnection ?? resolveCalendarConnection)(businessId);

    const business = await (deps.getBusinessRow ?? getBusiness)(businessId);
    const businessName = business?.name?.trim() || "the business";
    const timezone = await resolveToolTimezone(businessId, business?.timezone ?? undefined);
    const startLocal = formatBookingStartLocal(new Date(startMs).toISOString(), timezone);

    let anyVerified = false;
    for (const entry of candidates.slice(0, WAITLIST_OFFER_CANDIDATE_CAP)) {
      const endMs = startMs + entry.duration_minutes * 60_000;
      let open: boolean;
      if (conn) {
        open = await verifyFreedSlotOpen(businessId, conn, startMs, endMs, deps);
      } else {
        const checkLedger = deps.isLedgerSlotOpen ?? isLedgerSlotOpen;
        open = await checkLedger(businessId, startMs, endMs);
      }
      // Verification is per-candidate because durations differ: the freed
      // start can be closed for a 60-minute request yet open for the next
      // candidate's 30 minutes, so a failed check moves on rather than
      // dropping shorter candidates (Bugbot Medium on PR #903). The
      // candidate cap bounds the provider calls either way.
      if (!open) continue;
      anyVerified = true;

      const claimed = await markWaitlistOffered(
        entry.id,
        {
          startIso: new Date(startMs).toISOString(),
          endIso: new Date(endMs).toISOString(),
          expiresAtIso: new Date(
            now.getTime() + settings.offerTtlMinutes * 60_000
          ).toISOString()
        },
        deps.client
      );
      // Lost the compare-and-set (a racing observer offered this entry
      // something already), try the next candidate.
      if (!claimed) continue;

      let language: "en" | "es" = "en";
      try {
        const lang = await (deps.getLanguage ?? getContactLanguage)(businessId, entry.phone);
        if (lang.preferred_language === "es") language = "es";
      } catch {
        // Language read trouble degrades to English.
      }
      const body = waitlistOfferSmsBody({
        businessName,
        startLocal,
        ttlMinutes: settings.offerTtlMinutes,
        hasBooking: entry.current_booking_start_at !== null,
        language
      });
      const sent = await sendOfferSms(businessId, entry, body, deps);
      if (sent) return "offered";
      // They never saw the offer: put them back in line with the slot
      // memory cleared so a later observation may text them again.
      await revertWaitlistOfferToWaiting(entry.id, { clearLastOffered: true }, deps.client);
    }
    return anyVerified ? "offer_failed" : "slot_not_open";
  } catch (err) {
    logger.warn("waitlist-fill: offerFreedSlot failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return "offer_failed";
  }
}

/**
 * One OBSERVED off-platform cancellation (the calendar poll's canceled
 * scan): treat the canceled customer exactly like the platform cancel core
 * does, their own live entries drop FIRST, and the freed slot is offered
 * with them excluded, so a poll-observed cancel can never text the person
 * who freed the slot (Bugbot Medium on PR #903). With no derivable
 * identity the offer simply runs unexcluded. Never throws.
 */
export async function handleObservedCancellation(
  businessId: string,
  freedStartIso: string,
  attendee?: WaitlistOfferExclusion,
  deps: WaitlistFillDeps = {}
): Promise<OfferFreedSlotOutcome> {
  const identity =
    attendee && (attendee.phones.length > 0 || (attendee.email ?? null) !== null)
      ? { phones: attendee.phones, email: attendee.email ?? null }
      : undefined;
  if (identity) {
    await cancelWaitlistForAttendee(businessId, identity);
  }
  return offerFreedSlot(businessId, freedStartIso, deps, identity);
}

export type WaitlistSweepResult = {
  lapsedEntries: number;
  expiredOffers: number;
  reoffered: number;
};

/**
 * Periodic maintenance (rides the ~1/min calendar-poll internal route):
 *  1. live entries whose window of interest passed (their linked booking
 *     started, or latest_at lapsed) become `expired`;
 *  2. offered rows whose hold lapsed revert to `waiting` and their slot is
 *     re-offered to the next candidate (verification inside offerFreedSlot
 *     drops slots that were re-taken meanwhile).
 */
export async function sweepWaitlist(deps: WaitlistFillDeps = {}): Promise<WaitlistSweepResult> {
  const result: WaitlistSweepResult = { lapsedEntries: 0, expiredOffers: 0, reoffered: 0 };
  const now = deps.now?.() ?? new Date();
  try {
    const lapsed = await listLapsedWaitlistEntries(now.toISOString(), deps.client);
    for (const entry of lapsed) {
      await setWaitlistStatus(entry.id, "expired", deps.client);
      result.lapsedEntries += 1;
      // A lapsing row can be HOLDING a live offer; its slot must pass to
      // the next candidate rather than silently strand once the cancel
      // observation's lookback has passed (Bugbot High on PR #903).
      if (entry.status === "offered" && entry.offered_start_at !== null) {
        const outcome = await offerFreedSlot(entry.business_id, entry.offered_start_at, deps);
        if (outcome === "offered") result.reoffered += 1;
      }
    }
  } catch (err) {
    logger.warn("waitlist-fill: lapsed-entry sweep failed", {
      error: err instanceof Error ? err.message : String(err)
    });
  }
  try {
    const expired = await listExpiredWaitlistOffers(now.toISOString(), deps.client);
    for (const entry of expired) {
      await revertWaitlistOfferToWaiting(entry.id, {}, deps.client);
      result.expiredOffers += 1;
      // Hand the still-free slot to the next candidate. The lapsed holder
      // is excluded by last_offered_start_at.
      if (entry.offered_start_at !== null) {
        const outcome = await offerFreedSlot(entry.business_id, entry.offered_start_at, deps);
        if (outcome === "offered") result.reoffered += 1;
      }
    }
  } catch (err) {
    logger.warn("waitlist-fill: expired-offer sweep failed", {
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return result;
}

/**
 * Model-facing preamble line for a contact's PENDING waitlist offer, so
 * the texting/voice coworker understands a "YES" reply and completes the
 * move with the calendar tools. Null when the contact holds no live offer.
 * Consumed by /api/internal/contact-booking-context alongside the booking
 * status line. Fails open to null.
 */
export async function pendingWaitlistOfferLine(
  businessId: string,
  phone: string,
  timezone: string | null,
  deps: WaitlistFillDeps = {}
): Promise<string | null> {
  try {
    const now = deps.now?.() ?? new Date();
    const entries = await findLiveWaitlistEntriesForAttendee(
      businessId,
      { phones: [phone] },
      deps.client
    );
    const offer = entries.find(
      (e) =>
        e.status === "offered" &&
        e.offered_start_at !== null &&
        e.offer_expires_at !== null &&
        Date.parse(e.offer_expires_at) > now.getTime()
    );
    if (!offer) return null;
    const tz = timezone?.trim() || "UTC";
    const startLocal = formatBookingStartLocal(offer.offered_start_at!, tz);
    const action = offer.current_booking_start_at
      ? "move their existing appointment to that slot with calendar_reschedule_appointment"
      : "book that slot for them with calendar_book_appointment";
    return (
      `This contact has a PENDING waitlist offer: they were texted that an earlier ` +
      `appointment slot at ${startLocal} opened up. If they accept (YES or similar), ` +
      `${action} using start time ${offer.offered_start_at} and their duration of ` +
      `${offer.duration_minutes} minutes. If they decline, leave everything as is and ` +
      `do not re-offer the slot.`
    );
  } catch (err) {
    logger.warn("waitlist-fill: pending-offer line failed (answering none)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
