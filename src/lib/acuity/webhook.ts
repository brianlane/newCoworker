/**
 * Acuity webhook receiver: turns a delivery into the same effects the
 * ~1/min poller produces, only instantly.
 *
 * Correctness does NOT depend on this module. `src/lib/ai-flows/acuity-poll.ts`
 * already observes every change within about a minute, so webhooks buy
 * latency, not capability. That is why every effect here is best-effort and
 * why a delivery we cannot make sense of is answered 2xx rather than retried:
 * Acuity disables a webhook after 5 days of continuous failure, and losing
 * the fast path over a payload we did not understand would be a bad trade.
 *
 * Three things make this materially different from the Vagaro receiver:
 *
 *   1. THE PAYLOAD IS IDS ONLY. Acuity posts form-urlencoded
 *      `action`/`id`/`calendarID`/`appointmentTypeID` and nothing else, so
 *      every delivery costs one `GET /appointments/:id` to learn what
 *      actually happened. A hydration failure is the ONE case that returns
 *      5xx, because Acuity retries those and the appointment really might
 *      be knowable a moment later.
 *
 *   2. THERE IS NO CUSTOMER EVENT TYPE. Vagaro syncs contacts from a
 *      dedicated `customer` event; Acuity has none, so the contact sync
 *      reads the hydrated appointment's own name/email/phone.
 *
 *   3. CANCELLATION IS NOT IN THE PAYLOAD. `action` can say `changed` for a
 *      cancellation, so the hydrated appointment's own state is trusted over
 *      the action word.
 *
 * The observation shadow is written here too, with the DELIVERY moment,
 * so the webhook and the poller agree about when a change happened and their
 * shared `cal:` dedupe keys collapse double-observation into one flow run.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/acuity/errors";
import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";
import { fireCalendarTriggersForPushedEvent } from "@/lib/ai-flows/calendar-poll";
import { fireBookingGoalsForIdentities } from "@/lib/ai-flows/booking-goal-fire";
import { acuityAppointmentToCalendarEvent } from "@/lib/ai-flows/acuity-poll";
import { getAcuityAppointment, type AcuityAppointmentItem } from "@/lib/acuity/client";
import { recordAcuityObservations } from "@/lib/db/acuity-appointment-state";
import type { AcuityConnectionRow } from "@/lib/db/acuity-connections";
import {
  bookingAttendeeKey,
  deleteBookingClaimsByEvent,
  findBookingClaimStartsByEvent,
  recordExternalBookingClaim
} from "@/lib/calendar-tools/booking-dedupe";
import { offerFreedSlot } from "@/lib/calendar-tools/waitlist-fill";
import {
  cancelWaitlistForAttendee,
  resolveWaitlistAfterBooking
} from "@/lib/calendar-tools/waitlist-resolve";
import {
  createCustomerMemory,
  CustomerExistsError,
  getCustomerMemory,
  updateCustomerOwnerFields
} from "@/lib/customer-memory/db";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";

/** Serialized payload ceiling, mirrors the Vagaro receiver. */
export const ACUITY_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

export type AcuityWebhookEvent = {
  /** `scheduled` | `rescheduled` | `canceled` | `changed`, lowercased. */
  action: string;
  appointmentId: string;
  calendarId: string | null;
  appointmentTypeId: string | null;
  /** The flattened body, for the flow trigger's window text. */
  raw: Record<string, string>;
};

/**
 * Parse Acuity's form-urlencoded delivery.
 *
 * Callers must pass the RAW body string, the same bytes the signature was
 * computed over. Re-serializing a parsed form does not byte-match, so the
 * route reads `await request.text()` before anything else touches the stream.
 */
export function parseAcuityWebhookBody(rawBody: string): AcuityWebhookEvent | null {
  const params = new URLSearchParams(rawBody);
  const appointmentId = params.get("id")?.trim();
  if (!appointmentId) return null;
  const raw: Record<string, string> = {};
  for (const [k, v] of params.entries()) raw[k] = v;
  return {
    action: (params.get("action") ?? "").trim().toLowerCase(),
    appointmentId,
    calendarId: params.get("calendarID")?.trim() || null,
    appointmentTypeId: params.get("appointmentTypeID")?.trim() || null,
    raw
  };
}

export type AcuityWebhookDeps = {
  getDb?: typeof createSupabaseServiceClient;
  hydrate?: typeof getAcuityAppointment;
  recordObservations?: typeof recordAcuityObservations;
  fireGoals?: typeof fireBookingGoalsForIdentities;
  fireTriggers?: typeof fireCalendarTriggersForPushedEvent;
  recordClaim?: typeof recordExternalBookingClaim;
  deleteClaims?: typeof deleteBookingClaimsByEvent;
  claimStarts?: typeof findBookingClaimStartsByEvent;
  offerSlot?: typeof offerFreedSlot;
  cancelWaitlist?: typeof cancelWaitlistForAttendee;
  resolveWaitlist?: typeof resolveWaitlistAfterBooking;
  syncContact?: typeof syncAcuityContact;
  nowMs?: number;
};

export type AcuityWebhookIntelligence = {
  hydrated: boolean;
  /** The hydrated appointment, when we got one. Used to qualify the flow
   * channel's idempotency key: see processAcuityWebhookEvent. */
  appointment?: AcuityAppointmentItem | null;
  goalsFired: number;
  jumpedRuns: number;
  triggerRunsEnqueued: number;
  ledgerSynced: boolean;
  contactSynced: boolean;
};

const NO_INTELLIGENCE: AcuityWebhookIntelligence = {
  hydrated: false,
  appointment: null,
  goalsFired: 0,
  jumpedRuns: 0,
  triggerRunsEnqueued: 0,
  ledgerSynced: false,
  contactSynced: false
};

/** Thrown when hydration fails, so the route can answer 5xx and be retried. */
export class AcuityHydrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcuityHydrationError";
  }
}

/**
 * Create-if-missing, fill-only contact sync from the hydrated appointment.
 *
 * Acuity has no customer event type, so this is the only path by which a
 * walk-in booked on the merchant's own page becomes a contact. Fill-only:
 * an existing contact's owner-edited fields are never overwritten by
 * whatever the customer typed into Acuity.
 */
export async function syncAcuityContact(
  businessId: string,
  appt: AcuityAppointmentItem
): Promise<boolean> {
  const phone = appt.customerPhone?.trim();
  const email = appt.customerEmail?.trim();
  // A contact is keyed by phone; an email-only Acuity booking has nothing to
  // file against, so there is nothing honest to do with it here.
  if (!phone) return false;
  try {
    let existing = await getCustomerMemory(businessId, phone);
    if (!existing) {
      try {
        await createCustomerMemory(businessId, {
          customerE164: phone,
          displayName: appt.customerName,
          email: email ?? null
        });
        return true;
      } catch (err) {
        // Two deliveries for the same brand-new customer can race. The loser
        // falls through to the fill-only update below, but it must RE-READ
        // first: its `existing` snapshot is the pre-race null, and treating
        // that as "the row is blank" would overwrite whatever the winner
        // just wrote.
        if (!(err instanceof CustomerExistsError)) throw err;
        existing = await getCustomerMemory(businessId, phone);
      }
    }
    // Fill-only: never overwrite what the owner has edited with whatever the
    // customer typed into Acuity.
    const patch: { displayName?: string; email?: string } = {};
    if (appt.customerName && !existing?.display_name) patch.displayName = appt.customerName;
    if (email && !existing?.email) patch.email = email;
    if (Object.keys(patch).length === 0) return false;
    await updateCustomerOwnerFields(businessId, phone, patch);
    return true;
  } catch (err) {
    logger.warn("acuity webhook: contact sync failed", {
      businessId,
      appointmentId: appt.id,
      error: errorText(err)
    });
    return false;
  }
}

/**
 * Fill in the real transports for anything the caller did not inject.
 *
 * One place rather than a dozen `??` lines at the top of the function below:
 * the list is long enough that inlining it buried the actual logic, and a
 * single resolver is also the only thing a test has to exercise to prove the
 * production wiring is hooked up.
 */
function resolveDeps(deps: AcuityWebhookDeps): Required<AcuityWebhookDeps> {
  return {
    getDb: deps.getDb ?? createSupabaseServiceClient,
    hydrate: deps.hydrate ?? getAcuityAppointment,
    recordObservations: deps.recordObservations ?? recordAcuityObservations,
    fireGoals: deps.fireGoals ?? fireBookingGoalsForIdentities,
    fireTriggers: deps.fireTriggers ?? fireCalendarTriggersForPushedEvent,
    recordClaim: deps.recordClaim ?? recordExternalBookingClaim,
    deleteClaims: deps.deleteClaims ?? deleteBookingClaimsByEvent,
    claimStarts: deps.claimStarts ?? findBookingClaimStartsByEvent,
    offerSlot: deps.offerSlot ?? offerFreedSlot,
    cancelWaitlist: deps.cancelWaitlist ?? cancelWaitlistForAttendee,
    resolveWaitlist: deps.resolveWaitlist ?? resolveWaitlistAfterBooking,
    syncContact: deps.syncContact ?? syncAcuityContact,
    nowMs: deps.nowMs ?? Date.now()
  };
}

/**
 * The appointment-intelligence half of a delivery: goals, calendar triggers,
 * the booking ledger, the waitlist, and the contact sync.
 *
 * Each effect is independently guarded, because a goal-firing failure must
 * not cost us the calendar trigger, and vice versa.
 */
export async function processAcuityAppointmentEvent(
  businessId: string,
  conn: AcuityConnectionRow,
  event: AcuityWebhookEvent,
  deps: AcuityWebhookDeps = {}
): Promise<AcuityWebhookIntelligence> {
  const {
    getDb,
    hydrate,
    recordObservations,
    fireGoals,
    fireTriggers,
    recordClaim,
    deleteClaims,
    claimStarts,
    offerSlot,
    cancelWaitlist,
    resolveWaitlist,
    syncContact,
    nowMs
  } = resolveDeps(deps);
  const nowIso = new Date(nowMs).toISOString();

  const result: AcuityWebhookIntelligence = { ...NO_INTELLIGENCE };

  // The payload carries ids only, so everything below needs the real
  // appointment. This is the one failure worth a retry.
  let appt: AcuityAppointmentItem | null;
  try {
    appt = await hydrate(conn, event.appointmentId);
  } catch (err) {
    throw new AcuityHydrationError(
      `Acuity appointment ${event.appointmentId} could not be read: ${
        errorText(err)
      }`
    );
  }
  if (!appt) {
    // Acuity says it does not exist. Nothing to retry and nothing to do:
    // treat it as handled so the delivery is not counted a failure.
    return result;
  }
  result.hydrated = true;
  result.appointment = appt;

  // Trust the appointment over the action word: `changed` can carry a
  // cancellation, and only the hydrated row actually knows.
  const gone = appt.canceled || event.action === "canceled";
  const created = event.action === "scheduled";

  // OBSERVATION SHADOW, written with the DELIVERY moment, so the webhook
  // and the poller agree about when this change happened.
  let updatedIso: string | null = null;
  try {
    const [transition] = await recordObservations(
      businessId,
      [{ appointmentId: appt.id, startIso: appt.startIso, canceled: gone }],
      nowIso
    );
    updatedIso = transition?.updatedIso ?? null;
  } catch (err) {
    logger.warn("acuity webhook: observation shadow write failed", {
      businessId,
      appointmentId: appt.id,
      error: errorText(err)
    });
  }

  // GOALS, a new, still-standing appointment means "this person booked";
  // stop nurturing them.
  if (created && !gone && (appt.customerPhone || appt.customerEmail)) {
    try {
      const db = await getDb();
      const fired = await fireGoals(db, businessId, [
        { phone: appt.customerPhone, email: appt.customerEmail }
      ]);
      result.goalsFired = fired.goalsFired;
      result.jumpedRuns = fired.jumpedRuns;
      if (fired.jumpedRuns > 0) {
        await recordSystemLog({
          businessId,
          source: "aiflow",
          level: "info",
          event: "ai_flow_goal_jumped_booking",
          message: `A new Acuity booking moved ${fired.jumpedRuns} flow run(s) past their remaining follow-ups`,
          payload: { appointment_id: appt.id, jumped_runs: fired.jumpedRuns }
        });
      }
    } catch (err) {
      logger.warn("acuity webhook: booking goal firing failed", {
        businessId,
        appointmentId: appt.id,
        error: errorText(err)
      });
    }
  }

  // CALENDAR TRIGGERS, through the poller's own enqueue core, so the
  // shared `cal:` dedupe keys make poll/webhook double-observation a no-op.
  try {
    // `updatedIso ?? nowIso` guarantees a modification moment, which is what
    // eventCanceledDue gates on. createdIso comes off the appointment itself
    // and CAN be absent, so eventCreatedDue gets the same treatment here.
    const ev = acuityAppointmentToCalendarEvent(appt, updatedIso ?? nowIso);
    ev.cancelled = gone;
    // Only a `scheduled` delivery may be given a creation moment. Stamping
    // one on a reschedule or an edit would let eventCreatedDue treat an
    // existing appointment as brand new and fire event_created flows for it,
    // texting a customer a booking confirmation for something they made
    // weeks ago. An absent createdIso simply means event_created cannot
    // fire, which is the correct outcome for a change.
    if (created && !gone && !ev.createdIso) ev.createdIso = nowIso;
    const db = await getDb();
    result.triggerRunsEnqueued = await fireTriggers(db, businessId, ev, nowMs);
  } catch (err) {
    logger.warn("acuity webhook: calendar trigger firing failed", {
      businessId,
      appointmentId: appt.id,
      error: errorText(err)
    });
  }

  // LEDGER, keeps reschedule/cancel resolution working for bookings made
  // off-platform, on the merchant's own Acuity page.
  let vacatedStarts: string[] = [];
  try {
    if (gone) {
      // Read the vacated start(s) BEFORE the delete, so the waitlist below
      // can still offer them.
      vacatedStarts = await claimStarts(businessId, appt.id);
      await deleteClaims(businessId, appt.id);
      result.ledgerSynced = true;
    } else {
      const attendeeKey = bookingAttendeeKey(
        appt.customerPhone,
        appt.customerEmail,
        appt.customerName
      );
      if (!created) {
        // A move vacates exactly the old slot(s); capture them first.
        //
        // But `changed` also fires for edits that do NOT move the
        // appointment at all (an intake answer, a note), and Acuity sends it
        // alongside `scheduled`. Any recorded start that equals where the
        // appointment still sits was never vacated, so drop it: offering it
        // would text a waitlisted customer that a slot opened while it is
        // very much still booked.
        const currentMs = Date.parse(appt.startIso);
        vacatedStarts = (await claimStarts(businessId, appt.id)).filter(
          (startIso) => Date.parse(startIso) !== currentMs
        );
        await deleteClaims(businessId, appt.id);
      }
      await recordClaim(businessId, attendeeKey, appt.startIso, appt.id);
      result.ledgerSynced = true;
    }
  } catch (err) {
    logger.warn("acuity webhook: booking ledger sync failed", {
      businessId,
      appointmentId: appt.id,
      error: errorText(err)
    });
  }

  // WAITLIST, cancels and moves free slots in real time, idempotent with
  // the poller observing the same change. The customer whose appointment
  // changed is never offered the slot they just gave up.
  const attendee = {
    phones: appt.customerPhone ? [appt.customerPhone] : [],
    email: appt.customerEmail
  };
  const hasIdentity = attendee.phones.length > 0 || attendee.email !== null;
  try {
    if (gone) {
      if (hasIdentity) await cancelWaitlist(businessId, attendee);
      // Both the payload start and every ledger-recorded start free up, and
      // the two views can disagree, so offer each exactly once.
      const seen = new Set<number>();
      for (const startIso of [appt.startIso, ...vacatedStarts]) {
        const ms = Date.parse(startIso);
        if (!Number.isFinite(ms) || seen.has(ms)) continue;
        seen.add(ms);
        await offerSlot(businessId, startIso, {}, hasIdentity ? attendee : undefined);
      }
    } else {
      if (hasIdentity) await resolveWaitlist(businessId, attendee, appt.startIso);
      for (const startIso of vacatedStarts) {
        await offerSlot(businessId, startIso, {}, hasIdentity ? attendee : undefined);
      }
    }
  } catch (err) {
    logger.warn("acuity webhook: waitlist handling failed", {
      businessId,
      appointmentId: appt.id,
      error: errorText(err)
    });
  }

  // CONTACTS, Acuity has no customer event, so this is the only way a
  // walk-in booked on the merchant's own page becomes a contact.
  if (!gone) {
    result.contactSynced = await syncContact(businessId, appt);
  }

  return result;
}

export type AcuityWebhookResult = AcuityWebhookIntelligence & {
  flowRunsEnqueued: number;
};

/**
 * Full delivery handling: the AiFlow webhook-trigger channel plus the
 * appointment intelligence above.
 *
 * The two halves are independently guarded, matching the Vagaro receiver: a
 * flow-trigger failure must not lose the appointment intelligence, and vice
 * versa. A hydration failure still propagates, because that is the only
 * condition worth asking Acuity to retry.
 */
export async function processAcuityWebhookEvent(
  businessId: string,
  conn: AcuityConnectionRow,
  event: AcuityWebhookEvent,
  deps: AcuityWebhookDeps = {}
): Promise<AcuityWebhookResult> {
  // Appointment intelligence FIRST, because it hydrates. Acuity's payload
  // carries only ids, so `action` plus appointment id is not a usable
  // idempotency key: two consecutive reschedules of the same appointment
  // produce byte-identical payloads, and the flow channel would drop the
  // second as a redelivery even though the customer really did move it
  // again. The appointment's own current state is what tells a genuine new
  // change apart from a retry of the same one.
  //
  // Ordering costs nothing: a hydration failure throws, the route answers
  // 5xx, and Acuity retries the whole delivery, so the flow channel loses no
  // event it would otherwise have had.
  const intelligence = await processAcuityAppointmentEvent(businessId, conn, event, deps);

  let flowRunsEnqueued = 0;
  try {
    const appt = intelligence.appointment;
    const state = appt ? `${appt.startIso}:${appt.canceled ? "canceled" : "standing"}` : "unknown";
    const flow = await processWebhookFlowEvent(businessId, {
      source: "acuity",
      eventId: `acuity:${event.action}:${event.appointmentId}:${state}`,
      // `data`, not `payload`: this is what trigger matching and lead
      // recording read. Getting the field name wrong produced flows that
      // enqueued but saw an empty window text and matched no conditions.
      data: event.raw
    });
    flowRunsEnqueued = flow?.enqueued ?? 0;
  } catch (err) {
    logger.warn("acuity webhook: flow trigger dispatch failed", {
      businessId,
      appointmentId: event.appointmentId,
      error: errorText(err)
    });
  }

  return { ...intelligence, flowRunsEnqueued };
}
