/**
 * Tests for the Vagaro webhook processing lib (src/lib/vagaro/webhook.ts):
 * token comparison, body parsing, phone normalization, contact sync
 * semantics (create vs fill-only), the appointment booking-intelligence
 * half (goals, real-time calendar triggers, ledger sync), and the
 * flow-event + sync orchestration.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai-flows/webhook-events", () => ({ processWebhookFlowEvent: vi.fn() }));
vi.mock("@/lib/customer-memory/db", () => ({
  CustomerExistsError: class CustomerExistsError extends Error {},
  getCustomerMemory: vi.fn(),
  createCustomerMemory: vi.fn(),
  updateCustomerOwnerFields: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn() }));
vi.mock("@/lib/ai-flows/booking-goal-fire", () => ({
  fireBookingGoalsForIdentities: vi.fn()
}));
vi.mock("@/lib/ai-flows/calendar-poll", () => ({
  fireCalendarTriggersForPushedEvent: vi.fn()
}));
vi.mock("@/lib/calendar-tools/booking-dedupe", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordExternalBookingClaim: vi.fn(),
  deleteBookingClaimsByEvent: vi.fn()
}));

import {
  extractVagaroAppointment,
  extractVagaroAppointmentId,
  extractVagaroCustomer,
  normalizeVagaroPhone,
  parseVagaroWebhookBody,
  processVagaroAppointmentEvent,
  processVagaroWebhookEvent,
  syncVagaroCustomer,
  verificationTokenMatches,
  type VagaroWebhookEvent
} from "@/lib/vagaro/webhook";
import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";
import {
  createCustomerMemory,
  CustomerExistsError,
  getCustomerMemory,
  updateCustomerOwnerFields
} from "@/lib/customer-memory/db";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";

function customerEvent(
  payload: Record<string, unknown>,
  overrides: Partial<VagaroWebhookEvent> = {}
): VagaroWebhookEvent {
  return {
    id: "evt-1",
    type: "customer",
    action: "created",
    payload,
    raw: { id: "evt-1", type: "customer", action: "created", payload },
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processWebhookFlowEvent).mockResolvedValue({
    enqueued: 1,
    flowsEvaluated: 2,
    flowsMatched: 1
  });
  vi.mocked(getCustomerMemory).mockResolvedValue(null);
});

describe("verificationTokenMatches", () => {
  it("matches equal tokens and rejects different or different-length ones", () => {
    expect(verificationTokenMatches("abc123", "abc123")).toBe(true);
    expect(verificationTokenMatches("abc123", "abc124")).toBe(false);
    expect(verificationTokenMatches("short", "longer-token")).toBe(false);
  });
});

describe("parseVagaroWebhookBody", () => {
  it("returns null for non-object or empty bodies", () => {
    expect(parseVagaroWebhookBody(null)).toBeNull();
    expect(parseVagaroWebhookBody("string")).toBeNull();
    expect(parseVagaroWebhookBody([1, 2])).toBeNull();
    expect(parseVagaroWebhookBody({})).toBeNull();
  });

  it("normalizes id/type/action across field aliases", () => {
    expect(
      parseVagaroWebhookBody({
        id: "evt-1",
        type: "appointment",
        action: "created",
        payload: { a: 1 }
      })
    ).toEqual({
      id: "evt-1",
      type: "appointment",
      action: "created",
      payload: { a: 1 },
      raw: { id: "evt-1", type: "appointment", action: "created", payload: { a: 1 } }
    });

    const aliased = parseVagaroWebhookBody({
      eventId: "evt-2",
      resourceType: "customer",
      payload: "not an object"
    });
    expect(aliased?.id).toBe("evt-2");
    expect(aliased?.type).toBe("customer");
    expect(aliased?.action).toBeNull();
    expect(aliased?.payload).toEqual({});
  });
});

describe("normalizeVagaroPhone", () => {
  it("handles E.164, US 10/11-digit, and junk", () => {
    expect(normalizeVagaroPhone(null)).toBeNull();
    expect(normalizeVagaroPhone("+1 (555) 123-0000")).toBe("+15551230000");
    expect(normalizeVagaroPhone("(555) 123-0000")).toBe("+15551230000");
    expect(normalizeVagaroPhone("15551230000")).toBe("+15551230000");
    expect(normalizeVagaroPhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizeVagaroPhone("+123")).toBeNull(); // too short after +
    expect(normalizeVagaroPhone("12345")).toBeNull();
    expect(normalizeVagaroPhone("22345678901")).toBeNull(); // 11 digits not starting with 1
  });
});

describe("extractVagaroCustomer", () => {
  it("prefers the nested customer object and assembles first/last names", () => {
    expect(
      extractVagaroCustomer({
        customer: {
          firstName: "Joe",
          lastName: "Plumber",
          mobilePhone: "555-123-0000",
          email: "Joe@Example.com"
        }
      })
    ).toEqual({ phone: "+15551230000", name: "Joe Plumber", email: "joe@example.com" });
  });

  it("falls back to flat payload fields and alternate keys", () => {
    expect(
      extractVagaroCustomer({ name: "Jane D", phoneNumber: "5551230001" })
    ).toEqual({ phone: "+15551230001", name: "Jane D", email: null });

    expect(
      extractVagaroCustomer({ fullName: "Full Name", cellPhone: "5551230002" })
    ).toEqual({ phone: "+15551230002", name: "Full Name", email: null });

    expect(extractVagaroCustomer({ firstName: "Solo", phone: "bad" })).toEqual({
      phone: null,
      name: "Solo",
      email: null
    });

    expect(extractVagaroCustomer({})).toEqual({ phone: null, name: null, email: null });
  });
});

describe("syncVagaroCustomer", () => {
  it("ignores non-customer events, delete actions, and phone-less customers", async () => {
    await syncVagaroCustomer(BIZ, customerEvent({}, { type: "appointment" }));
    await syncVagaroCustomer(BIZ, customerEvent({}, { action: "deleted" }));
    await syncVagaroCustomer(BIZ, customerEvent({ name: "No Phone" }));
    expect(getCustomerMemory).not.toHaveBeenCalled();
    expect(createCustomerMemory).not.toHaveBeenCalled();
  });

  it("creates a profile for a new customer", async () => {
    await syncVagaroCustomer(
      BIZ,
      customerEvent({ name: "Joe", phone: "5551230000", email: "joe@example.com" })
    );
    expect(createCustomerMemory).toHaveBeenCalledWith(BIZ, {
      customerE164: "+15551230000",
      displayName: "Joe",
      email: "joe@example.com"
    });
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
  });

  it("re-reads after an already-exists race and still applies this delivery's fields", async () => {
    const ExistsCtor = CustomerExistsError as unknown as new (e164: string) => Error;
    vi.mocked(createCustomerMemory).mockRejectedValueOnce(new ExistsCtor("+15551230000"));
    vi.mocked(getCustomerMemory)
      .mockResolvedValueOnce(null) // pre-create existence check
      .mockResolvedValueOnce({
        customer_e164: "+15551230000",
        display_name: null,
        email: null
      } as never); // post-race re-read
    await syncVagaroCustomer(BIZ, customerEvent({ name: "Joe", phone: "5551230000" }));
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(BIZ, "+15551230000", {
      displayName: "Joe"
    });
  });

  it("gives up gracefully when the post-race re-read finds nothing", async () => {
    const ExistsCtor = CustomerExistsError as unknown as new (e164: string) => Error;
    vi.mocked(createCustomerMemory).mockRejectedValueOnce(new ExistsCtor("+15551230000"));
    vi.mocked(getCustomerMemory).mockResolvedValue(null);
    await syncVagaroCustomer(BIZ, customerEvent({ name: "Joe", phone: "5551230000" }));
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
  });

  it("rethrows non-race create failures", async () => {
    vi.mocked(createCustomerMemory).mockRejectedValueOnce(new Error("db down"));
    await expect(
      syncVagaroCustomer(BIZ, customerEvent({ phone: "5551230000" }))
    ).rejects.toThrow(/db down/);
  });

  it("fills only the MISSING fields on an existing profile", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue({
      customer_e164: "+15551230000",
      display_name: null,
      email: "kept@example.com"
    } as never);
    await syncVagaroCustomer(
      BIZ,
      customerEvent(
        { name: "Joe", phone: "5551230000", email: "new@example.com" },
        { action: "updated" }
      )
    );
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(BIZ, "+15551230000", {
      displayName: "Joe"
    });
  });

  it("no-ops when the existing profile already has both fields", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue({
      customer_e164: "+15551230000",
      display_name: "Saved Name",
      email: "kept@example.com"
    } as never);
    await syncVagaroCustomer(
      BIZ,
      customerEvent({ name: "Joe", phone: "5551230000", email: "new@example.com" })
    );
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
  });

  it("fills a missing email even when the payload carries no name", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue({
      customer_e164: "+15551230000",
      display_name: "Saved Name",
      email: null
    } as never);
    await syncVagaroCustomer(
      BIZ,
      customerEvent({ phone: "5551230000", email: "new@example.com" })
    );
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(BIZ, "+15551230000", {
      email: "new@example.com"
    });
  });

  it("no-ops on an existing profile when the payload has neither name nor email", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue({
      customer_e164: "+15551230000",
      display_name: null,
      email: null
    } as never);
    await syncVagaroCustomer(BIZ, customerEvent({ phone: "5551230000" }));
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
  });
});

describe("processVagaroWebhookEvent", () => {
  it("starts flows with source vagaro + the event id and reports the counts", async () => {
    const event = customerEvent({ phone: "5551230000" });
    const result = await processVagaroWebhookEvent(BIZ, event);
    expect(processWebhookFlowEvent).toHaveBeenCalledWith(BIZ, {
      source: "vagaro",
      data: event.raw,
      eventId: "evt-1"
    });
    expect(result).toEqual({
      enqueued: 1,
      flowsEvaluated: 2,
      flowsMatched: 1,
      contactSynced: true,
      goalsFired: 0,
      jumpedRuns: 0,
      triggerRunsEnqueued: 0,
      ledgerSynced: false
    });
  });

  it("passes an undefined eventId when Vagaro omits one", async () => {
    const event = customerEvent({}, { id: null, type: "appointment" });
    const result = await processVagaroWebhookEvent(BIZ, event);
    expect(processWebhookFlowEvent).toHaveBeenCalledWith(BIZ, {
      source: "vagaro",
      data: event.raw,
      eventId: undefined
    });
    expect(result.contactSynced).toBe(false);
  });

  it("still runs the contact sync when flow processing fails, then rethrows for redelivery", async () => {
    vi.mocked(processWebhookFlowEvent).mockRejectedValueOnce(new Error("flow engine down"));
    await expect(
      processVagaroWebhookEvent(BIZ, customerEvent({ name: "Joe", phone: "5551230000" }))
    ).rejects.toThrow(/flow engine down/);
    // The sync half already applied this delivery's contact.
    expect(createCustomerMemory).toHaveBeenCalledWith(BIZ, {
      customerE164: "+15551230000",
      displayName: "Joe",
      email: null
    });
  });

  it("logs a contact-sync failure without losing the flow result", async () => {
    vi.mocked(getCustomerMemory).mockRejectedValueOnce("weird failure");
    const result = await processVagaroWebhookEvent(
      BIZ,
      customerEvent({ phone: "5551230000" })
    );
    expect(result.enqueued).toBe(1);
    expect(result.contactSynced).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "vagaro webhook contact sync failed",
      expect.objectContaining({ businessId: BIZ, error: "weird failure" })
    );

    vi.mocked(getCustomerMemory).mockRejectedValueOnce(new Error("db down"));
    await processVagaroWebhookEvent(BIZ, customerEvent({ phone: "5551230000" }));
    expect(logger.warn).toHaveBeenLastCalledWith(
      "vagaro webhook contact sync failed",
      expect.objectContaining({ error: "db down" })
    );
  });

  it("merges the appointment-intelligence counters into the result", async () => {
    const deps = {
      getDb: vi.fn().mockResolvedValue({} as never),
      fireGoals: vi.fn().mockResolvedValue({ goalsFired: 2, jumpedRuns: 1 }),
      fireTriggers: vi.fn().mockResolvedValue(3),
      recordClaim: vi.fn(),
      deleteClaims: vi.fn()
    };
    const result = await processVagaroWebhookEvent(
      BIZ,
      apptEvent({ action: "created" }),
      deps as never
    );
    expect(result).toMatchObject({
      enqueued: 1,
      goalsFired: 2,
      jumpedRuns: 1,
      triggerRunsEnqueued: 3,
      ledgerSynced: true
    });
  });
});

// ── Appointment booking intelligence ────────────────────────────────────────

function apptPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appointment: {
      id: "appt-1",
      startTime: "2026-07-21T15:00:00Z",
      endTime: "2026-07-21T15:30:00Z",
      serviceName: "Gel Manicure",
      customer: { name: "Dana Doe", phone: "6025550000", email: "dana@example.com" },
      ...overrides
    }
  };
}

function apptEvent(
  overrides: Partial<VagaroWebhookEvent> = {},
  payload: Record<string, unknown> = apptPayload()
): VagaroWebhookEvent {
  return {
    id: "evt-appt-1",
    type: "appointment",
    action: "created",
    payload,
    raw: { id: "evt-appt-1", type: "appointment", payload },
    ...overrides
  };
}

describe("extractVagaroAppointment / extractVagaroAppointmentId", () => {
  it("reads the nested appointment object or the flat payload", () => {
    expect(extractVagaroAppointment(apptPayload())).toMatchObject({
      id: "appt-1",
      startIso: "2026-07-21T15:00:00.000Z",
      customerName: "Dana Doe"
    });
    expect(
      extractVagaroAppointment({ id: "appt-2", startTime: "2026-07-21T16:00:00Z" })
    ).toMatchObject({ id: "appt-2" });
    expect(extractVagaroAppointment({ note: "no appointment" })).toBeNull();
  });

  it("recovers the bare id across aliases even without a start", () => {
    expect(extractVagaroAppointmentId({ appointment: { id: "appt-1" } })).toBe("appt-1");
    expect(extractVagaroAppointmentId({ appointmentId: "appt-2" })).toBe("appt-2");
    expect(extractVagaroAppointmentId({})).toBeNull();
  });
});

describe("processVagaroAppointmentEvent", () => {
  const NOW = Date.parse("2026-07-21T12:00:00.000Z");

  function deps(overrides: Record<string, unknown> = {}) {
    return {
      getDb: vi.fn().mockResolvedValue({ db: true } as never),
      fireGoals: vi.fn().mockResolvedValue({ goalsFired: 1, jumpedRuns: 0 }),
      fireTriggers: vi.fn().mockResolvedValue(0),
      recordClaim: vi.fn(),
      deleteClaims: vi.fn(),
      nowMs: NOW,
      ...overrides
    };
  }

  const ZEROS = {
    goalsFired: 0,
    jumpedRuns: 0,
    triggerRunsEnqueued: 0,
    ledgerSynced: false
  };

  it("no-ops for non-appointment events and id-less appointment payloads", async () => {
    const d = deps();
    expect(
      await processVagaroAppointmentEvent(BIZ, customerEvent({ phone: "5551230000" }), d)
    ).toEqual(ZEROS);
    expect(
      await processVagaroAppointmentEvent(BIZ, apptEvent({}, { note: "empty" }), d)
    ).toEqual(ZEROS);
    expect(d.fireGoals).not.toHaveBeenCalled();
    expect(d.fireTriggers).not.toHaveBeenCalled();
    expect(d.recordClaim).not.toHaveBeenCalled();
    expect(d.deleteClaims).not.toHaveBeenCalled();
  });

  it("created: fires goals + event_created trigger + records the ledger claim", async () => {
    const d = deps({
      fireGoals: vi.fn().mockResolvedValue({ goalsFired: 2, jumpedRuns: 2 }),
      fireTriggers: vi.fn().mockResolvedValue(1)
    });
    const result = await processVagaroAppointmentEvent(BIZ, apptEvent(), d);
    expect(result).toEqual({
      goalsFired: 2,
      jumpedRuns: 2,
      triggerRunsEnqueued: 1,
      ledgerSynced: true
    });
    expect(d.fireGoals).toHaveBeenCalledWith({ db: true }, BIZ, [
      { phone: "6025550000", email: "dana@example.com" }
    ]);
    // The pushed event defaults createdIso to the delivery moment when the
    // payload omits it (eventCreatedDue gates on it).
    const [, , ev, nowArg] = vi.mocked(d.fireTriggers).mock.calls[0];
    expect(ev).toMatchObject({
      id: "appt-1",
      cancelled: false,
      createdIso: new Date(NOW).toISOString()
    });
    expect(nowArg).toBe(NOW);
    expect(d.recordClaim).toHaveBeenCalledWith(
      BIZ,
      "phone:6025550000",
      "2026-07-21T15:00:00.000Z",
      "appt-1"
    );
    expect(d.deleteClaims).not.toHaveBeenCalled();
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_flow_goal_jumped_booking",
        message: expect.stringContaining("Vagaro booking moved 2 flow run(s)")
      })
    );
  });

  it("created: keeps the payload's own creation timestamp when present", async () => {
    const d = deps();
    await processVagaroAppointmentEvent(
      BIZ,
      apptEvent({}, apptPayload({ createdAt: "2026-07-21T11:58:00Z" })),
      d
    );
    const [, , ev] = vi.mocked(d.fireTriggers).mock.calls[0];
    expect(ev).toMatchObject({ createdIso: "2026-07-21T11:58:00.000Z" });
  });

  it("created without any customer identity: skips goals, still fires trigger + ledger", async () => {
    const d = deps();
    const result = await processVagaroAppointmentEvent(
      BIZ,
      apptEvent({}, apptPayload({ customer: { name: "Walk In" } })),
      d
    );
    expect(d.fireGoals).not.toHaveBeenCalled();
    expect(d.fireTriggers).toHaveBeenCalled();
    expect(d.recordClaim).toHaveBeenCalledWith(
      BIZ,
      "name:walk in",
      "2026-07-21T15:00:00.000Z",
      "appt-1"
    );
    expect(result.ledgerSynced).toBe(true);
  });

  it("created: a goal-firing failure logs and never blocks triggers or ledger", async () => {
    const d = deps({ fireGoals: vi.fn().mockRejectedValue(new Error("goals sad")) });
    const result = await processVagaroAppointmentEvent(BIZ, apptEvent(), d);
    expect(logger.warn).toHaveBeenCalledWith(
      "vagaro webhook: booking goal firing failed",
      expect.objectContaining({ businessId: BIZ, appointmentId: "appt-1", error: "goals sad" })
    );
    expect(d.fireTriggers).toHaveBeenCalled();
    expect(result.ledgerSynced).toBe(true);
    expect(result.goalsFired).toBe(0);

    // Non-Error failures are stringified.
    const d2 = deps({ fireGoals: vi.fn().mockRejectedValue("goal string sad") });
    await processVagaroAppointmentEvent(BIZ, apptEvent(), d2);
    expect(logger.warn).toHaveBeenCalledWith(
      "vagaro webhook: booking goal firing failed",
      expect.objectContaining({ error: "goal string sad" })
    );
  });

  it("created: a trigger-firing failure logs and never blocks the ledger", async () => {
    const d = deps({ fireTriggers: vi.fn().mockRejectedValue(new Error("triggers sad")) });
    const result = await processVagaroAppointmentEvent(BIZ, apptEvent(), d);
    expect(logger.warn).toHaveBeenCalledWith(
      "vagaro webhook: calendar trigger firing failed",
      expect.objectContaining({ businessId: BIZ, appointmentId: "appt-1", error: "triggers sad" })
    );
    expect(result.triggerRunsEnqueued).toBe(0);
    expect(result.ledgerSynced).toBe(true);

    const d2 = deps({ fireTriggers: vi.fn().mockRejectedValue("trigger string sad") });
    await processVagaroAppointmentEvent(BIZ, apptEvent(), d2);
    expect(logger.warn).toHaveBeenCalledWith(
      "vagaro webhook: calendar trigger firing failed",
      expect.objectContaining({ error: "trigger string sad" })
    );
  });

  it("updated: moves the ledger claim (drop + re-record), no goals or triggers", async () => {
    const d = deps();
    const result = await processVagaroAppointmentEvent(
      BIZ,
      apptEvent({ action: "updated" }, apptPayload({ startTime: "2026-07-22T10:00:00Z" })),
      d
    );
    expect(d.fireGoals).not.toHaveBeenCalled();
    expect(d.fireTriggers).not.toHaveBeenCalled();
    expect(d.deleteClaims).toHaveBeenCalledWith(BIZ, "appt-1");
    expect(d.recordClaim).toHaveBeenCalledWith(
      BIZ,
      "phone:6025550000",
      "2026-07-22T10:00:00.000Z",
      "appt-1"
    );
    expect(result.ledgerSynced).toBe(true);
  });

  it("deleted: fires event_canceled trigger and drops the ledger claims", async () => {
    const d = deps({ fireTriggers: vi.fn().mockResolvedValue(2) });
    const result = await processVagaroAppointmentEvent(
      BIZ,
      apptEvent({ action: "deleted" }),
      d
    );
    expect(d.fireGoals).not.toHaveBeenCalled();
    const [, , ev] = vi.mocked(d.fireTriggers).mock.calls[0];
    expect(ev).toMatchObject({
      cancelled: true,
      updatedIso: new Date(NOW).toISOString()
    });
    expect(d.deleteClaims).toHaveBeenCalledWith(BIZ, "appt-1");
    expect(d.recordClaim).not.toHaveBeenCalled();
    expect(result).toEqual({
      goalsFired: 0,
      jumpedRuns: 0,
      triggerRunsEnqueued: 2,
      ledgerSynced: true
    });
  });

  it("deleted: keeps the payload's own modification timestamp when present", async () => {
    const d = deps();
    await processVagaroAppointmentEvent(
      BIZ,
      apptEvent({ action: "canceled" }, apptPayload({ updatedAt: "2026-07-21T11:59:00Z" })),
      d
    );
    const [, , ev] = vi.mocked(d.fireTriggers).mock.calls[0];
    expect(ev).toMatchObject({ cancelled: true, updatedIso: "2026-07-21T11:59:00.000Z" });
  });

  it("created with a cancelled status in the payload is treated as gone", async () => {
    const d = deps();
    const result = await processVagaroAppointmentEvent(
      BIZ,
      apptEvent({}, apptPayload({ status: "cancelled" })),
      d
    );
    expect(d.fireGoals).not.toHaveBeenCalled();
    const [, , ev] = vi.mocked(d.fireTriggers).mock.calls[0];
    expect(ev).toMatchObject({ cancelled: true });
    expect(d.deleteClaims).toHaveBeenCalledWith(BIZ, "appt-1");
    expect(result.ledgerSynced).toBe(true);
  });

  it("deleted with only a bare id still drops the ledger claims (no trigger event)", async () => {
    const d = deps();
    const result = await processVagaroAppointmentEvent(
      BIZ,
      apptEvent({ action: "deleted" }, { appointment: { id: "appt-9" } }),
      d
    );
    expect(d.fireTriggers).not.toHaveBeenCalled();
    expect(d.deleteClaims).toHaveBeenCalledWith(BIZ, "appt-9");
    expect(result.ledgerSynced).toBe(true);
  });

  it("a ledger failure logs and leaves ledgerSynced false", async () => {
    const d = deps({ deleteClaims: vi.fn().mockRejectedValue(new Error("ledger sad")) });
    const result = await processVagaroAppointmentEvent(
      BIZ,
      apptEvent({ action: "deleted" }),
      d
    );
    expect(result.ledgerSynced).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "vagaro webhook: booking ledger sync failed",
      expect.objectContaining({ businessId: BIZ, appointmentId: "appt-1", error: "ledger sad" })
    );

    const d2 = deps({ recordClaim: vi.fn().mockRejectedValue("ledger string sad") });
    const r2 = await processVagaroAppointmentEvent(BIZ, apptEvent(), d2);
    expect(r2.ledgerSynced).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "vagaro webhook: booking ledger sync failed",
      expect.objectContaining({ error: "ledger string sad" })
    );
  });

  it("an unknown or missing action with a standing appointment touches nothing", async () => {
    const d = deps();
    expect(
      await processVagaroAppointmentEvent(BIZ, apptEvent({ action: "reminder_sent" }), d)
    ).toEqual(ZEROS);
    expect(await processVagaroAppointmentEvent(BIZ, apptEvent({ action: null }), d)).toEqual(
      ZEROS
    );
    expect(d.fireGoals).not.toHaveBeenCalled();
    expect(d.fireTriggers).not.toHaveBeenCalled();
    expect(d.recordClaim).not.toHaveBeenCalled();
    expect(d.deleteClaims).not.toHaveBeenCalled();
  });

  it("falls back to payload-level customer identity for goals and the ledger key", async () => {
    const d = deps();
    await processVagaroAppointmentEvent(
      BIZ,
      apptEvent(
        {},
        {
          appointment: { id: "appt-1", startTime: "2026-07-21T15:00:00Z" },
          customer: { name: "Top Level", phone: "6025559999", email: "top@example.com" }
        }
      ),
      d
    );
    // extractVagaroCustomer normalizes the payload-level phone to E.164.
    expect(d.fireGoals).toHaveBeenCalledWith({ db: true }, BIZ, [
      { phone: "+16025559999", email: "top@example.com" }
    ]);
    expect(d.recordClaim).toHaveBeenCalledWith(
      BIZ,
      "phone:+16025559999",
      "2026-07-21T15:00:00.000Z",
      "appt-1"
    );
  });
});
