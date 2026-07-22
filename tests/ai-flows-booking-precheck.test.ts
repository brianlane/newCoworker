/**
 * Pre-send booking check (src/lib/ai-flows/booking-precheck.ts):
 * run/flow/connection gating, lead-identifier extraction, user-URI caching,
 * the Calendly email fast path, the phone-match fallback (country-code
 * tolerant, capped), the Vagaro upcoming-appointments arm, goal firing on a
 * hit, and the fail-open reasons.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/db/vagaro-connections", () => ({ getActiveVagaroConnection: vi.fn() }));
vi.mock("@/lib/vagaro/client", () => ({ listVagaroAppointments: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/nango/workspace", () => ({ nangoProxyForBusiness: vi.fn() }));
vi.mock("@/lib/voice-tools/connections", () => ({
  resolveCalendarConnection: vi.fn(),
  isWorkspaceCalendarProvider: (p: string) => p === "google" || p === "microsoft",
  CALENDLY_DIRECT_KEY: "calendly-direct"
}));
vi.mock("@/lib/calendar-tools/shared-calendar", () => ({ getSharedCalendar: vi.fn() }));
vi.mock("@/lib/ai-flows/db", () => ({ enqueueAiFlowRun: vi.fn() }));
vi.mock("@/lib/calendar-tools/calendly", () => ({ calendlyRequest: vi.fn() }));
vi.mock("@/lib/db/calendly-connections", () => ({
  getActiveCalendlyConnectionUserUri: vi.fn(),
  setCalendlyConnectionUserUri: vi.fn()
}));
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn() }));
vi.mock("@/lib/db/contact-emails", () => ({ findContactsByEmails: vi.fn() }));
vi.mock("@/lib/calendly/webhook-subscriptions", () => ({
  ensureCalendlyWebhookSubscription: vi.fn()
}));

import {
  bookingPrecheckForRun,
  leadIdentifiersFromContext,
  PRECHECK_EVENT_SCAN,
  PRECHECK_INVITEE_FETCH_CAP,
  type BookingPrecheckDeps
} from "@/lib/ai-flows/booking-precheck";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const CONN = {
  provider: "calendly" as const,
  providerConfigKey: "calendly-direct",
  connectionId: "cx-1"
};
const USER_URI = "https://api.calendly.com/users/U1";

const GOAL_DEF = {
  version: 1,
  steps: [
    { id: "s1", type: "send_sms", to: "{{vars.lead_phone}}", body: "hi" },
    { id: "s_goal", type: "goal", events: [{ kind: "appointment_booked" }] }
  ]
};

type QueuedResult = { data?: unknown; error?: { message: string } | null };

/** Minimal chainable fake: from(table) chains consume queued results. */
function fakeDb(queues: Record<string, QueuedResult[]>) {
  return {
    from(table: string) {
      const q = queues[table] ?? [];
      const chain: Record<string, (...args: unknown[]) => unknown> = {};
      for (const m of ["select", "eq", "in", "or", "order", "not", "limit"]) {
        chain[m] = () => chain;
      }
      chain.maybeSingle = () => {
        const r = q.shift() ?? { data: null, error: null };
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
      };
      return chain;
    }
  } as never;
}

function runRow(context: Record<string, unknown> = {}) {
  return {
    id: RUN,
    flow_id: "flow-1",
    context: {
      vars: { lead_phone: "+17808039935", lead_email: "Tim@TrustYourTalent.ca " },
      trigger: { from: "facebook_lead_ads" },
      ...context
    }
  };
}

function stdDb(over: Partial<Record<"run" | "flow", QueuedResult>> = {}) {
  return fakeDb({
    ai_flow_runs: [over.run ?? { data: runRow() }],
    ai_flows: [over.flow ?? { data: { definition: GOAL_DEF, enabled: true } }]
  });
}

function deps(overrides: Partial<BookingPrecheckDeps> = {}): BookingPrecheckDeps {
  return {
    request: vi.fn().mockResolvedValue(null),
    resolveConnection: vi.fn().mockResolvedValue(CONN),
    fireGoals: vi.fn().mockResolvedValue({ goalsFired: 1, jumpedRuns: 1 }),
    getCachedUserUri: vi.fn().mockResolvedValue(USER_URI),
    persistUserUri: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

/** request fake answering the email-path listing with `hits` results. */
function emailPathRequest(hits: number) {
  return vi.fn(async (_b: string, _c: unknown, config: { endpoint: string; params?: Record<string, string> }) => {
    expect(config.endpoint).toBe("/scheduled_events");
    expect(config.params?.invitee_email).toBe("tim@trustyourtalent.ca");
    expect(config.params?.status).toBe("active");
    return { data: { collection: Array.from({ length: hits }, (_, i) => ({ uri: `e${i}` })) } };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("leadIdentifiersFromContext", () => {
  it("normalizes lead_phone and an E.164 trigger.from, lowercases the email", () => {
    const out = leadIdentifiersFromContext({
      vars: { lead_phone: "(780) 803-9935", lead_email: " Tim@Example.COM " },
      trigger: { from: "+15145188192" }
    });
    expect(out.phones).toEqual(["+17808039935", "+15145188192"]);
    expect(out.emails).toEqual(["tim@example.com"]);
  });

  it("dedupes identical phone identities and drops junk", () => {
    const out = leadIdentifiersFromContext({
      vars: { lead_phone: "+17808039935", lead_email: "not-an-email" },
      trigger: { from: "+17808039935" }
    });
    expect(out.phones).toEqual(["+17808039935"]);
    expect(out.emails).toEqual([]);
  });

  it("handles a null context and non-string fields", () => {
    expect(leadIdentifiersFromContext(null)).toEqual({ phones: [], emails: [] });
    expect(
      leadIdentifiersFromContext({ vars: { lead_phone: 42, lead_email: 7 }, trigger: { from: null } })
    ).toEqual({ phones: [], emails: [] });
  });
});

describe("bookingPrecheckForRun gating", () => {
  it("run_not_found when the run is missing or errored", async () => {
    const d = deps();
    expect(await bookingPrecheckForRun(BIZ, RUN, d, stdDb({ run: { data: null } }))).toEqual({
      booked: false,
      jumpedRuns: 0,
      reason: "run_not_found"
    });
    expect(
      await bookingPrecheckForRun(BIZ, RUN, d, stdDb({ run: { error: { message: "down" } } }))
    ).toMatchObject({ reason: "run_not_found" });
    expect(d.resolveConnection).not.toHaveBeenCalled();
  });

  it("flow_without_booking_goal for missing, disabled, errored, or goalless flows", async () => {
    const d = deps();
    for (const flow of [
      { data: null },
      { data: { definition: GOAL_DEF, enabled: false } },
      { error: { message: "down" } },
      { data: { definition: { steps: [{ id: "g", type: "goal", events: [{ kind: "replied" }] }] }, enabled: true } }
    ]) {
      expect(await bookingPrecheckForRun(BIZ, RUN, d, stdDb({ flow }))).toMatchObject({
        reason: "flow_without_booking_goal"
      });
    }
    expect(d.resolveConnection).not.toHaveBeenCalled();
  });

  it("provider_unsupported when the connection is missing or an unsupported provider", async () => {
    expect(
      await bookingPrecheckForRun(
        BIZ,
        RUN,
        deps({ resolveConnection: vi.fn().mockResolvedValue(null) }),
        stdDb()
      )
    ).toMatchObject({ reason: "provider_unsupported" });
    expect(
      await bookingPrecheckForRun(
        BIZ,
        RUN,
        deps({
          resolveConnection: vi
            .fn()
            .mockResolvedValue({ provider: "google", providerConfigKey: "g", connectionId: "g1" })
        }),
        stdDb()
      )
    ).toMatchObject({ reason: "provider_unsupported" });
  });

  it("no_lead_identifiers when the context carries neither phone nor email", async () => {
    const db = stdDb({
      run: { data: runRow({ vars: {}, trigger: { from: "facebook_lead_ads" } }) }
    });
    const d = deps();
    expect(await bookingPrecheckForRun(BIZ, RUN, d, db)).toMatchObject({
      reason: "no_lead_identifiers"
    });
    expect(d.request).not.toHaveBeenCalled();
  });

  it("uses the service client + production deps when none are injected", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(stdDb({ run: { data: null } }));
    // No deps at all: binds every production default (none is invoked — the
    // missing run short-circuits first).
    const result = await bookingPrecheckForRun(BIZ, RUN);
    expect(result.reason).toBe("run_not_found");
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("bookingPrecheckForRun user URI", () => {
  it("prefers the cached URI (no /users/me probe)", async () => {
    const request = emailPathRequest(1);
    const d = deps({ request: request as never });
    const result = await bookingPrecheckForRun(BIZ, RUN, d, stdDb());
    expect(result.booked).toBe(true);
    expect(request.mock.calls.every((c) => c[2].endpoint !== "/users/me")).toBe(true);
    expect(d.persistUserUri).not.toHaveBeenCalled();
  });

  it("falls back to /users/me on a cache miss and persists the answer", async () => {
    const request = vi.fn(async (_b: string, _c: unknown, config: { endpoint: string }) =>
      config.endpoint === "/users/me"
        ? { data: { resource: { uri: USER_URI } } }
        : { data: { collection: [{ uri: "e1" }] } }
    );
    const d = deps({ request: request as never, getCachedUserUri: vi.fn().mockResolvedValue(null) });
    const result = await bookingPrecheckForRun(BIZ, RUN, d, stdDb());
    expect(result.booked).toBe(true);
    expect(d.persistUserUri).toHaveBeenCalledWith(BIZ, USER_URI);
  });

  it("degrades a cache read failure to the probe and a write failure to a warning", async () => {
    const request = vi.fn(async (_b: string, _c: unknown, config: { endpoint: string }) =>
      config.endpoint === "/users/me"
        ? { data: { resource: { uri: USER_URI } } }
        : { data: { collection: [{ uri: "e1" }] } }
    );
    const d = deps({
      request: request as never,
      getCachedUserUri: vi.fn().mockRejectedValue(new Error("cache read sad")),
      persistUserUri: vi.fn().mockRejectedValue("cache write sad")
    });
    const result = await bookingPrecheckForRun(BIZ, RUN, d, stdDb());
    expect(result.booked).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "booking precheck: user-uri cache read failed",
      expect.objectContaining({ businessId: BIZ, error: "cache read sad" })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "booking precheck: user-uri cache write failed",
      expect.objectContaining({ businessId: BIZ, error: "cache write sad" })
    );
  });

  it("stringifies non-Error cache-read trouble and Error cache-write trouble", async () => {
    const request = vi.fn(async (_b: string, _c: unknown, config: { endpoint: string }) =>
      config.endpoint === "/users/me"
        ? { data: { resource: { uri: USER_URI } } }
        : { data: { collection: [{ uri: "e1" }] } }
    );
    const d = deps({
      request: request as never,
      getCachedUserUri: vi.fn().mockRejectedValue("read string sad"),
      persistUserUri: vi.fn().mockRejectedValue(new Error("write err sad"))
    });
    const result = await bookingPrecheckForRun(BIZ, RUN, d, stdDb());
    expect(result.booked).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "booking precheck: user-uri cache read failed",
      expect.objectContaining({ error: "read string sad" })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "booking precheck: user-uri cache write failed",
      expect.objectContaining({ error: "write err sad" })
    );
  });

  it("never touches the cache for a Nango-keyed connection", async () => {
    const request = vi.fn(async (_b: string, _c: unknown, config: { endpoint: string }) =>
      config.endpoint === "/users/me"
        ? { data: { resource: { uri: USER_URI } } }
        : { data: { collection: [{ uri: "e1" }] } }
    );
    const d = deps({
      request: request as never,
      resolveConnection: vi
        .fn()
        .mockResolvedValue({ provider: "calendly", providerConfigKey: "calendly", connectionId: "n1" })
    });
    const result = await bookingPrecheckForRun(BIZ, RUN, d, stdDb());
    expect(result.booked).toBe(true);
    expect(d.getCachedUserUri).not.toHaveBeenCalled();
    expect(d.persistUserUri).not.toHaveBeenCalled();
  });

  it("calendly_refused when /users/me is refused or answers without a uri", async () => {
    for (const answer of [null, { data: { resource: {} } }]) {
      const d = deps({
        request: vi.fn().mockResolvedValue(answer),
        getCachedUserUri: vi.fn().mockResolvedValue(null)
      });
      expect(await bookingPrecheckForRun(BIZ, RUN, d, stdDb())).toMatchObject({
        reason: "calendly_refused"
      });
    }
  });
});

describe("bookingPrecheckForRun email path", () => {
  it("books on an invitee_email-filtered hit and fires the goal machinery", async () => {
    const d = deps({ request: emailPathRequest(1) as never });
    const result = await bookingPrecheckForRun(BIZ, RUN, d, stdDb());
    expect(result).toEqual({ booked: true, jumpedRuns: 1, reason: "booked" });
    expect(d.fireGoals).toHaveBeenCalledWith(expect.anything(), BIZ, [
      {
        status: "active",
        email: "tim@trustyourtalent.ca",
        text_reminder_number: "+17808039935"
      }
    ]);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        event: "ai_flow_booking_precheck_hit",
        payload: { run_id: RUN, jumped_runs: 1 }
      })
    );
  });

  it("calendly_refused when the email listing is refused", async () => {
    const d = deps({ request: vi.fn().mockResolvedValue(null), getCachedUserUri: vi.fn().mockResolvedValue(USER_URI) });
    expect(await bookingPrecheckForRun(BIZ, RUN, d, stdDb())).toMatchObject({
      reason: "calendly_refused"
    });
  });

  it("books but reports zero jumps when goal firing fails (booked stands)", async () => {
    const d = deps({
      request: emailPathRequest(1) as never,
      fireGoals: vi.fn().mockRejectedValue(new Error("goal sad"))
    });
    const result = await bookingPrecheckForRun(BIZ, RUN, d, stdDb());
    expect(result).toEqual({ booked: true, jumpedRuns: 0, reason: "booked" });
    expect(logger.warn).toHaveBeenCalledWith(
      "booking precheck: goal firing failed (booked stands)",
      expect.objectContaining({ businessId: BIZ, runId: RUN, error: "goal sad" })
    );
  });

  it("stringifies a non-Error goal-firing failure", async () => {
    const d = deps({
      request: emailPathRequest(1) as never,
      fireGoals: vi.fn().mockRejectedValue("goal string sad")
    });
    const result = await bookingPrecheckForRun(BIZ, RUN, d, stdDb());
    expect(result).toEqual({ booked: true, jumpedRuns: 0, reason: "booked" });
    expect(logger.warn).toHaveBeenCalledWith(
      "booking precheck: goal firing failed (booked stands)",
      expect.objectContaining({ error: "goal string sad" })
    );
  });

  it("treats an email listing without a collection as no email hit", async () => {
    const request = vi.fn(async (_b: string, _c: unknown, config: { endpoint: string; params?: Record<string, string> }) => {
      if (config.params?.invitee_email) return { data: {} }; // no collection key
      if (config.endpoint === "/scheduled_events") return { data: {} }; // phone listing: none
      throw new Error(`unexpected: ${config.endpoint}`);
    });
    const d = deps({ request: request as never });
    const result = await bookingPrecheckForRun(BIZ, RUN, d, stdDb());
    expect(result).toEqual({ booked: false, jumpedRuns: 0, reason: "no_booking_found" });
  });
});

describe("bookingPrecheckForRun phone path", () => {
  /** Run whose context has a phone but NO email → phone path only. */
  const phoneOnlyDb = () =>
    stdDb({ run: { data: runRow({ vars: { lead_phone: "+17808039935" } }) } });

  it("matches an invitee SMS number country-code-tolerantly", async () => {
    const request = vi.fn(async (_b: string, _c: unknown, config: { endpoint: string; params?: Record<string, string> }) => {
      if (config.endpoint === "/scheduled_events") {
        expect(config.params?.count).toBe(String(PRECHECK_EVENT_SCAN));
        return { data: { collection: [{ uri: "https://api.calendly.com/scheduled_events/EV1" }, { no_uri: true }] } };
      }
      expect(config.endpoint).toBe("/scheduled_events/EV1/invitees");
      return {
        data: {
          collection: [
            { status: "canceled", text_reminder_number: "+17808039935" },
            { status: "active" }, // no number
            { status: "active", text_reminder_number: "780-803-9935" } // national format
          ]
        }
      };
    });
    const d = deps({ request: request as never });
    const result = await bookingPrecheckForRun(BIZ, RUN, d, phoneOnlyDb());
    expect(result).toEqual({ booked: true, jumpedRuns: 1, reason: "booked" });
    expect(d.fireGoals).toHaveBeenCalledWith(expect.anything(), BIZ, [
      { status: "active", text_reminder_number: "+17808039935" }
    ]);
  });

  it("falls from an empty email path into the phone path", async () => {
    const request = vi.fn(async (_b: string, _c: unknown, config: { endpoint: string; params?: Record<string, string> }) => {
      if (config.endpoint === "/scheduled_events" && config.params?.invitee_email) {
        return { data: { collection: [] } };
      }
      if (config.endpoint === "/scheduled_events") {
        return { data: { collection: [{ uri: "https://api.calendly.com/scheduled_events/EV1" }] } };
      }
      return { data: { collection: [{ status: "active", text_reminder_number: "+17808039935" }] } };
    });
    const d = deps({ request: request as never });
    const result = await bookingPrecheckForRun(BIZ, RUN, d, stdDb());
    expect(result.booked).toBe(true);
  });

  it("calendly_refused when the phone-path listing is refused", async () => {
    const request = vi.fn(async (_b: string, _c: unknown, config: { endpoint: string; params?: Record<string, string> }) =>
      config.params?.invitee_email ? { data: { collection: [] } } : null
    );
    const d = deps({ request: request as never });
    expect(await bookingPrecheckForRun(BIZ, RUN, d, stdDb())).toMatchObject({
      reason: "calendly_refused"
    });
  });

  it("skips refused invitee fetches and answers no_booking_found", async () => {
    const request = vi.fn(async (_b: string, _c: unknown, config: { endpoint: string }) => {
      if (config.endpoint === "/scheduled_events") {
        return {
          data: {
            collection: [
              { uri: "https://api.calendly.com/scheduled_events/EV1" },
              { uri: "https://api.calendly.com/scheduled_events/EV2" }
            ]
          }
        };
      }
      if (config.endpoint === "/scheduled_events/EV1/invitees") return null; // refused
      return { data: { collection: [{ status: "active", text_reminder_number: "+15555550000" }] } };
    });
    const d = deps({ request: request as never });
    const result = await bookingPrecheckForRun(BIZ, RUN, d, phoneOnlyDb());
    expect(result).toEqual({ booked: false, jumpedRuns: 0, reason: "no_booking_found" });
    expect(d.fireGoals).not.toHaveBeenCalled();
  });

  it("caps invitee fetches", async () => {
    const events = Array.from({ length: PRECHECK_INVITEE_FETCH_CAP + 5 }, (_, i) => ({
      uri: `https://api.calendly.com/scheduled_events/EV${i}`
    }));
    const request = vi.fn(async (_b: string, _c: unknown, config: { endpoint: string }) => {
      if (config.endpoint === "/scheduled_events") return { data: { collection: events } };
      return { data: { collection: [] } };
    });
    const d = deps({ request: request as never });
    const result = await bookingPrecheckForRun(BIZ, RUN, d, phoneOnlyDb());
    expect(result.reason).toBe("no_booking_found");
    const inviteeCalls = request.mock.calls.filter((c) =>
      (c[2] as { endpoint: string }).endpoint.endsWith("/invitees")
    );
    expect(inviteeCalls).toHaveLength(PRECHECK_INVITEE_FETCH_CAP);
  });

  it("handles an invitees payload without a collection", async () => {
    const request = vi.fn(async (_b: string, _c: unknown, config: { endpoint: string }) => {
      if (config.endpoint === "/scheduled_events") {
        return { data: { collection: [{ uri: "https://api.calendly.com/scheduled_events/EV1" }] } };
      }
      return { data: {} };
    });
    const d = deps({ request: request as never });
    const result = await bookingPrecheckForRun(BIZ, RUN, d, phoneOnlyDb());
    expect(result.reason).toBe("no_booking_found");
  });

  it("fires with an email-only synthesized invitee when the lead has no phone", async () => {
    const db = stdDb({
      run: { data: runRow({ vars: { lead_email: "tim@trustyourtalent.ca" }, trigger: {} }) }
    });
    const d = deps({ request: emailPathRequest(1) as never });
    const result = await bookingPrecheckForRun(BIZ, RUN, d, db);
    expect(result.booked).toBe(true);
    expect(d.fireGoals).toHaveBeenCalledWith(expect.anything(), BIZ, [
      { status: "active", email: "tim@trustyourtalent.ca" }
    ]);
  });
});

describe("bookingPrecheckForRun Vagaro arm", () => {
  const VAGARO_CONN = { provider: "vagaro" as const, providerConfigKey: "vagaro", connectionId: "vg-1" };
  const VG_ROW = { id: "vg-1", business_id: BIZ } as never;

  function upcomingAppt(overrides: Record<string, unknown> = {}) {
    return {
      id: "appt-1",
      startIso: new Date(Date.now() + 60 * 60_000).toISOString(),
      endIso: null,
      createdIso: null,
      updatedIso: null,
      status: "confirmed",
      cancelled: false,
      serviceId: null,
      serviceName: null,
      customerName: null,
      customerPhone: null,
      customerEmail: null,
      ...overrides
    };
  }

  function vagaroDeps(overrides: Partial<BookingPrecheckDeps> = {}): BookingPrecheckDeps {
    return deps({
      resolveConnection: vi.fn().mockResolvedValue(VAGARO_CONN),
      getVagaroConnection: vi.fn().mockResolvedValue(VG_ROW),
      listAppointments: vi.fn().mockResolvedValue([]),
      ...overrides
    });
  }

  it("books on a country-code-tolerant customer phone match and logs the Vagaro hit", async () => {
    const d = vagaroDeps({
      listAppointments: vi
        .fn()
        .mockResolvedValue([upcomingAppt({ customerPhone: "780-803-9935" })])
    });
    const result = await bookingPrecheckForRun(BIZ, RUN, d, stdDb());
    expect(result).toEqual({ booked: true, jumpedRuns: 1, reason: "booked" });
    expect(d.fireGoals).toHaveBeenCalledWith(expect.anything(), BIZ, [
      {
        status: "active",
        email: "tim@trustyourtalent.ca",
        text_reminder_number: "+17808039935"
      }
    ]);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_flow_booking_precheck_hit",
        message: expect.stringContaining("Vagaro")
      })
    );
    // The listing window is [now, now + horizon].
    const args = vi.mocked(d.listAppointments!).mock.calls[0][1];
    expect(Date.parse(args.startIso)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(args.endIso)).toBeGreaterThan(Date.now());
  });

  it("books on an exact customer email match", async () => {
    const d = vagaroDeps({
      listAppointments: vi
        .fn()
        .mockResolvedValue([upcomingAppt({ customerEmail: "tim@trustyourtalent.ca" })])
    });
    expect((await bookingPrecheckForRun(BIZ, RUN, d, stdDb())).booked).toBe(true);
  });

  it("ignores canceled, past-start, unparseable, and non-matching appointments", async () => {
    const d = vagaroDeps({
      listAppointments: vi.fn().mockResolvedValue([
        upcomingAppt({ customerPhone: "+17808039935", cancelled: true }),
        upcomingAppt({
          customerPhone: "+17808039935",
          startIso: new Date(Date.now() - 60_000).toISOString()
        }),
        upcomingAppt({ customerPhone: "+17808039935", startIso: "junk" }),
        upcomingAppt({ customerPhone: "+15550001111" }),
        upcomingAppt({ customerEmail: "someone@else.com" }),
        upcomingAppt() // no identity at all
      ])
    });
    expect(await bookingPrecheckForRun(BIZ, RUN, d, stdDb())).toEqual({
      booked: false,
      jumpedRuns: 0,
      reason: "no_booking_found"
    });
    expect(d.fireGoals).not.toHaveBeenCalled();
  });

  it("vagaro_refused when the connection row is gone or the listing throws", async () => {
    expect(
      await bookingPrecheckForRun(
        BIZ,
        RUN,
        vagaroDeps({ getVagaroConnection: vi.fn().mockResolvedValue(null) }),
        stdDb()
      )
    ).toMatchObject({ reason: "vagaro_refused" });

    // Default (module-level) lookups: the mocked module answers undefined,
    // which reads as "no connection row" and fails open the same way.
    expect(
      await bookingPrecheckForRun(
        BIZ,
        RUN,
        deps({ resolveConnection: vi.fn().mockResolvedValue(VAGARO_CONN) }),
        stdDb()
      )
    ).toMatchObject({ reason: "vagaro_refused" });

    const d = vagaroDeps({
      listAppointments: vi.fn().mockRejectedValue(new Error("vagaro down"))
    });
    expect(await bookingPrecheckForRun(BIZ, RUN, d, stdDb())).toMatchObject({
      reason: "vagaro_refused"
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "booking precheck: vagaro lookup refused (failing open)",
      expect.objectContaining({ businessId: BIZ, error: "vagaro down" })
    );

    // Non-Error failures are stringified.
    const d2 = vagaroDeps({ listAppointments: vi.fn().mockRejectedValue("string sad") });
    await bookingPrecheckForRun(BIZ, RUN, d2, stdDb());
    expect(logger.warn).toHaveBeenCalledWith(
      "booking precheck: vagaro lookup refused (failing open)",
      expect.objectContaining({ error: "string sad" })
    );
  });
});
