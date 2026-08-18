/**
 * Tests for the Acuity webhook receiver (src/lib/acuity/webhook.ts).
 *
 * Correctness does not depend on this module: the ~1/min poller already
 * observes every change, so webhooks buy latency. That shapes what is worth
 * pinning here, that a delivery we cannot make sense of is ABSORBED rather
 * than retried (Acuity disables a webhook after five days of failure), that
 * a hydration failure is the one thing that IS retried, and that the events
 * this path produces are identical to the poller's so their shared `cal:`
 * dedupe keys collapse double-observation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/ai-flows/webhook-events", () => ({ processWebhookFlowEvent: vi.fn() }));
const hydrateMock = vi.fn();
const recordObsMock = vi.fn();
const fireGoalsMock = vi.fn();
const fireTriggersMock = vi.fn();
const recordClaimMock = vi.fn();
const deleteClaimsMock = vi.fn();
const claimStartsMock = vi.fn();
const offerSlotMock = vi.fn();
const cancelWaitlistMock = vi.fn();
const resolveWaitlistMock = vi.fn();
vi.mock("@/lib/acuity/client", () => ({
  getAcuityAppointment: (...a: unknown[]) => hydrateMock(...a)
}));
vi.mock("@/lib/db/acuity-appointment-state", () => ({
  recordAcuityObservations: (...a: unknown[]) => recordObsMock(...a)
}));
vi.mock("@/lib/ai-flows/booking-goal-fire", () => ({
  fireBookingGoalsForIdentities: (...a: unknown[]) => fireGoalsMock(...a)
}));
vi.mock("@/lib/ai-flows/calendar-poll", () => ({
  fireCalendarTriggersForPushedEvent: (...a: unknown[]) => fireTriggersMock(...a)
}));
vi.mock("@/lib/calendar-tools/booking-dedupe", () => ({
  bookingAttendeeKey: () => "key",
  recordExternalBookingClaim: (...a: unknown[]) => recordClaimMock(...a),
  deleteBookingClaimsByEvent: (...a: unknown[]) => deleteClaimsMock(...a),
  findBookingClaimStartsByEvent: (...a: unknown[]) => claimStartsMock(...a)
}));
vi.mock("@/lib/calendar-tools/waitlist-fill", () => ({
  offerFreedSlot: (...a: unknown[]) => offerSlotMock(...a)
}));
vi.mock("@/lib/calendar-tools/waitlist-resolve", () => ({
  cancelWaitlistForAttendee: (...a: unknown[]) => cancelWaitlistMock(...a),
  resolveWaitlistAfterBooking: (...a: unknown[]) => resolveWaitlistMock(...a)
}));
vi.mock("@/lib/customer-memory/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/customer-memory/db")>(
    "@/lib/customer-memory/db"
  );
  return {
    CustomerExistsError: actual.CustomerExistsError,
    getCustomerMemory: vi.fn(),
    createCustomerMemory: vi.fn(),
    updateCustomerOwnerFields: vi.fn()
  };
});

import { acuityAppointmentToCalendarEvent } from "@/lib/ai-flows/acuity-poll";
import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";
import {
  createCustomerMemory,
  CustomerExistsError,
  getCustomerMemory,
  updateCustomerOwnerFields
} from "@/lib/customer-memory/db";
import {
  AcuityHydrationError,
  parseAcuityWebhookBody,
  processAcuityAppointmentEvent,
  processAcuityWebhookEvent,
  syncAcuityContact
} from "@/lib/acuity/webhook";

const BIZ = "biz-1";

const CONN = {
  id: "ac-1",
  business_id: BIZ,
  user_id: "1",
  apiKey: "key",
  api_base_url: "https://acuityscheduling.com",
  webhook_verification_token: "tok",
  default_appointment_type_id: null,
  default_calendar_id: null,
  default_calendar_timezone: "America/New_York",
  suppress_provider_emails: true,
  webhook_registration: {},
  is_active: true,
  created_at: "",
  updated_at: ""
} as never;

function appt(over: Record<string, unknown> = {}) {
  return {
    id: "500",
    startIso: "2026-08-05T17:00:00.000Z",
    endIso: "2026-08-05T17:30:00.000Z",
    createdIso: "2026-08-01T13:00:00.000Z",
    canceled: false,
    appointmentTypeId: "1",
    appointmentTypeName: "Consult",
    calendarId: "7",
    calendarName: "Ana",
    durationMinutes: 30,
    customerName: "Sam Rivera",
    customerEmail: "sam@example.org",
    customerPhone: "+15551234567",
    notes: null,
    timezone: "America/New_York",
    ...over
  };
}

const EVENT = {
  action: "scheduled",
  appointmentId: "500",
  calendarId: "7",
  appointmentTypeId: "1",
  raw: { action: "scheduled", id: "500" }
};

const NOW = Date.parse("2026-08-04T12:00:00.000Z");

function deps(over: Record<string, unknown> = {}) {
  return {
    getDb: vi.fn(async () => ({})),
    hydrate: vi.fn().mockResolvedValue(appt()),
    recordObservations: vi.fn().mockResolvedValue([
      { appointmentId: "500", kind: "new", updatedIso: null }
    ]),
    fireGoals: vi.fn().mockResolvedValue({ goalsFired: 0, jumpedRuns: 0 }),
    fireTriggers: vi.fn().mockResolvedValue(0),
    recordClaim: vi.fn().mockResolvedValue(undefined),
    deleteClaims: vi.fn().mockResolvedValue(undefined),
    claimStarts: vi.fn().mockResolvedValue([]),
    offerSlot: vi.fn().mockResolvedValue(undefined),
    cancelWaitlist: vi.fn().mockResolvedValue(undefined),
    resolveWaitlist: vi.fn().mockResolvedValue(undefined),
    syncContact: vi.fn().mockResolvedValue(true),
    nowMs: NOW,
    ...over
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processWebhookFlowEvent).mockResolvedValue({ enqueued: 2 } as never);
});

describe("parseAcuityWebhookBody", () => {
  it("parses Acuity's form-urlencoded delivery", () => {
    const ev = parseAcuityWebhookBody(
      "action=appointment.scheduled&id=500&calendarID=7&appointmentTypeID=1"
    );
    expect(ev).toMatchObject({
      action: "appointment.scheduled",
      appointmentId: "500",
      calendarId: "7",
      appointmentTypeId: "1"
    });
  });

  it("keeps the whole body for the flow trigger's window text", () => {
    const ev = parseAcuityWebhookBody("action=canceled&id=1&extra=keepme");
    expect(ev?.raw).toMatchObject({ extra: "keepme" });
  });

  it("returns null without an appointment id, so the route can absorb it", () => {
    expect(parseAcuityWebhookBody("action=canceled")).toBeNull();
    expect(parseAcuityWebhookBody("")).toBeNull();
  });

  it("tolerates a missing action and blank optional ids", () => {
    const ev = parseAcuityWebhookBody("id=500&calendarID=&appointmentTypeID=");
    expect(ev).toMatchObject({ action: "", calendarId: null, appointmentTypeId: null });
  });
});

describe("processAcuityAppointmentEvent", () => {
  it("throws a hydration error so the route can ask Acuity to retry", async () => {
    // The payload is ids only, so without the appointment there is nothing
    // to act on, and Acuity may well serve it a moment later.
    await expect(
      processAcuityAppointmentEvent(
        BIZ,
        CONN,
        EVENT,
        deps({ hydrate: vi.fn().mockRejectedValue(new Error("500 from acuity")) })
      )
    ).rejects.toBeInstanceOf(AcuityHydrationError);
  });

  it("treats an appointment Acuity says does not exist as handled", async () => {
    const res = await processAcuityAppointmentEvent(
      BIZ,
      CONN,
      EVENT,
      deps({ hydrate: vi.fn().mockResolvedValue(null) })
    );
    expect(res.hydrated).toBe(false);
    expect(res.ledgerSynced).toBe(false);
  });

  it("writes the observation shadow with the DELIVERY moment", async () => {
    // So the webhook and the poller agree about when the change happened.
    const d = deps();
    await processAcuityAppointmentEvent(BIZ, CONN, EVENT, d);
    const call = (d as never as { recordObservations: { mock: { calls: unknown[][] } } })
      .recordObservations.mock.calls[0];
    expect(call[1]).toEqual([
      { appointmentId: "500", startIso: "2026-08-05T17:00:00.000Z", canceled: false }
    ]);
    expect(call[2]).toBe(new Date(NOW).toISOString());
  });

  it("TRUSTS the hydrated appointment over the action word", async () => {
    // Acuity sends `changed` for cancellations too; only the row knows.
    const d = deps({ hydrate: vi.fn().mockResolvedValue(appt({ canceled: true })) });
    await processAcuityAppointmentEvent(BIZ, CONN, { ...EVENT, action: "changed" }, d);
    const ev = (d as never as { fireTriggers: { mock: { calls: unknown[][] } } }).fireTriggers.mock
      .calls[0][2] as { cancelled: boolean };
    expect(ev.cancelled).toBe(true);
    expect((d as never as { deleteClaims: { mock: { calls: unknown[] } } }).deleteClaims.mock.calls)
      .toHaveLength(1);
  });

  it("fires booking goals only for a NEW standing appointment", async () => {
    const created = deps();
    await processAcuityAppointmentEvent(BIZ, CONN, EVENT, created);
    expect((created as never as { fireGoals: { mock: { calls: unknown[] } } }).fireGoals.mock.calls)
      .toHaveLength(1);

    const moved = deps();
    await processAcuityAppointmentEvent(BIZ, CONN, { ...EVENT, action: "rescheduled" }, moved);
    expect((moved as never as { fireGoals: { mock: { calls: unknown[] } } }).fireGoals.mock.calls)
      .toHaveLength(0);
  });

  it("logs when a new booking jumps flow runs past their follow-ups", async () => {
    const d = deps({ fireGoals: vi.fn().mockResolvedValue({ goalsFired: 1, jumpedRuns: 2 }) });
    const res = await processAcuityAppointmentEvent(BIZ, CONN, EVENT, d);
    expect(res).toMatchObject({ goalsFired: 1, jumpedRuns: 2 });
  });

  it("reads the vacated starts BEFORE deleting the claims", async () => {
    // Otherwise the waitlist has nothing to offer.
    const order: string[] = [];
    const d = deps({
      hydrate: vi.fn().mockResolvedValue(appt({ canceled: true })),
      claimStarts: vi.fn(async () => {
        order.push("read");
        return ["2026-08-05T17:00:00.000Z"];
      }),
      deleteClaims: vi.fn(async () => {
        order.push("delete");
      })
    });
    await processAcuityAppointmentEvent(BIZ, CONN, { ...EVENT, action: "canceled" }, d);
    expect(order).toEqual(["read", "delete"]);
  });

  it("offers each freed instant exactly once across payload and ledger views", async () => {
    const d = deps({
      hydrate: vi.fn().mockResolvedValue(appt({ canceled: true })),
      claimStarts: vi
        .fn()
        .mockResolvedValue(["2026-08-05T17:00:00.000Z", "2026-08-09T19:00:00.000Z"])
    });
    await processAcuityAppointmentEvent(BIZ, CONN, { ...EVENT, action: "canceled" }, d);
    const offered = (d as never as { offerSlot: { mock: { calls: unknown[][] } } }).offerSlot.mock
      .calls.map((c) => c[1]);
    // The payload start and the first ledger start are the same instant.
    expect(offered).toEqual(["2026-08-05T17:00:00.000Z", "2026-08-09T19:00:00.000Z"]);
  });

  it("moves the ledger claim on a reschedule", async () => {
    const d = deps({
      hydrate: vi.fn().mockResolvedValue(appt({ startIso: "2026-08-06T19:00:00.000Z" })),
      claimStarts: vi.fn().mockResolvedValue(["2026-08-05T17:00:00.000Z"])
    });
    await processAcuityAppointmentEvent(BIZ, CONN, { ...EVENT, action: "rescheduled" }, d);
    expect((d as never as { deleteClaims: { mock: { calls: unknown[] } } }).deleteClaims.mock.calls)
      .toHaveLength(1);
    // The slot the move vacated goes to the waitlist.
    expect(
      (d as never as { offerSlot: { mock: { calls: unknown[][] } } }).offerSlot.mock.calls[0][1]
    ).toBe("2026-08-05T17:00:00.000Z");
    expect(
      (d as never as { recordClaim: { mock: { calls: unknown[][] } } }).recordClaim.mock.calls[0][2]
    ).toBe("2026-08-06T19:00:00.000Z");
  });

  it("offers NOTHING to the waitlist when an edit did not move the appointment", async () => {
    // Acuity sends `changed` for intake edits and notes too. A recorded
    // start equal to where the appointment still sits was never vacated,
    // and offering it would tell a waitlisted customer a slot opened while
    // it is very much still booked.
    const d = deps({
      claimStarts: vi.fn().mockResolvedValue(["2026-08-05T17:00:00.000Z"])
    });
    await processAcuityAppointmentEvent(BIZ, CONN, { ...EVENT, action: "changed" }, d);
    expect((d as never as { offerSlot: { mock: { calls: unknown[] } } }).offerSlot.mock.calls)
      .toHaveLength(0);
  });

  it("offers only the starts an edit actually vacated", async () => {
    const d = deps({
      hydrate: vi.fn().mockResolvedValue(appt({ startIso: "2026-08-06T19:00:00.000Z" })),
      claimStarts: vi
        .fn()
        .mockResolvedValue(["2026-08-05T17:00:00.000Z", "2026-08-06T19:00:00.000Z"])
    });
    await processAcuityAppointmentEvent(BIZ, CONN, { ...EVENT, action: "changed" }, d);
    const offered = (d as never as { offerSlot: { mock: { calls: unknown[][] } } }).offerSlot.mock
      .calls.map((c) => c[1]);
    expect(offered).toEqual(["2026-08-05T17:00:00.000Z"]);
  });

  it("syncs the contact only while the appointment stands", async () =>{
    const standing = deps();
    await processAcuityAppointmentEvent(BIZ, CONN, EVENT, standing);
    expect((standing as never as { syncContact: { mock: { calls: unknown[] } } }).syncContact.mock.calls)
      .toHaveLength(1);

    const gone = deps({ hydrate: vi.fn().mockResolvedValue(appt({ canceled: true })) });
    await processAcuityAppointmentEvent(BIZ, CONN, { ...EVENT, action: "canceled" }, gone);
    expect((gone as never as { syncContact: { mock: { calls: unknown[] } } }).syncContact.mock.calls)
      .toHaveLength(0);
  });

  it("keeps every other effect when one of them fails", async () => {
    // A goal-firing failure must not cost us the calendar trigger.
    const d = deps({ fireGoals: vi.fn().mockRejectedValue(new Error("goals down")) });
    const res = await processAcuityAppointmentEvent(BIZ, CONN, EVENT, d);
    expect(res.triggerRunsEnqueued).toBe(0);
    expect(res.ledgerSynced).toBe(true);
    expect(res.contactSynced).toBe(true);
  });

  it("survives a failing shadow write, trigger, ledger and waitlist", async () => {
    const d = deps({
      recordObservations: vi.fn().mockRejectedValue(new Error("shadow")),
      fireTriggers: vi.fn().mockRejectedValue(new Error("triggers")),
      recordClaim: vi.fn().mockRejectedValue(new Error("ledger")),
      resolveWaitlist: vi.fn().mockRejectedValue(new Error("waitlist"))
    });
    const res = await processAcuityAppointmentEvent(BIZ, CONN, EVENT, d);
    expect(res.hydrated).toBe(true);
    expect(res.ledgerSynced).toBe(false);
  });

  it("stamps a cancellation's updatedIso when the shadow has none", async () => {
    // eventCanceledDue gates on the modification moment; a delivery about a
    // cancellation happening now must carry one.
    const d = deps({
      hydrate: vi.fn().mockResolvedValue(appt({ canceled: true })),
      recordObservations: vi.fn().mockResolvedValue([])
    });
    await processAcuityAppointmentEvent(BIZ, CONN, { ...EVENT, action: "canceled" }, d);
    const ev = (d as never as { fireTriggers: { mock: { calls: unknown[][] } } }).fireTriggers.mock
      .calls[0][2] as { updatedIso: string };
    expect(ev.updatedIso).toBe(new Date(NOW).toISOString());
  });

  it("does NOT invent a creation moment for a reschedule", async () => {
    // Stamping one would let eventCreatedDue treat an existing appointment
    // as brand new and text the customer a booking confirmation for
    // something they arranged weeks ago.
    const d = deps({
      hydrate: vi.fn().mockResolvedValue(appt({ createdIso: null })),
      recordObservations: vi.fn().mockResolvedValue([])
    });
    await processAcuityAppointmentEvent(BIZ, CONN, { ...EVENT, action: "rescheduled" }, d);
    const ev = (d as never as { fireTriggers: { mock: { calls: unknown[][] } } }).fireTriggers.mock
      .calls[0][2] as { createdIso?: string };
    expect(ev.createdIso).toBeUndefined();
  });

  it("stamps a fresh booking's createdIso when the payload has none", async () => {
    const d = deps({
      hydrate: vi.fn().mockResolvedValue(appt({ createdIso: null })),
      recordObservations: vi.fn().mockResolvedValue([])
    });
    await processAcuityAppointmentEvent(BIZ, CONN, EVENT, d);
    const ev = (d as never as { fireTriggers: { mock: { calls: unknown[][] } } }).fireTriggers.mock
      .calls[0][2] as { createdIso: string };
    expect(ev.createdIso).toBe(new Date(NOW).toISOString());
  });

  it("still frees the slot for an anonymous cancellation", async () => {
    // No identity means no waitlist entries of their own to cancel, but the
    // slot they vacated is still open for whoever is waiting.
    const d = deps({
      hydrate: vi
        .fn()
        .mockResolvedValue(appt({ canceled: true, customerPhone: null, customerEmail: null }))
    });
    await processAcuityAppointmentEvent(BIZ, CONN, { ...EVENT, action: "canceled" }, d);
    expect(
      (d as never as { cancelWaitlist: { mock: { calls: unknown[] } } }).cancelWaitlist.mock.calls
    ).toHaveLength(0);
    const offered = (d as never as { offerSlot: { mock: { calls: unknown[][] } } }).offerSlot.mock
      .calls[0];
    expect(offered[3]).toBeUndefined();
  });

  it("offers a move's vacated slot with no attendee when the booking is anonymous", async () => {
    const d = deps({
      hydrate: vi
        .fn()
        .mockResolvedValue(appt({ customerPhone: null, customerEmail: null })),
      claimStarts: vi.fn().mockResolvedValue(["2026-08-01T17:00:00.000Z"])
    });
    await processAcuityAppointmentEvent(BIZ, CONN, { ...EVENT, action: "rescheduled" }, d);
    const offered = (d as never as { offerSlot: { mock: { calls: unknown[][] } } }).offerSlot.mock
      .calls[0];
    expect(offered[3]).toBeUndefined();
  });

  it("skips goals and waitlist identity work for an anonymous booking", async () => {
    const d = deps({
      hydrate: vi.fn().mockResolvedValue(appt({ customerPhone: null, customerEmail: null }))
    });
    await processAcuityAppointmentEvent(BIZ, CONN, EVENT, d);
    expect((d as never as { fireGoals: { mock: { calls: unknown[] } } }).fireGoals.mock.calls)
      .toHaveLength(0);
    expect(
      (d as never as { resolveWaitlist: { mock: { calls: unknown[] } } }).resolveWaitlist.mock.calls
    ).toHaveLength(0);
  });
});

describe("event identity with the poller", () => {
  it("produces the same CalendarEventInput the poll path produces", async () => {
    // Their shared `cal:` dedupe keys only collapse if the events match.
    const raw = appt();
    const d = deps({
      recordObservations: vi
        .fn()
        .mockResolvedValue([{ appointmentId: "500", kind: "new", updatedIso: "2026-08-03T00:00:00.000Z" }])
    });
    await processAcuityAppointmentEvent(BIZ, CONN, EVENT, d);
    const fromWebhook = (d as never as { fireTriggers: { mock: { calls: unknown[][] } } })
      .fireTriggers.mock.calls[0][2];
    const fromPoll = acuityAppointmentToCalendarEvent(raw as never, "2026-08-03T00:00:00.000Z");
    expect(fromWebhook).toEqual({ ...fromPoll, cancelled: false });
  });
});

describe("processAcuityWebhookEvent", () => {
  it("runs the flow channel and the appointment intelligence independently", async () => {
    const res = await processAcuityWebhookEvent(BIZ, CONN, EVENT, deps());
    expect(res.flowRunsEnqueued).toBe(2);
    expect(res.hydrated).toBe(true);
  });

  it("keeps the appointment intelligence when the flow dispatch fails", async () => {
    vi.mocked(processWebhookFlowEvent).mockRejectedValue(new Error("flows down"));
    const res = await processAcuityWebhookEvent(BIZ, CONN, EVENT, deps());
    expect(res.flowRunsEnqueued).toBe(0);
    expect(res.hydrated).toBe(true);
  });

  it("still propagates a hydration failure so the delivery is retried", async () => {
    await expect(
      processAcuityWebhookEvent(
        BIZ,
        CONN,
        EVENT,
        deps({ hydrate: vi.fn().mockRejectedValue(new Error("down")) })
      )
    ).rejects.toBeInstanceOf(AcuityHydrationError);
  });

  it("dedupes a true REDELIVERY: identical payload and unchanged appointment", async () => {
    await processAcuityWebhookEvent(BIZ, CONN, EVENT, deps());
    const first = vi.mocked(processWebhookFlowEvent).mock.calls[0][1] as { eventId: string };
    vi.mocked(processWebhookFlowEvent).mockClear();
    await processAcuityWebhookEvent(BIZ, CONN, EVENT, deps());
    const again = vi.mocked(processWebhookFlowEvent).mock.calls[0][1] as { eventId: string };
    expect(again.eventId).toBe(first.eventId);
  });

  it("does NOT dedupe a second move of the same appointment", async () => {
    // Acuity's payload is ids only, so two consecutive reschedules are
    // byte-identical. Without the appointment's own state in the key, the
    // customer's second move would be dropped as a redelivery.
    const move = { ...EVENT, action: "rescheduled" };
    await processAcuityWebhookEvent(BIZ, CONN, move, deps());
    const first = vi.mocked(processWebhookFlowEvent).mock.calls[0][1] as { eventId: string };
    vi.mocked(processWebhookFlowEvent).mockClear();
    await processAcuityWebhookEvent(
      BIZ,
      CONN,
      move,
      deps({ hydrate: vi.fn().mockResolvedValue(appt({ startIso: "2026-08-09T19:00:00.000Z" })) })
    );
    const second = vi.mocked(processWebhookFlowEvent).mock.calls[0][1] as { eventId: string };
    expect(second.eventId).not.toBe(first.eventId);
  });

  it("distinguishes a cancellation from a standing appointment at the same time", async () => {
    await processAcuityWebhookEvent(BIZ, CONN, EVENT, deps());
    const standing = vi.mocked(processWebhookFlowEvent).mock.calls[0][1] as { eventId: string };
    vi.mocked(processWebhookFlowEvent).mockClear();
    await processAcuityWebhookEvent(
      BIZ,
      CONN,
      EVENT,
      deps({ hydrate: vi.fn().mockResolvedValue(appt({ canceled: true })) })
    );
    const canceled = vi.mocked(processWebhookFlowEvent).mock.calls[0][1] as { eventId: string };
    expect(canceled.eventId).not.toBe(standing.eventId);
  });

  it("hands the flow channel the body under `data`, which is what matching reads", async () => {
    // The field name is load-bearing: trigger conditions and lead recording
    // read `data`. Under any other key the run enqueues but sees an empty
    // window text and matches nothing.
    await processAcuityWebhookEvent(BIZ, CONN, EVENT, deps());
    const passed = vi.mocked(processWebhookFlowEvent).mock.calls[0][1] as {
      data?: Record<string, string>;
      source: string;
    };
    expect(passed.source).toBe("acuity");
    expect(passed.data).toEqual(EVENT.raw);
  });

  it("falls back to a stable key when there is no appointment to qualify with", async () => {
    await processAcuityWebhookEvent(
      BIZ,
      CONN,
      EVENT,
      deps({ hydrate: vi.fn().mockResolvedValue(null) })
    );
    const ev = vi.mocked(processWebhookFlowEvent).mock.calls[0][1] as { eventId: string };
    expect(ev.eventId).toBe("acuity:scheduled:500:unknown");
  });

  it("tolerates a flow result with no count", async () => {
    vi.mocked(processWebhookFlowEvent).mockResolvedValue(null as never);
    const res = await processAcuityWebhookEvent(BIZ, CONN, EVENT, deps());
    expect(res.flowRunsEnqueued).toBe(0);
  });
});

describe("syncAcuityContact", () => {
  // Acuity has no customer event type, so this is the only path by which a
  // walk-in booked on the merchant's own page becomes a contact.
  beforeEach(() => {
    vi.mocked(getCustomerMemory).mockResolvedValue(null as never);
    vi.mocked(createCustomerMemory).mockResolvedValue({} as never);
    vi.mocked(updateCustomerOwnerFields).mockResolvedValue(undefined as never);
  });

  it("creates a contact for a new caller", async () => {
    await expect(syncAcuityContact(BIZ, appt() as never)).resolves.toBe(true);
    expect(vi.mocked(createCustomerMemory)).toHaveBeenCalledWith(BIZ, {
      customerE164: "+15551234567",
      displayName: "Sam Rivera",
      email: "sam@example.org"
    });
  });

  it("does nothing without a phone, which is the contact key", async () => {
    await expect(
      syncAcuityContact(BIZ, appt({ customerPhone: null }) as never)
    ).resolves.toBe(false);
    expect(vi.mocked(createCustomerMemory)).not.toHaveBeenCalled();
  });

  it("is FILL-ONLY: never overwrites what the owner already set", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue({
      display_name: "Owner's preferred name",
      email: "owner-set@example.org"
    } as never);
    await expect(syncAcuityContact(BIZ, appt() as never)).resolves.toBe(false);
    expect(vi.mocked(updateCustomerOwnerFields)).not.toHaveBeenCalled();
  });

  it("fills a blank name on an existing contact", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue({
      display_name: null,
      email: "already@example.org"
    } as never);
    await expect(syncAcuityContact(BIZ, appt() as never)).resolves.toBe(true);
    expect(vi.mocked(updateCustomerOwnerFields)).toHaveBeenCalledWith(BIZ, "+15551234567", {
      displayName: "Sam Rivera"
    });
  });

  it("fills only the blanks on an existing contact", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue({
      display_name: "Kept",
      email: null
    } as never);
    await expect(syncAcuityContact(BIZ, appt() as never)).resolves.toBe(true);
    expect(vi.mocked(updateCustomerOwnerFields)).toHaveBeenCalledWith(BIZ, "+15551234567", {
      email: "sam@example.org"
    });
  });

  it("RE-READS after losing the create race, so it cannot clobber the winner", async () => {
    // The pre-race snapshot says "blank"; the row is not blank any more.
    vi.mocked(getCustomerMemory)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({
        display_name: "Winner's name",
        email: "winner@example.org"
      } as never);
    vi.mocked(createCustomerMemory).mockRejectedValue(new CustomerExistsError("exists"));
    await expect(syncAcuityContact(BIZ, appt() as never)).resolves.toBe(false);
    expect(vi.mocked(updateCustomerOwnerFields)).not.toHaveBeenCalled();
  });

  it("still fills the blanks the race winner left empty", async () => {
    vi.mocked(getCustomerMemory)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({ display_name: "Winner", email: null } as never);
    vi.mocked(createCustomerMemory).mockRejectedValue(new CustomerExistsError("exists"));
    await expect(syncAcuityContact(BIZ, appt() as never)).resolves.toBe(true);
    expect(vi.mocked(updateCustomerOwnerFields)).toHaveBeenCalledWith(BIZ, "+15551234567", {
      email: "sam@example.org"
    });
  });

  it("creates a contact with no email when Acuity has none", async () => {
    await expect(
      syncAcuityContact(BIZ, appt({ customerEmail: null }) as never)
    ).resolves.toBe(true);
    expect(vi.mocked(createCustomerMemory)).toHaveBeenCalledWith(BIZ, {
      customerE164: "+15551234567",
      displayName: "Sam Rivera",
      email: null
    });
  });

  it("rethrows a create failure that is NOT the race", async () => {
    vi.mocked(createCustomerMemory).mockRejectedValue(new Error("db down"));
    await expect(syncAcuityContact(BIZ, appt() as never)).resolves.toBe(false);
  });

  it("never throws when the contact store is unavailable", async () => {
    vi.mocked(getCustomerMemory).mockRejectedValue(new Error("db down"));
    await expect(syncAcuityContact(BIZ, appt() as never)).resolves.toBe(false);
  });
});

describe("default wiring", () => {
  it("uses its own transports and effect modules when no deps are injected", async () => {
    hydrateMock.mockResolvedValue(appt());
    recordObsMock.mockResolvedValue([{ appointmentId: "500", kind: "new", updatedIso: null }]);
    fireGoalsMock.mockResolvedValue({ goalsFired: 1, jumpedRuns: 0 });
    fireTriggersMock.mockResolvedValue(3);
    recordClaimMock.mockResolvedValue(undefined);
    deleteClaimsMock.mockResolvedValue(undefined);
    claimStartsMock.mockResolvedValue([]);
    resolveWaitlistMock.mockResolvedValue(undefined);
    vi.mocked(getCustomerMemory).mockResolvedValue(null as never);
    vi.mocked(createCustomerMemory).mockResolvedValue({} as never);

    const res = await processAcuityAppointmentEvent(BIZ, CONN, EVENT);
    expect(hydrateMock).toHaveBeenCalled();
    expect(recordObsMock).toHaveBeenCalled();
    expect(fireGoalsMock).toHaveBeenCalled();
    expect(fireTriggersMock).toHaveBeenCalled();
    expect(recordClaimMock).toHaveBeenCalled();
    expect(resolveWaitlistMock).toHaveBeenCalled();
    expect(res).toMatchObject({ hydrated: true, triggerRunsEnqueued: 3, ledgerSynced: true });
  });

  it("uses its own cancel-path transports too", async () => {
    hydrateMock.mockResolvedValue(appt({ canceled: true }));
    recordObsMock.mockResolvedValue([{ appointmentId: "500", kind: "canceled", updatedIso: "X" }]);
    fireTriggersMock.mockResolvedValue(0);
    claimStartsMock.mockResolvedValue(["2026-08-09T19:00:00.000Z"]);
    deleteClaimsMock.mockResolvedValue(undefined);
    cancelWaitlistMock.mockResolvedValue(undefined);
    offerSlotMock.mockResolvedValue(undefined);

    await processAcuityAppointmentEvent(BIZ, CONN, { ...EVENT, action: "canceled" });
    expect(claimStartsMock).toHaveBeenCalled();
    expect(deleteClaimsMock).toHaveBeenCalled();
    expect(cancelWaitlistMock).toHaveBeenCalled();
    expect(offerSlotMock).toHaveBeenCalled();
  });
});

describe("errorText", () => {
  it("uses an Error's message, and stringifies anything else", async () => {
    // Extracted from a dozen identical catch-block ternaries; covering it
    // once here is the point of having one copy.
    const { errorText } = await vi.importActual<typeof import("@/lib/acuity/errors")>(
      "@/lib/acuity/errors"
    );
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("a string throw")).toBe("a string throw");
    expect(errorText(undefined)).toBe("undefined");
  });
});
