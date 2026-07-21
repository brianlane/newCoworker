/**
 * Vagaro webhook processing — the Zapier-free inbound path.
 *
 * The owner pastes the tenant's webhook URL (which embeds the connection's
 * `webhook_verification_token`) into Vagaro's APIs & Webhooks settings.
 * Deliveries land on /api/webhooks/vagaro, which authenticates the token
 * (timing-safe) and calls `processVagaroWebhookEvent` here to:
 *
 *   1. start every enabled `webhook`-channel AiFlow whose conditions match
 *      (same engine path as the Zapier "Send Lead to Coworker" action, with
 *      `source: "vagaro"` so flows can filter on it), idempotent per Vagaro
 *      event id;
 *   2. sync `customer` created/updated events into the coworker's contacts
 *      (create-if-missing, fill-only on name/email — never clobber); and
 *   3. treat `appointment` events as booking intelligence (Calendly-stack
 *      parity, Jul 2026): a created appointment fires the
 *      `appointment_booked` goal machinery (nurture flows stop nudging a
 *      customer who booked on Vagaro's own page) and the real-time
 *      event_created calendar trigger; a deleted/canceled one fires
 *      event_canceled; and every appointment event keeps the booking
 *      ledger in sync (record/move/drop claims) so the AI's
 *      reschedule/cancel tools can locate off-platform bookings.
 *
 * All halves are best-effort relative to each other: a contact-sync or
 * appointment-intelligence failure must not lose the flow event, and vice
 * versa.
 */
import { timingSafeEqual } from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";
import {
  fireBookingGoalsForIdentities,
  type BookingGoalFireResult
} from "@/lib/ai-flows/booking-goal-fire";
import { fireCalendarTriggersForPushedEvent } from "@/lib/ai-flows/calendar-poll";
import { vagaroAppointmentToCalendarEvent } from "@/lib/ai-flows/vagaro-poll";
import { normalizeVagaroAppointment, type VagaroAppointmentItem } from "@/lib/vagaro/client";
import {
  bookingAttendeeKey,
  deleteBookingClaimsByEvent,
  recordExternalBookingClaim
} from "@/lib/calendar-tools/booking-dedupe";
import {
  createCustomerMemory,
  CustomerExistsError,
  getCustomerMemory,
  updateCustomerOwnerFields
} from "@/lib/customer-memory/db";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";

/** Serialized payload ceiling — mirrors /api/public/v1/flow-events. */
export const VAGARO_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

/** Constant-time token check (both sides are attacker-observable strings). */
export function verificationTokenMatches(presented: string, stored: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(stored, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type VagaroWebhookEvent = {
  /** Vagaro's event id — the idempotency key when present. */
  id: string | null;
  /** e.g. "appointment", "customer", "transaction", "formResponse". */
  type: string | null;
  /** e.g. "created", "updated", "deleted". */
  action: string | null;
  /** The event's payload object (shape varies by type). */
  payload: Record<string, unknown>;
  /** The full body, flattened into the flow trigger's window text. */
  raw: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Normalize a Vagaro delivery body into the fields we consume. */
export function parseVagaroWebhookBody(body: unknown): VagaroWebhookEvent | null {
  const record = asRecord(body);
  if (Object.keys(record).length === 0) return null;
  const payload = asRecord(record.payload);
  return {
    id: asString(record.id) ?? asString(record.eventId),
    type: asString(record.type) ?? asString(record.resourceType),
    action: asString(record.action),
    payload,
    raw: record
  };
}

/**
 * Best-effort E.164 normalization for Vagaro-supplied phone strings.
 * US-assumed for bare 10-digit numbers (Vagaro's core market, matching the
 * public-API send_sms hint). Null when the shape isn't usable.
 */
export function normalizeVagaroPhone(input: string | null): string | null {
  if (!input) return null;
  const digits = input.replace(/[^0-9+]/g, "");
  if (digits.startsWith("+")) {
    const rest = digits.slice(1).replace(/[^0-9]/g, "");
    return rest.length >= 8 && rest.length <= 15 ? `+${rest}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Pull the customer's contact fields out of a `customer` event payload. */
export function extractVagaroCustomer(payload: Record<string, unknown>): {
  phone: string | null;
  name: string | null;
  email: string | null;
} {
  const customer = asRecord(payload.customer);
  const source = Object.keys(customer).length > 0 ? customer : payload;
  const phoneRaw =
    asString(source.phone) ??
    asString(source.phoneNumber) ??
    asString(source.mobilePhone) ??
    asString(source.cellPhone);
  const first = asString(source.firstName);
  const last = asString(source.lastName);
  const name =
    asString(source.name) ??
    asString(source.fullName) ??
    (first || last ? [first, last].filter(Boolean).join(" ") : null);
  return {
    phone: normalizeVagaroPhone(phoneRaw),
    name,
    email: asString(source.email)?.toLowerCase() ?? null
  };
}

/**
 * Contact sync for `customer` created/updated events. Create-if-missing;
 * existing rows get FILL-ONLY name/email (an owner's manual edit or a
 * richer earlier value is never clobbered). No phone → nothing to key on.
 */
export async function syncVagaroCustomer(
  businessId: string,
  event: VagaroWebhookEvent
): Promise<void> {
  if (event.type !== "customer") return;
  if (event.action !== "created" && event.action !== "updated") return;
  const { phone, name, email } = extractVagaroCustomer(event.payload);
  if (!phone) return;

  let existing = await getCustomerMemory(businessId, phone);
  if (!existing) {
    try {
      await createCustomerMemory(businessId, {
        customerE164: phone,
        displayName: name,
        email
      });
      return;
    } catch (err) {
      if (!(err instanceof CustomerExistsError)) throw err;
      // Concurrent deliveries raced the existence check — the profile now
      // exists, so re-read it and apply THIS delivery's fields fill-only
      // below (returning here would silently drop them).
      existing = await getCustomerMemory(businessId, phone);
      if (!existing) return;
    }
  }

  const patch: { displayName?: string; email?: string } = {};
  if (name && !existing.display_name) patch.displayName = name;
  if (email && !existing.email) patch.email = email;
  if (Object.keys(patch).length === 0) return;
  await updateCustomerOwnerFields(businessId, existing.customer_e164, patch);
}

/** Actions that mean an appointment is no longer standing. */
const APPOINTMENT_GONE_ACTIONS = new Set(["deleted", "canceled", "cancelled"]);

/**
 * The appointment object out of an `appointment` event payload — nested
 * under `payload.appointment` or the payload itself (shape tolerance, same
 * posture as extractVagaroCustomer). Null when it has no id + parseable
 * start (the listing normalizer's contract).
 */
export function extractVagaroAppointment(
  payload: Record<string, unknown>
): VagaroAppointmentItem | null {
  const nested = asRecord(payload.appointment);
  return normalizeVagaroAppointment(Object.keys(nested).length > 0 ? nested : payload);
}

/** Appointment id alone — deletion events may carry nothing else usable. */
export function extractVagaroAppointmentId(payload: Record<string, unknown>): string | null {
  const nested = asRecord(payload.appointment);
  const source = Object.keys(nested).length > 0 ? nested : payload;
  return asString(source.id) ?? asString(source.appointmentId);
}

export type VagaroAppointmentIntelligence = {
  /** appointment_booked goal firings (unique numbers). */
  goalsFired: number;
  /** Runs fast-forwarded to their goal step. */
  jumpedRuns: number;
  /** Calendar-trigger runs enqueued in real time (created/canceled). */
  triggerRunsEnqueued: number;
  /** Whether a booking-ledger write/delete was applied. */
  ledgerSynced: boolean;
};

export type VagaroAppointmentDeps = {
  /** Injectable service client (tests). */
  getDb?: typeof createSupabaseServiceClient;
  /** Injectable goal-firing helper (tests). */
  fireGoals?: typeof fireBookingGoalsForIdentities;
  /** Injectable pushed-trigger helper (tests). */
  fireTriggers?: typeof fireCalendarTriggersForPushedEvent;
  /** Injectable ledger writes (tests). */
  recordClaim?: typeof recordExternalBookingClaim;
  deleteClaims?: typeof deleteBookingClaimsByEvent;
  /** Injectable clock (tests). */
  nowMs?: number;
};

const NO_APPOINTMENT_INTELLIGENCE: VagaroAppointmentIntelligence = {
  goalsFired: 0,
  jumpedRuns: 0,
  triggerRunsEnqueued: 0,
  ledgerSynced: false
};

/**
 * Booking intelligence for one `appointment` webhook event (Calendly-stack
 * parity). Three independent, each-best-effort effects:
 *
 *   - GOALS (action created, appointment standing): the customer's phone +
 *     email fire the shared `appointment_booked` machinery — parked nurture
 *     runs fast-forward past their remaining nudges, exactly as if the
 *     booking had been made through the platform tools.
 *   - CALENDAR TRIGGERS: created → event_created flows, deleted/canceled
 *     (or a payload whose status marks it canceled) → event_canceled flows,
 *     in real time through the poller's own enqueue core (shared dedupe
 *     keys make poll/webhook double-observation a no-op). A payload without
 *     the relevant timestamp gets the delivery moment — the event is
 *     happening NOW, that is what "real time" means here.
 *   - LEDGER: created → record an external booking claim; updated → move it
 *     (drop + re-record at the new start); deleted/canceled → drop every
 *     claim for the appointment. This is what lets the reschedule/cancel
 *     tools locate an off-platform booking (ledger-only resolution).
 *
 * Never throws: each effect degrades to a logged warning, because losing
 * the webhook-flow event or the contact sync over booking intelligence
 * would be strictly worse than missing one observation (the poll sweep
 * and precheck remain the safety nets).
 */
export async function processVagaroAppointmentEvent(
  businessId: string,
  event: VagaroWebhookEvent,
  deps: VagaroAppointmentDeps = {}
): Promise<VagaroAppointmentIntelligence> {
  if (event.type !== "appointment") return NO_APPOINTMENT_INTELLIGENCE;
  const getDb = deps.getDb ?? createSupabaseServiceClient;
  const fireGoals = deps.fireGoals ?? fireBookingGoalsForIdentities;
  const fireTriggers = deps.fireTriggers ?? fireCalendarTriggersForPushedEvent;
  const recordClaim = deps.recordClaim ?? recordExternalBookingClaim;
  const deleteClaims = deps.deleteClaims ?? deleteBookingClaimsByEvent;
  const nowMs = deps.nowMs ?? Date.now();

  const result: VagaroAppointmentIntelligence = { ...NO_APPOINTMENT_INTELLIGENCE };
  const action = (event.action ?? "").toLowerCase();
  const appt = extractVagaroAppointment(event.payload);
  const appointmentId = appt?.id ?? extractVagaroAppointmentId(event.payload);
  if (!appointmentId) return result;
  const gone = APPOINTMENT_GONE_ACTIONS.has(action) || appt?.cancelled === true;

  // GOALS — a created, still-standing appointment means "this person
  // booked"; stop nurturing them.
  if (action === "created" && !gone && appt) {
    const customer = extractVagaroCustomer(event.payload);
    const identities = [
      {
        phone: appt.customerPhone ?? customer.phone,
        email: appt.customerEmail ?? customer.email
      }
    ];
    if (identities[0].phone || identities[0].email) {
      try {
        const db = await getDb();
        const fired: BookingGoalFireResult = await fireGoals(db, businessId, identities);
        result.goalsFired = fired.goalsFired;
        result.jumpedRuns = fired.jumpedRuns;
        if (fired.jumpedRuns > 0) {
          await recordSystemLog({
            businessId,
            source: "aiflow",
            level: "info",
            event: "ai_flow_goal_jumped_booking",
            message: `A new Vagaro booking moved ${fired.jumpedRuns} flow run(s) past their remaining follow-ups`,
            payload: { appointment_id: appointmentId, jumped_runs: fired.jumpedRuns }
          });
        }
      } catch (err) {
        logger.warn("vagaro webhook: booking goal firing failed", {
          businessId,
          appointmentId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  // CALENDAR TRIGGERS — real-time created/canceled firings through the
  // poller's enqueue core (shared dedupe keys).
  if (appt && (action === "created" || gone)) {
    try {
      const ev = vagaroAppointmentToCalendarEvent(appt);
      if (gone) {
        ev.cancelled = true;
        // eventCanceledDue gates on the modification moment; a payload
        // without one is being delivered about a cancellation happening now.
        if (!ev.updatedIso) ev.updatedIso = new Date(nowMs).toISOString();
      } else if (!ev.createdIso) {
        // Same reasoning for eventCreatedDue on a fresh booking.
        ev.createdIso = new Date(nowMs).toISOString();
      }
      const db = await getDb();
      result.triggerRunsEnqueued = await fireTriggers(db, businessId, ev, nowMs);
    } catch (err) {
      logger.warn("vagaro webhook: calendar trigger firing failed", {
        businessId,
        appointmentId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // LEDGER — keep reschedule/cancel resolution working for off-platform
  // bookings. The ledger primitives are individually best-effort already;
  // the try/catch guards the composition.
  try {
    if (gone) {
      await deleteClaims(businessId, appointmentId);
      result.ledgerSynced = true;
    } else if (appt && (action === "created" || action === "updated")) {
      const customer = extractVagaroCustomer(event.payload);
      const attendeeKey = bookingAttendeeKey(
        appt.customerPhone ?? customer.phone,
        appt.customerEmail ?? customer.email,
        appt.customerName ?? customer.name
      );
      if (action === "updated") {
        // A moved appointment: drop the stale-slot claim(s) and re-record at
        // the new start (Vagaro bookings carry no Zoom meeting to preserve).
        await deleteClaims(businessId, appointmentId);
      }
      await recordClaim(businessId, attendeeKey, appt.startIso, appointmentId);
      result.ledgerSynced = true;
    }
  } catch (err) {
    logger.warn("vagaro webhook: booking ledger sync failed", {
      businessId,
      appointmentId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  return result;
}

export type VagaroWebhookResult = {
  enqueued: number;
  flowsEvaluated: number;
  flowsMatched: number;
  contactSynced: boolean;
  /** appointment_booked goal firings from an appointment-created event. */
  goalsFired: number;
  /** Flow runs the goal machinery fast-forwarded. */
  jumpedRuns: number;
  /** Calendar-trigger runs enqueued in real time (created/canceled). */
  triggerRunsEnqueued: number;
  /** Whether the booking ledger was updated for this event. */
  ledgerSynced: boolean;
};

/**
 * The route's core: flow events + contact sync + appointment intelligence,
 * isolated from each other.
 *
 * A contact-sync failure only logs (the flow result still returns), and the
 * appointment-intelligence half never throws by contract. A flow-processing
 * failure runs the other halves FIRST, then rethrows so the route answers
 * non-2xx and Vagaro redelivers — the retried flow event is deduped by
 * event id, and the already-applied side effects are idempotent
 * (create-if-missing + fill-only contacts; goal jumps and calendar dedupe
 * keys no-op on re-observation; ledger writes are conflict-ignored).
 */
export async function processVagaroWebhookEvent(
  businessId: string,
  event: VagaroWebhookEvent,
  apptDeps: VagaroAppointmentDeps = {}
): Promise<VagaroWebhookResult> {
  let flowResult: Awaited<ReturnType<typeof processWebhookFlowEvent>> | null = null;
  let flowError: unknown = null;
  try {
    flowResult = await processWebhookFlowEvent(businessId, {
      source: "vagaro",
      data: event.raw,
      eventId: event.id ?? undefined
    });
  } catch (err) {
    flowError = err;
  }

  let contactSynced = false;
  try {
    await syncVagaroCustomer(businessId, event);
    contactSynced = event.type === "customer";
  } catch (err) {
    logger.warn("vagaro webhook contact sync failed", {
      businessId,
      eventId: event.id,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  const intelligence = await processVagaroAppointmentEvent(businessId, event, apptDeps);

  if (flowResult === null) {
    // Only reachable via the catch above; rethrow after the other halves ran.
    throw flowError;
  }

  return {
    enqueued: flowResult.enqueued,
    flowsEvaluated: flowResult.flowsEvaluated,
    flowsMatched: flowResult.flowsMatched,
    contactSynced,
    ...intelligence
  };
}
