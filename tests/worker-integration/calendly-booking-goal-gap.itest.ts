/**
 * Regression: a lead who ALREADY booked on Calendly must get no flow texts.
 *
 * Incident (KYP Ads, Jul 18-19 2026 — Tim Tsai): the booking-goal sweep only
 * fired for bookings created inside a 15-minute lookback, so a booking that
 * predated the observers left the lead's parked run nudging at 2 AM. Two
 * fixes are pinned here against the REAL local stack:
 *
 *   1. Young-run widening (src/lib/ai-flows/calendly-booking-goals.ts): a
 *      jumpable run created inside the young window makes the sweep fire
 *      active FUTURE-start bookings regardless of created_at — Tim's exact
 *      shape (booked 10h before the tick, run parked mid-nudges) now jumps.
 *      A run older than the window must NOT jump off a stale booking.
 *   2. Pre-send gate (ai-flow-worker + /api/internal/aiflow-booking-precheck):
 *      before a run's FIRST outward touch in a booking-goal flow, the worker
 *      asks the platform; on `booked` the run fast-forwards to its goal and
 *      the greeting NEVER sends. The platform here is the suite's fake app
 *      (tests/worker-integration/fake-app.ts) on AIFLOW_PLATFORM_URL; the
 *      route's own Calendly matching is covered by the unit suite.
 *
 * The sweep runs in-process against the itest Postgres with only the
 * Calendly transport faked (its injectable deps — the same seam the unit
 * suite uses); the worker part ticks the REAL served ai-flow-worker.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
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
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn() }));
vi.mock("@/lib/calendly/webhook-subscriptions", () => ({
  ensureCalendlyWebhookSubscription: vi
    .fn()
    .mockResolvedValue({ status: "unsupported", attempted: false })
}));

import { sweepCalendlyBookingGoals } from "@/lib/ai-flows/calendly-booking-goals";
import {
  createFlow,
  enqueueRun,
  getRun,
  getSteps,
  minutesAgo,
  seedBusiness,
  seedContact,
  serviceDb,
  tickWorker
} from "./harness";
import { startFakeApp, type FakeApp } from "./fake-app";

const CONN = {
  provider: "calendly" as const,
  providerConfigKey: "calendly-direct",
  connectionId: "cx-itest"
};
const USER_RES = { data: { resource: { uri: "https://api.calendly.com/users/U-itest" } } };

/** Trunk-only KYP-shaped follow-up flow: greet → wait → nudge ×2 → goal. */
function followUpDefinition() {
  return {
    version: 1,
    trigger: { channel: "webhook" as const, conditions: [] },
    steps: [
      { id: "s_greet", type: "send_sms", to: "{{vars.lead_phone}}", body: "greeting text" },
      {
        id: "s_wait_1",
        type: "wait_for_reply",
        phoneVar: "lead_phone",
        saveAs: "reply_1",
        timeoutMinutes: 120
      },
      {
        id: "s_nudge_1",
        type: "send_sms",
        to: "{{vars.lead_phone}}",
        body: "nudge one",
        when: { var: "reply_1", equals: "no_reply" }
      },
      {
        id: "s_wait_2",
        type: "wait_for_reply",
        phoneVar: "lead_phone",
        saveAs: "reply_2",
        timeoutMinutes: 1440,
        when: { var: "reply_1", equals: "no_reply" }
      },
      {
        id: "s_nudge_2",
        type: "send_sms",
        to: "{{vars.lead_phone}}",
        body: "nudge two",
        when: { var: "reply_2", equals: "no_reply" }
      },
      {
        id: "s_goal",
        type: "goal",
        label: "Lead replied or booked",
        events: [{ kind: "replied" }, { kind: "appointment_booked" }]
      }
    ]
  };
}
/** Flat index of s_goal in followUpDefinition (no branches → def order). */
const GOAL_INDEX = 5;

/**
 * Calendly transport fake for ONE business: /users/me, an active
 * scheduled-events listing carrying a booking created 10 HOURS ago that
 * starts TOMORROW (Tim's exact shape), and its invitee identity.
 */
function calendlyFakeFor(businessId: string, lead: { phone: string; email: string }) {
  return async (
    bizId: string,
    _conn: unknown,
    config: { endpoint: string; params?: Record<string, string> }
  ): Promise<{ data: unknown } | null> => {
    if (bizId !== businessId) return null; // other tenants: not connected
    if (config.endpoint === "/users/me") return USER_RES;
    if (config.endpoint === "/scheduled_events") {
      return {
        data: {
          collection: [
            {
              uri: "https://api.calendly.com/scheduled_events/EV-TIM",
              created_at: minutesAgo(600), // booked ~10h ago
              start_time: new Date(Date.now() + 24 * 60 * 60_000).toISOString()
            }
          ]
        }
      };
    }
    if (config.endpoint === "/scheduled_events/EV-TIM/invitees") {
      return {
        data: {
          collection: [
            { status: "active", email: lead.email, text_reminder_number: lead.phone }
          ]
        }
      };
    }
    throw new Error(`unexpected Calendly call: ${config.endpoint}`);
  };
}

/** A parked mid-nudges run (awaiting reply_2) — exactly Tim's state. */
async function seedParkedRun(
  db: SupabaseClient,
  businessId: string,
  flowId: string,
  lead: { phone: string; email: string },
  over: Record<string, unknown> = {}
): Promise<string> {
  return enqueueRun(
    db,
    flowId,
    businessId,
    { channel: "webhook", from: "facebook_lead_ads", windowText: "lead payload" },
    {
      lead_phone: lead.phone,
      lead_email: lead.email,
      reply_1: "no_reply",
      __resume_step_id: "s_wait_2"
    },
    {
      status: "awaiting_reply",
      current_step: 3,
      context: {
        trigger: { channel: "webhook", from: "facebook_lead_ads" },
        vars: {
          lead_phone: lead.phone,
          lead_email: lead.email,
          reply_1: "no_reply",
          __resume_step_id: "s_wait_2"
        },
        waiting_reply: {
          from: lead.phone,
          save_as: "reply_2",
          marker: "__wait_s_wait_2"
        }
      },
      respond_by_at: new Date(Date.now() + 20 * 60 * 60_000).toISOString(),
      ...over
    }
  );
}

let db: SupabaseClient;
let fakeApp: FakeApp;

beforeAll(async () => {
  db = serviceDb();
  fakeApp = await startFakeApp();
});

afterAll(async () => {
  await fakeApp.close();
});

// Park every leftover queued run (prior suites share this DB and every tick
// claims ALL due runs) so this file's ticks only execute its own runs — and
// no leftover booking-goal run can consume a scripted precheck answer.
beforeEach(async () => {
  await db
    .from("ai_flow_runs")
    .update({ earliest_claim_at: new Date(Date.now() + 60 * 60_000).toISOString() })
    .eq("status", "queued");
  fakeApp.clearScript();
});

describe("young-run sweep widening (Tim's timeline)", () => {
  it("jumps a parked run when its lead booked BEFORE the lookback (fails pre-fix)", async () => {
    const businessId = await seedBusiness(db, "Booking Gap Sweep Young");
    const lead = { phone: "+17805550101", email: "young-lead@example.com" };
    await seedContact(db, businessId, lead.phone, { email: lead.email });
    const flowId = await createFlow(db, businessId, followUpDefinition());
    // Run created NOW (inside the young window), parked awaiting reply_2.
    const runId = await seedParkedRun(db, businessId, flowId, lead);

    const result = await sweepCalendlyBookingGoals(db as never, {
      request: calendlyFakeFor(businessId, lead) as never,
      resolveConnection: (async (bizId: string) =>
        bizId === businessId ? CONN : null) as never,
      ensureWebhook: (async () => ({ status: "unsupported", attempted: false })) as never
    });

    expect(result.jumpedRuns).toBeGreaterThanOrEqual(1);
    const run = await getRun(db, runId);
    expect(run.status).toBe("queued");
    expect(run.current_step).toBe(GOAL_INDEX);
    expect(run.context.vars?.__goal_s_goal).toBe("appointment_booked");
    expect(run.context.waiting_reply?.result).toBe("goal_jump");

    // The short-circuited nudge steps are recorded as goal_jump skips.
    const steps = await getSteps(db, runId);
    const nudge2 = steps.find((s) => s.step_index === 4);
    expect(nudge2?.status).toBe("skipped");
    expect((nudge2?.result as { skipped?: string })?.skipped).toBe("goal_jump");

    // Let the worker finish the jumped run: the goal executes inline and the
    // run completes WITHOUT ever attempting an SMS (no Telnyx-config failure).
    await tickWorker();
    const finished = await getRun(db, runId);
    expect(finished.status).toBe("done");
    expect(finished.last_error).toBeNull();
  });

  it("does NOT jump an old run off a stale pre-existing booking", async () => {
    const businessId = await seedBusiness(db, "Booking Gap Sweep Old");
    const lead = { phone: "+17805550102", email: "old-lead@example.com" };
    await seedContact(db, businessId, lead.phone, { email: lead.email });
    const flowId = await createFlow(db, businessId, followUpDefinition());
    // Run created 10 DAYS ago — outside the young window.
    const runId = await seedParkedRun(db, businessId, flowId, lead, {
      created_at: new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString()
    });

    await sweepCalendlyBookingGoals(db as never, {
      request: calendlyFakeFor(businessId, lead) as never,
      resolveConnection: (async (bizId: string) =>
        bizId === businessId ? CONN : null) as never,
      ensureWebhook: (async () => ({ status: "unsupported", attempted: false })) as never
    });

    const run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_reply");
    expect(run.current_step).toBe(3);
    expect(run.context.vars?.__goal_s_goal).toBeUndefined();
  });
});

describe("pre-send booking gate (greeting must not send)", () => {
  it("a pre-booked lead's fresh run jumps to its goal before the FIRST text (fails pre-fix)", async () => {
    const businessId = await seedBusiness(db, "Booking Gap Precheck Hit");
    const lead = { phone: "+17805550103", email: "prebooked@example.com" };
    await seedContact(db, businessId, lead.phone, { email: lead.email });
    const flowId = await createFlow(db, businessId, followUpDefinition());
    const runId = await enqueueRun(
      db,
      flowId,
      businessId,
      { channel: "webhook", from: "facebook_lead_ads" },
      { lead_phone: lead.phone, lead_email: lead.email }
    );

    fakeApp.scriptPrecheck(true);
    await tickWorker();

    // The worker asked the platform exactly once for this run, cron-authed.
    const calls = fakeApp.precheckCalls.filter((c) => c.body.runId === runId);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.businessId).toBe(businessId);
    expect(calls[0].authorization).toBe("Bearer itest-cron-secret");

    // The run finished at its goal — the greeting was SKIPPED, never sent
    // (an attempted send would have failed loudly: no Telnyx env here).
    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    expect(run.last_error).toBeNull();
    expect(run.context.vars?.__goal_s_goal).toBe("appointment_booked");
    expect(run.context.vars?.__booking_precheck).toBe("1");

    const steps = await getSteps(db, runId);
    const greet = steps.find((s) => s.step_index === 0);
    expect(greet?.status).toBe("skipped");
    expect((greet?.result as { skipped?: string })?.skipped).toBe("goal_jump");
    const goal = steps.find((s) => s.step_index === GOAL_INDEX);
    expect(goal?.status).toBe("done");
  });

  it("fails OPEN: a precheck 500 lets the greeting proceed (send attempted)", async () => {
    const businessId = await seedBusiness(db, "Booking Gap Precheck 500");
    const lead = { phone: "+17805550104", email: "failopen@example.com" };
    await seedContact(db, businessId, lead.phone, { email: lead.email });
    const flowId = await createFlow(db, businessId, followUpDefinition());
    const runId = await enqueueRun(
      db,
      flowId,
      businessId,
      { channel: "webhook", from: "facebook_lead_ads" },
      { lead_phone: lead.phone, lead_email: lead.email }
    );

    fakeApp.scriptPrecheckError(500);
    await tickWorker();

    const calls = fakeApp.precheckCalls.filter((c) => c.body.runId === runId);
    expect(calls).toHaveLength(1);

    // The greeting SEND was attempted — in this credential-less harness that
    // surfaces as the Telnyx-config failure, which is exactly the proof the
    // gate did not block the flow. The once-per-run marker is persisted so a
    // retry never re-pays the round-trip.
    const run = await getRun(db, runId);
    expect(run.status).toBe("failed");
    expect(run.last_error).toContain("Telnyx messaging is not configured");
    expect(run.context.vars?.__booking_precheck).toBe("1");
  });

  it("skips the platform round-trip entirely for flows without a booking goal", async () => {
    const businessId = await seedBusiness(db, "Booking Gap No Goal");
    const lead = { phone: "+17805550105", email: "nogoal@example.com" };
    const flowId = await createFlow(db, businessId, {
      version: 1,
      trigger: { channel: "webhook", conditions: [] },
      steps: [
        { id: "s_greet", type: "send_sms", to: "{{vars.lead_phone}}", body: "greeting text" }
      ]
    });
    const runId = await enqueueRun(
      db,
      flowId,
      businessId,
      { channel: "webhook", from: "facebook_lead_ads" },
      { lead_phone: lead.phone, lead_email: lead.email }
    );

    await tickWorker();

    expect(fakeApp.precheckCalls.filter((c) => c.body.runId === runId)).toHaveLength(0);
    // The send was attempted as normal (Telnyx-config failure in harness).
    const run = await getRun(db, runId);
    expect(run.status).toBe("failed");
    expect(run.last_error).toContain("Telnyx messaging is not configured");
  });
});
