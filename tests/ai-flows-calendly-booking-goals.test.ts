/**
 * Calendly booking → appointment_booked goal sweep
 * (src/lib/ai-flows/calendly-booking-goals.ts): candidate selection (goal
 * flows, jumpable runs, Calendly connection), created-lookback gating,
 * invitee → phone resolution (SMS number + email fallback + contact-row
 * fan-out), goal firing, caps, and failure isolation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/nango/workspace", () => ({ nangoProxyForBusiness: vi.fn() }));
vi.mock("@/lib/voice-tools/connections", () => ({
  resolveCalendarConnection: vi.fn(),
  isWorkspaceCalendarProvider: (p: string) => p === "google" || p === "microsoft"
}));
vi.mock("@/lib/calendar-tools/shared-calendar", () => ({ getSharedCalendar: vi.fn() }));
vi.mock("@/lib/ai-flows/db", () => ({ enqueueAiFlowRun: vi.fn() }));
vi.mock("@/lib/calendar-tools/calendly", () => ({ calendlyRequest: vi.fn() }));
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn() }));
vi.mock("@/lib/db/contact-emails", () => ({ findContactsByEmails: vi.fn() }));
vi.mock("@/lib/calendly/webhook-subscriptions", () => ({
  ensureCalendlyWebhookSubscription: vi
    .fn()
    .mockResolvedValue({ status: "unsupported", attempted: false })
}));

import {
  BOOKING_GOAL_FLOW_PAGE,
  BOOKING_GOAL_INVITEE_FETCH_CAP,
  BOOKING_GOAL_RUN_STATUSES,
  bookingCreatedRecently,
  definitionWatchesBookingGoal,
  fireBookingGoalsForInvitees,
  inviteePhoneE164,
  sweepCalendlyBookingGoals,
  type BookingGoalSweepDeps
} from "@/lib/ai-flows/calendly-booking-goals";
import { ensureCalendlyWebhookSubscription } from "@/lib/calendly/webhook-subscriptions";
import { CALENDAR_CREATED_LOOKBACK_MINUTES } from "@/lib/ai-flows/calendar-poll";
import { CALENDLY_POLL_PAGE_COUNT } from "@/lib/ai-flows/calendly-poll";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const BIZ2 = "22222222-2222-4222-8222-222222222222";
const CONN = {
  provider: "calendly" as const,
  providerConfigKey: "calendly-direct",
  connectionId: "cx-1"
};
const USER_RES = { data: { resource: { uri: "https://api.calendly.com/users/U1" } } };

/** ISO string `minutes` ago (negative = in the future). */
function isoAgoMin(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function goalFlowRow(id: string, businessId = BIZ) {
  return {
    id,
    business_id: businessId,
    definition: {
      version: 1,
      trigger: { channel: "webhook", conditions: [] },
      steps: [
        { id: "s1", type: "send_sms", to: "{{vars.lead_phone}}", body: "hi" },
        {
          id: "s_goal",
          type: "goal",
          label: "Lead replied or booked",
          events: [{ kind: "replied" }, { kind: "appointment_booked" }]
        }
      ]
    }
  };
}

function booking(uuid: string, createdIso: string) {
  return {
    uri: `https://api.calendly.com/scheduled_events/${uuid}`,
    created_at: createdIso
  };
}

type QueuedResult = {
  data?: unknown;
  error?: { message: string } | null;
  reject?: unknown;
};

type ChainCall = { name: string; args: unknown[] };

/**
 * Table-routed chainable client fake: each from(table) chain consumes the
 * next queued result for that table when a terminal method
 * (range/limit/maybeSingle) runs.
 */
function fakeDb(queues: Record<string, QueuedResult[]>) {
  const chains: Array<{ table: string; calls: ChainCall[] }> = [];
  const db = {
    from(table: string) {
      const rec = { table, calls: [] as ChainCall[] };
      chains.push(rec);
      const q = queues[table] ?? [];
      const finish = () => {
        const r = q.shift() ?? { data: null, error: null };
        if (r.reject) return Promise.reject(r.reject);
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
      };
      const chain: Record<string, (...args: unknown[]) => unknown> = {};
      for (const m of ["select", "eq", "filter", "order", "in", "or"]) {
        chain[m] = (...args: unknown[]) => {
          rec.calls.push({ name: m, args });
          return chain;
        };
      }
      for (const m of ["range", "limit", "maybeSingle"]) {
        chain[m] = (...args: unknown[]) => {
          rec.calls.push({ name: m, args });
          return finish();
        };
      }
      return chain;
    }
  };
  return { db: db as never, chains };
}

function deps(overrides: Partial<BookingGoalSweepDeps> = {}): BookingGoalSweepDeps {
  return {
    request: vi.fn().mockResolvedValue(null),
    resolveConnection: vi.fn().mockResolvedValue(CONN),
    applyGoal: vi.fn().mockResolvedValue({ jumpedRuns: 0 }),
    findByEmails: vi.fn().mockResolvedValue(new Map()),
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("definitionWatchesBookingGoal", () => {
  it("matches a trunk goal step watching appointment_booked", () => {
    expect(definitionWatchesBookingGoal(goalFlowRow("f1").definition)).toBe(true);
  });

  it("rejects goals watching other milestones and malformed definitions", () => {
    expect(
      definitionWatchesBookingGoal({
        steps: [{ id: "g", type: "goal", events: [{ kind: "replied" }] }]
      })
    ).toBe(false);
    expect(
      definitionWatchesBookingGoal({
        steps: [{ id: "g", type: "goal", events: [{ kind: "tag_added", tag: "Booked" }] }]
      })
    ).toBe(false);
    expect(definitionWatchesBookingGoal({ steps: [{ id: "s", type: "send_sms" }] })).toBe(false);
    expect(definitionWatchesBookingGoal({ steps: "nope" })).toBe(false);
    expect(definitionWatchesBookingGoal({})).toBe(false);
    expect(definitionWatchesBookingGoal(null)).toBe(false);
  });
});

describe("bookingCreatedRecently", () => {
  it("is true only inside the created lookback", () => {
    const now = Date.now();
    expect(bookingCreatedRecently(new Date(now - 60_000).toISOString(), now)).toBe(true);
    expect(
      bookingCreatedRecently(
        new Date(now - (CALENDAR_CREATED_LOOKBACK_MINUTES + 1) * 60_000).toISOString(),
        now
      )
    ).toBe(false);
  });

  it("is false for missing/unparseable created timestamps", () => {
    expect(bookingCreatedRecently(undefined, Date.now())).toBe(false);
    expect(bookingCreatedRecently("not-a-date", Date.now())).toBe(false);
  });
});

describe("inviteePhoneE164", () => {
  it("keeps E.164 (any country) and normalizes loose NANP", () => {
    expect(inviteePhoneE164("+17808039935")).toBe("+17808039935");
    expect(inviteePhoneE164(" +85261234567 ")).toBe("+85261234567");
    expect(inviteePhoneE164("(780) 803-9935")).toBe("+17808039935");
  });

  it("returns null for missing or implausible numbers", () => {
    expect(inviteePhoneE164(undefined)).toBeNull();
    expect(inviteePhoneE164("  ")).toBeNull();
    expect(inviteePhoneE164("12345")).toBeNull();
  });
});

describe("sweepCalendlyBookingGoals", () => {
  it("throws when the first flow-listing page fails", async () => {
    const { db } = fakeDb({ ai_flows: [{ error: { message: "boom" } }] });
    await expect(sweepCalendlyBookingGoals(db, deps())).rejects.toThrow(
      "sweepCalendlyBookingGoals: boom"
    );
  });

  it("keeps flows already listed when a LATER page fails (and logs it)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fullPage = Array.from({ length: BOOKING_GOAL_FLOW_PAGE }, (_, i) =>
      goalFlowRow(`f${i}`)
    );
    const { db } = fakeDb({
      ai_flows: [{ data: fullPage }, { error: { message: "page2 down" } }],
      // No jumpable runs → the business is skipped before any API call.
      ai_flow_runs: [{ data: [] }]
    });
    const d = deps();
    const result = await sweepCalendlyBookingGoals(db, d);
    expect(errSpy).toHaveBeenCalledWith(
      "sweepCalendlyBookingGoals flow listing page",
      "page2 down"
    );
    expect(result).toMatchObject({ businesses: 1, swept: 0, bookings: 0 });
    expect(d.resolveConnection).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("returns zeros when no enabled flow watches the booking goal", async () => {
    const { db } = fakeDb({
      ai_flows: [
        {
          data: [
            {
              id: "f1",
              business_id: BIZ,
              definition: { steps: [{ id: "g", type: "goal", events: [{ kind: "replied" }] }] }
            }
          ]
        }
      ]
    });
    const d = deps();
    const result = await sweepCalendlyBookingGoals(db, d);
    expect(result).toEqual({ businesses: 0, swept: 0, bookings: 0, goalsFired: 0, jumpedRuns: 0 });
    expect(d.resolveConnection).not.toHaveBeenCalled();
  });

  it("uses the service client + production deps when none are injected", async () => {
    const { db } = fakeDb({ ai_flows: [{ data: null }] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db);
    // No args at all: covers the client fallback AND the four production
    // dependency defaults (none is invoked — the listing is empty).
    const result = await sweepCalendlyBookingGoals();
    expect(result.businesses).toBe(0);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });

  it("skips businesses without jumpable runs and non-Calendly connections", async () => {
    const { db, chains } = fakeDb({
      ai_flows: [{ data: [goalFlowRow("f1", BIZ), goalFlowRow("f2", BIZ), goalFlowRow("f3", BIZ2)] }],
      // BIZ: null rows → skip; BIZ2: a jumpable run exists.
      ai_flow_runs: [{ data: null }, { data: [{ id: "run-1" }] }]
    });
    const d = deps({
      resolveConnection: vi
        .fn()
        .mockResolvedValue({ provider: "google", providerConfigKey: "google-calendar", connectionId: "g" })
    });
    const result = await sweepCalendlyBookingGoals(db, d);
    expect(result).toMatchObject({ businesses: 2, swept: 0, bookings: 0 });
    // Both flows of BIZ land in ONE runs check; statuses are the jumpable set.
    const runsChain = chains.find((c) => c.table === "ai_flow_runs")!;
    expect(runsChain.calls.find((c) => c.name === "in" && c.args[0] === "flow_id")?.args[1]).toEqual([
      "f1",
      "f2"
    ]);
    expect(
      runsChain.calls.find((c) => c.name === "in" && c.args[0] === "status")?.args[1]
    ).toEqual([...BOOKING_GOAL_RUN_STATUSES]);
    // Only BIZ2 got as far as connection resolution (google → not swept).
    expect(d.resolveConnection).toHaveBeenCalledTimes(1);
    expect(d.resolveConnection).toHaveBeenCalledWith(BIZ2);
    expect(d.request).not.toHaveBeenCalled();
  });

  it("skips a business whose connection resolves to null", async () => {
    const { db } = fakeDb({
      ai_flows: [{ data: [goalFlowRow("f1")] }],
      ai_flow_runs: [{ data: [{ id: "run-1" }] }]
    });
    const d = deps({ resolveConnection: vi.fn().mockResolvedValue(null) });
    const result = await sweepCalendlyBookingGoals(db, d);
    expect(result).toMatchObject({ swept: 0 });
    expect(d.request).not.toHaveBeenCalled();
  });

  it("logs a per-business failure when the runs check errors — other tenants unaffected", async () => {
    const { db } = fakeDb({
      ai_flows: [{ data: [goalFlowRow("f1", BIZ), goalFlowRow("f2", BIZ2)] }],
      ai_flow_runs: [{ error: { message: "runs down" } }, { data: [] }]
    });
    const result = await sweepCalendlyBookingGoals(db, deps());
    expect(result.businesses).toBe(2);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        level: "error",
        event: "ai_flow_booking_goal_sweep_failed",
        message: expect.stringContaining("runs down")
      })
    );
    // BIZ2 was still processed (its empty runs check just skipped it).
    expect(vi.mocked(recordSystemLog).mock.calls).toHaveLength(1);
  });

  it("treats a refused /users/me (or one without a uri) as not connected", async () => {
    const { db } = fakeDb({
      ai_flows: [{ data: [goalFlowRow("f1")] }],
      ai_flow_runs: [{ data: [{ id: "run-1" }] }]
    });
    const d = deps({ request: vi.fn().mockResolvedValue({ data: { resource: {} } }) });
    await sweepCalendlyBookingGoals(db, d);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        event: "ai_flow_booking_goal_sweep_failed",
        message: expect.stringContaining("calendar_not_connected")
      })
    );
  });

  it("treats a refused scheduled-events listing as not connected", async () => {
    const { db } = fakeDb({
      ai_flows: [{ data: [goalFlowRow("f1")] }],
      ai_flow_runs: [{ data: [{ id: "run-1" }] }]
    });
    const request = vi.fn(async (_b: string, _c: unknown, config: { endpoint: string }) =>
      config.endpoint === "/users/me" ? USER_RES : null
    );
    const d = deps({ request: request as never });
    const result = await sweepCalendlyBookingGoals(db, d);
    expect(result.swept).toBe(1);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_flow_booking_goal_sweep_failed",
        message: expect.stringContaining("calendar_not_connected")
      })
    );
  });

  it("counts zero fresh bookings without firing anything", async () => {
    const { db } = fakeDb({
      ai_flows: [{ data: [goalFlowRow("f1", BIZ), goalFlowRow("f2", BIZ2)] }],
      ai_flow_runs: [{ data: [{ id: "run-1" }] }, { data: [{ id: "run-2" }] }]
    });
    const request = vi.fn(async (biz: string, _c: unknown, config: { endpoint: string }) => {
      if (config.endpoint === "/users/me") return USER_RES;
      // BIZ2's listing carries no collection at all — still zero bookings.
      if (biz === BIZ2) return { data: {} };
      return {
        data: {
          collection: [
            booking("EV-OLD", isoAgoMin(CALENDAR_CREATED_LOOKBACK_MINUTES + 5)),
            { created_at: isoAgoMin(1) }, // no uri → ignored
            { uri: "https://api.calendly.com/scheduled_events/EV-X" } // no created_at → ignored
          ]
        }
      };
    });
    const d = deps({ request: request as never });
    const result = await sweepCalendlyBookingGoals(db, d);
    expect(result).toMatchObject({ swept: 2, bookings: 0, goalsFired: 0 });
    expect(d.applyGoal).not.toHaveBeenCalled();
  });

  it("resolves fresh bookings' invitees to numbers and fires the goal (full fan-out)", async () => {
    const { db, chains } = fakeDb({
      ai_flows: [{ data: [goalFlowRow("f1")] }],
      ai_flow_runs: [{ data: [{ id: "run-1" }] }],
      contacts: [
        // Union for +17808039935: primary + a merged alias.
        { data: { customer_e164: "+17808039935", alias_e164s: ["+15870000001"] } },
        // Union for the email-resolved +16025550000: a thin row with null
        // primary and no alias array degrades to the seed alone.
        { data: { customer_e164: null } }
      ]
    });
    const request = vi.fn(async (_b: string, _c: unknown, config: { endpoint: string }) => {
      if (config.endpoint === "/users/me") return USER_RES;
      if (config.endpoint === "/scheduled_events") {
        return { data: { collection: [booking("EV1", isoAgoMin(2))] } };
      }
      expect(config.endpoint).toBe("/scheduled_events/EV1/invitees");
      return {
        data: {
          collection: [
            {
              status: "active",
              text_reminder_number: "(780) 803-9935",
              email: "Tim@Example.com "
            },
            { status: "canceled", text_reminder_number: "+19998887777" },
            { status: "active", text_reminder_number: "junk", email: "" }
          ]
        }
      };
    });
    const findByEmails = vi
      .fn()
      .mockResolvedValue(
        new Map([["tim@example.com", { customerE164: "+16025550000", displayName: "Tim" }]])
      );
    const applyGoal = vi
      .fn()
      .mockResolvedValueOnce({ jumpedRuns: 1 })
      .mockResolvedValue({ jumpedRuns: 0 });
    const d = deps({ request: request as never, findByEmails, applyGoal });
    const result = await sweepCalendlyBookingGoals(db, d);

    // Email matching is case-insensitive and trimmed; one scan per business.
    expect(findByEmails).toHaveBeenCalledWith(BIZ, ["tim@example.com"], db);
    // Fired numbers: normalized SMS phone + its alias + the email-resolved
    // primary; the canceled invitee's number never fires.
    const fired = applyGoal.mock.calls.map((c) => c[2]);
    expect(fired).toEqual(
      expect.arrayContaining(["+17808039935", "+15870000001", "+16025550000"])
    );
    expect(fired).toHaveLength(3);
    expect(applyGoal.mock.calls[0][3]).toEqual({ kind: "appointment_booked" });
    expect(result).toMatchObject({
      swept: 1,
      bookings: 1,
      goalsFired: 3,
      jumpedRuns: 1
    });
    // The swept business also got a webhook fast-path upgrade attempt
    // (module default — cooldown/plan gating live inside ensure).
    expect(ensureCalendlyWebhookSubscription).toHaveBeenCalledWith(
      BIZ,
      CONN,
      { request: request as never },
      db
    );
    // The jump landed → an info log tells the owner what happened.
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        level: "info",
        event: "ai_flow_goal_jumped_booking",
        payload: { bookings: 1, jumped_runs: 1 }
      })
    );
    // The contact union looked up primary OR alias membership.
    const contactChain = chains.find((c) => c.table === "contacts")!;
    expect(contactChain.calls.find((c) => c.name === "or")?.args[0]).toBe(
      "customer_e164.eq.+17808039935,alias_e164s.cs.{+17808039935}"
    );
  });

  it("skips the jumped-runs info log when nothing jumped", async () => {
    const { db } = fakeDb({
      ai_flows: [{ data: [goalFlowRow("f1")] }],
      ai_flow_runs: [{ data: [{ id: "run-1" }] }],
      contacts: [{ data: null }]
    });
    const request = vi.fn(async (_b: string, _c: unknown, config: { endpoint: string }) => {
      if (config.endpoint === "/users/me") return USER_RES;
      if (config.endpoint === "/scheduled_events") {
        return { data: { collection: [booking("EV1", isoAgoMin(1))] } };
      }
      return {
        data: { collection: [{ status: "active", text_reminder_number: "+17808039935" }] }
      };
    });
    const d = deps({ request: request as never });
    const result = await sweepCalendlyBookingGoals(db, d);
    expect(result).toMatchObject({ goalsFired: 1, jumpedRuns: 0 });
    expect(recordSystemLog).not.toHaveBeenCalled();
  });

  it("defers a booking whose invitee fetch is refused (warn, keep going)", async () => {
    const { db } = fakeDb({
      ai_flows: [{ data: [goalFlowRow("f1")] }],
      ai_flow_runs: [{ data: [{ id: "run-1" }] }],
      contacts: [{ data: null }]
    });
    const request = vi.fn(async (_b: string, _c: unknown, config: { endpoint: string }) => {
      if (config.endpoint === "/users/me") return USER_RES;
      if (config.endpoint === "/scheduled_events") {
        // EV1 listed first but created LATER — the sweep must walk EV2
        // (closer to aging out of the lookback) first.
        return {
          data: { collection: [booking("EV1", isoAgoMin(1)), booking("EV2", isoAgoMin(5))] }
        };
      }
      if (config.endpoint === "/scheduled_events/EV1/invitees") return null; // refused
      return {
        data: { collection: [{ status: "active", text_reminder_number: "+17808039935" }] }
      };
    });
    const d = deps({ request: request as never });
    const result = await sweepCalendlyBookingGoals(db, d);
    expect(logger.warn).toHaveBeenCalledWith(
      "booking goal sweep: invitee fetch refused; retried next tick",
      expect.objectContaining({ businessId: BIZ })
    );
    // EV2's invitee still fired, and oldest-created went first.
    expect(result).toMatchObject({ bookings: 2, goalsFired: 1 });
    const inviteeCalls = vi
      .mocked(request)
      .mock.calls.map((c) => (c[2] as { endpoint: string }).endpoint)
      .filter((e) => e.endsWith("/invitees"));
    expect(inviteeCalls).toEqual([
      "/scheduled_events/EV2/invitees",
      "/scheduled_events/EV1/invitees"
    ]);
  });

  it("caps invitee fetches per tick and records overflow (full page + cap)", async () => {
    const { db } = fakeDb({
      ai_flows: [{ data: [goalFlowRow("f1")] }],
      ai_flow_runs: [{ data: [{ id: "run-1" }] }]
    });
    const fresh = Array.from({ length: BOOKING_GOAL_INVITEE_FETCH_CAP + 1 }, (_, i) =>
      booking(`EV${i}`, isoAgoMin(1))
    );
    expect(fresh.length).toBeGreaterThanOrEqual(CALENDLY_POLL_PAGE_COUNT);
    const request = vi.fn(async (_b: string, _c: unknown, config: { endpoint: string }) => {
      if (config.endpoint === "/users/me") return USER_RES;
      if (config.endpoint === "/scheduled_events") return { data: { collection: fresh } };
      return { data: {} }; // invitees payload without a collection
    });
    const d = deps({ request: request as never });
    const result = await sweepCalendlyBookingGoals(db, d);
    expect(result.bookings).toBe(BOOKING_GOAL_INVITEE_FETCH_CAP + 1);
    // users/me + listing + capped invitee fetches.
    expect(vi.mocked(request).mock.calls).toHaveLength(2 + BOOKING_GOAL_INVITEE_FETCH_CAP);
    // A full listing page AND the fetch cap both surfaced as overflow.
    const overflows = vi
      .mocked(recordSystemLog)
      .mock.calls.filter(
        (c) => (c[0] as { event: string }).event === "ai_flow_booking_goal_sweep_overflow"
      );
    expect(overflows).toHaveLength(2);
    expect(overflows.map((c) => (c[0] as { message: string }).message)).toEqual([
      expect.stringContaining("full page"),
      expect.stringContaining("invitee-fetch cap")
    ]);
  });

  it("degrades the contact-number union to the seed on error or throw", async () => {
    const { db } = fakeDb({
      ai_flows: [{ data: [goalFlowRow("f1")] }],
      ai_flow_runs: [{ data: [{ id: "run-1" }] }],
      contacts: [
        { error: { message: "contacts down" } },
        { reject: new Error("network sad") },
        { reject: "string sad" }
      ]
    });
    const request = vi.fn(async (_b: string, _c: unknown, config: { endpoint: string }) => {
      if (config.endpoint === "/users/me") return USER_RES;
      if (config.endpoint === "/scheduled_events") {
        return { data: { collection: [booking("EV1", isoAgoMin(1))] } };
      }
      return {
        data: {
          collection: [
            { status: "active", text_reminder_number: "+17808039935" },
            { status: "active", text_reminder_number: "+16025550000" },
            { status: "active", text_reminder_number: "+16045551212" }
          ]
        }
      };
    });
    const d = deps({ request: request as never });
    const result = await sweepCalendlyBookingGoals(db, d);
    // All seeds still fired despite the union lookups failing.
    expect(result.goalsFired).toBe(3);
    expect(logger.warn).toHaveBeenCalledWith(
      "booking goal sweep: contact number union failed",
      expect.objectContaining({ businessId: BIZ, error: "contacts down" })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "booking goal sweep: contact number union threw",
      expect.objectContaining({ businessId: BIZ, error: "network sad" })
    );
    // A non-Error throw is stringified, never rethrown.
    expect(logger.warn).toHaveBeenCalledWith(
      "booking goal sweep: contact number union threw",
      expect.objectContaining({ businessId: BIZ, error: "string sad" })
    );
  });

  it("honors an injected webhook upgrader and skips it for non-swept businesses", async () => {
    const { db } = fakeDb({
      ai_flows: [{ data: [goalFlowRow("f1", BIZ), goalFlowRow("f2", BIZ2)] }],
      // BIZ has a jumpable run; BIZ2 does not (ensure must not run for it).
      ai_flow_runs: [{ data: [{ id: "run-1" }] }, { data: [] }]
    });
    const request = vi.fn(async (_b: string, _c: unknown, config: { endpoint: string }) => {
      if (config.endpoint === "/users/me") return USER_RES;
      return { data: { collection: [] } };
    });
    const ensureWebhook = vi.fn().mockResolvedValue({ status: "active", attempted: false });
    const d = deps({ request: request as never, ensureWebhook });
    await sweepCalendlyBookingGoals(db, d);
    expect(ensureWebhook).toHaveBeenCalledTimes(1);
    expect(ensureWebhook).toHaveBeenCalledWith(BIZ, CONN, { request }, db);
    expect(ensureCalendlyWebhookSubscription).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error per-business failure", async () => {
    const { db } = fakeDb({
      ai_flows: [{ data: [goalFlowRow("f1")] }],
      ai_flow_runs: [{ data: [{ id: "run-1" }] }]
    });
    const d = deps({ resolveConnection: vi.fn().mockRejectedValue("weird") });
    await sweepCalendlyBookingGoals(db, d);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_flow_booking_goal_sweep_failed",
        message: "Calendly booking-goal sweep failed: weird"
      })
    );
  });
});

describe("fireBookingGoalsForInvitees (direct, production defaults)", () => {
  it("fires with the default goal applier when no deps are injected", async () => {
    // The real applyGoalEvent runs against the fake client: its candidate-
    // run lookup returns no rows, so it no-ops safely (never throws).
    const { db } = fakeDb({
      contacts: [{ data: null }],
      ai_flow_runs: [{ data: null }]
    });
    const out = await fireBookingGoalsForInvitees(db as never, BIZ, [
      { status: "active", text_reminder_number: "+17808039935" }
    ]);
    expect(out).toEqual({ goalsFired: 1, jumpedRuns: 0 });
  });
});
