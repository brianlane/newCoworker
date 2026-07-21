import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
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

/**
 * KYP noise incident (Jul 20 2026, Tim Tsai): the "No-show recovery text"
 * AiFlow (calendar trigger, on=event_end, followMinutes=120) texted Tim a
 * rebooking link at 19:31 UTC — 2h23m AFTER he had already texted "will have
 * to rebook as mentioned" (17:08) and the AI worker had already answered
 * with a rebooking link. Three senders (owner, AI worker, AiFlows) share one
 * thread with zero coordination, so the flow re-sent what the conversation
 * had already handled.
 *
 * The fix pinned here: before an event_end-triggered run's first
 * customer-facing send, the worker checks the recipient's thread for
 * activity since the calendar event STARTED (Tim's last inbound landed
 * mid-appointment, before the event's end) — an inbound from the contact or
 * any outbound to them means the conversation is live, so the canned
 * recovery text is skipped and the run completes with an honest skip note.
 * A silent thread still gets the text (the case the flow exists for).
 */

const EVENT_TITLE = "KYP Ads Free Strategy Call";

/** No-show-recovery-shaped flow: one lead-facing text, then an owner note. */
function noShowDefinition() {
  return {
    version: 1,
    trigger: {
      channel: "calendar" as const,
      on: "event_end",
      followMinutes: 120,
      conditions: [{ type: "contains", value: "invitee no-show: yes", caseInsensitive: true }]
    },
    steps: [
      {
        id: "s_recovery",
        type: "send_sms",
        to: "{{vars.invitee_phone}}",
        body: "Hey {{vars.invitee_first_name}}, sorry we missed each other! Want to grab another time? https://calendly.com/james-kyp-ads/kyp-ads-free-strategy-2"
      },
      { id: "s_note", type: "notify_owner", message: "Recovery text sent to {{vars.invitee_phone}}" }
    ]
  };
}

/**
 * Enqueue an event_end run the way the calendar poller does (Tim's shape),
 * including the poller's `cal:<eventId>:end:<endIso>` dedupe key — the
 * authoritative marker the gate uses to know WHICH trigger fired.
 * `withDedupeKey: false` models manual replays / older rows (the gate then
 * falls back to the flow definition).
 */
async function enqueueNoShowRun(
  db: SupabaseClient,
  flowId: string,
  businessId: string,
  lead: string,
  event: { startsAt?: string; endsAt: string },
  opts: { withDedupeKey?: boolean } = {}
): Promise<string> {
  const eventId = `EV-${flowId.slice(0, 8)}`;
  return enqueueRun(
    db,
    flowId,
    businessId,
    {
      channel: "calendar",
      windowText:
        `title: ${EVENT_TITLE}\nends: ${event.endsAt}\n` +
        `invitee name: Tim Tsai\ninvitee no-show: yes`,
      url: null,
      from: "",
      event_id: eventId,
      event_title: EVENT_TITLE,
      calendar: "primary",
      ...(event.startsAt ? { starts_at: event.startsAt } : {}),
      ends_at: event.endsAt
    },
    { invitee_phone: lead, invitee_first_name: "Tim" },
    opts.withDedupeKey === false
      ? {}
      : { dedupe_key: `cal:${eventId}:end:${event.endsAt}` }
  );
}

/** A processed inbound from the lead (what a customer text leaves behind). */
async function seedInboundActivity(
  db: SupabaseClient,
  businessId: string,
  lead: string,
  atIso: string
): Promise<void> {
  const { error } = await db.from("sms_inbound_jobs").insert({
    business_id: businessId,
    status: "done",
    customer_e164: lead,
    created_at: atIso,
    payload: { data: { payload: { from: { phone_number: lead }, text: "will have to rebook as mentioned" } } }
  });
  if (error) throw new Error(`seedInboundActivity: ${error.message}`);
}

let db: SupabaseClient;
let fakeApp: FakeApp;

beforeAll(async () => {
  db = serviceDb();
  // Answers the worker's per-tick poll kicks (and any precheck) quietly.
  fakeApp = await startFakeApp();
});

afterAll(async () => {
  await fakeApp.close();
});

// Park leftover queued runs so this file's ticks execute only its own runs.
beforeEach(async () => {
  await db
    .from("ai_flow_runs")
    .update({ earliest_claim_at: new Date(Date.now() + 60 * 60_000).toISOString() })
    .eq("status", "queued");
  fakeApp.clearScript();
});

describe("event_end thread-activity guard (Tim Tsai's timeline)", () => {
  it("skips the recovery text when the lead texted DURING the appointment window (fails pre-fix)", async () => {
    const biz = await seedBusiness(db, "IT event-end active thread");
    const lead = "+17805550201";
    await seedContact(db, biz, lead, { display_name: "Tim Tsai" });
    const flowId = await createFlow(db, biz, noShowDefinition());
    // Event ran 150→120 minutes ago; Tim texted 8 minutes into it (BEFORE
    // the event's end — the incident's exact shape) and the run fires now.
    const startsAt = minutesAgo(150);
    const endsAt = minutesAgo(120);
    await seedInboundActivity(db, biz, lead, minutesAgo(142));
    const runId = await enqueueNoShowRun(db, flowId, biz, lead, { startsAt, endsAt });

    await tickWorker();

    // The run completed WITHOUT texting the lead: the send step is recorded
    // as skipped with the thread-activity reason, not attempted (attempting
    // would have failed loudly on this business's absent Telnyx config).
    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    expect(run.last_error).toBeNull();
    const steps = await getSteps(db, runId);
    const recovery = steps.find((s) => s.step_index === 0);
    expect(recovery?.status).toBe("skipped");
    expect((recovery?.result as { skipped?: string })?.skipped).toBe("event_end_thread_active");

    // Nothing went out to the lead from this run.
    const { data: outbound } = await db
      .from("sms_outbound_log")
      .select("id")
      .eq("business_id", biz)
      .eq("run_id", runId);
    expect(outbound ?? []).toHaveLength(0);
  });

  it("a trigger with no starts_at still suppresses a mid-appointment text (end-minus-margin fallback)", async () => {
    const biz = await seedBusiness(db, "IT event-end no-start anchor");
    const lead = "+17805550205";
    await seedContact(db, biz, lead, { display_name: "Tim Tsai" });
    const flowId = await createFlow(db, biz, noShowDefinition());
    // Event end known, start missing: Tim's text 22 minutes before the end
    // (mid-appointment) must still count as thread activity (Bugbot Medium
    // on PR #795 — the old ends_at anchor missed exactly this window).
    await seedInboundActivity(db, biz, lead, minutesAgo(142));
    const runId = await enqueueNoShowRun(db, flowId, biz, lead, { endsAt: minutesAgo(120) });

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    const recovery = (await getSteps(db, runId)).find((s) => s.step_index === 0);
    expect(recovery?.status).toBe("skipped");
    expect((recovery?.result as { skipped?: string })?.skipped).toBe("event_end_thread_active");
  });

  it("owner/manual outbound after the event also suppresses the recovery text", async () => {
    const biz = await seedBusiness(db, "IT event-end owner handled");
    const lead = "+17805550202";
    await seedContact(db, biz, lead, { display_name: "Tim Tsai" });
    const flowId = await createFlow(db, biz, noShowDefinition());
    const startsAt = minutesAgo(150);
    const endsAt = minutesAgo(120);
    // The owner texted the lead from the dashboard 30 minutes after the call.
    const { error } = await db.from("sms_outbound_log").insert({
      business_id: biz,
      to_e164: lead,
      from_e164: "+14385550000",
      body: "Hey Tim, just checking if you can still make it — we can rebook.",
      source: "dashboard_chat",
      created_at: minutesAgo(90)
    });
    if (error) throw new Error(error.message);
    const runId = await enqueueNoShowRun(db, flowId, biz, lead, { startsAt, endsAt });

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    const recovery = (await getSteps(db, runId)).find((s) => s.step_index === 0);
    expect(recovery?.status).toBe("skipped");
    expect((recovery?.result as { skipped?: string })?.skipped).toBe("event_end_thread_active");
  });

  it("a SILENT thread still gets the recovery text (the case the flow exists for)", async () => {
    const biz = await seedBusiness(db, "IT event-end silent thread");
    const lead = "+17805550203";
    await seedContact(db, biz, lead, { display_name: "Rey Mendoza" });
    const flowId = await createFlow(db, biz, noShowDefinition());
    const runId = await enqueueNoShowRun(db, flowId, biz, lead, {
      startsAt: minutesAgo(150),
      endsAt: minutesAgo(120)
    });

    await tickWorker();

    // The send was ATTEMPTED: with no Telnyx config in the harness the step
    // fails with the config error — proof the guard let it through.
    const run = await getRun(db, runId);
    expect(run.status).toBe("failed");
    expect(run.last_error).toContain("Telnyx messaging is not configured");
  });

  it("a run with no dedupe key on a pure event_end flow still suppresses (definition fallback)", async () => {
    const biz = await seedBusiness(db, "IT event-end no-dedupe fallback");
    const lead = "+17805550206";
    await seedContact(db, biz, lead, { display_name: "Tim Tsai" });
    const flowId = await createFlow(db, biz, noShowDefinition());
    await seedInboundActivity(db, biz, lead, minutesAgo(142));
    const runId = await enqueueNoShowRun(
      db,
      flowId,
      biz,
      lead,
      { startsAt: minutesAgo(150), endsAt: minutesAgo(120) },
      { withDedupeKey: false }
    );

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    const recovery = (await getSteps(db, runId)).find((s) => s.step_index === 0);
    expect((recovery?.result as { skipped?: string })?.skipped).toBe("event_end_thread_active");
  });

  it("an event_start run of a mixed-trigger flow is NEVER stood down (reminders still send)", async () => {
    const biz = await seedBusiness(db, "IT event-start not gated");
    const lead = "+17805550207";
    await seedContact(db, biz, lead, { display_name: "Tim Tsai" });
    // One flow, two calendar triggers: a pre-call reminder (event_start) and
    // the no-show recovery (event_end). The reminder run must send even when
    // the thread is active — suppressing it would kill legitimate reminders
    // (Bugbot Medium on PR #795).
    const def = noShowDefinition() as Record<string, unknown> & {
      triggers?: unknown[];
    };
    def.triggers = [
      { channel: "calendar", on: "event_start", leadMinutes: 150, calendar: "primary", conditions: [] }
    ];
    const flowId = await createFlow(db, biz, def);
    // The lead texted recently — thread is "active" by the gate's measure.
    await seedInboundActivity(db, biz, lead, minutesAgo(30));
    const startsAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const eventId = `EV-${flowId.slice(0, 8)}`;
    const runId = await enqueueRun(
      db,
      flowId,
      biz,
      {
        channel: "calendar",
        windowText: `title: ${EVENT_TITLE}\nstarts: ${startsAt}\ninvitee no-show: yes`,
        url: null,
        from: "",
        event_id: eventId,
        event_title: EVENT_TITLE,
        calendar: "primary",
        starts_at: startsAt
      },
      { invitee_phone: lead, invitee_first_name: "Tim" },
      // The poller's event_start dedupe key carries NO ":end:" segment.
      { dedupe_key: `cal:${eventId}:${startsAt}` }
    );

    await tickWorker();

    // The send was ATTEMPTED (Telnyx-config failure), not skipped.
    const run = await getRun(db, runId);
    expect(run.status).toBe("failed");
    expect(run.last_error).toContain("Telnyx messaging is not configured");
  });

  it("activity from BEFORE the event started does not suppress (old nudges are not a live thread)", async () => {
    const biz = await seedBusiness(db, "IT event-end stale activity");
    const lead = "+17805550204";
    await seedContact(db, biz, lead, { display_name: "Jasmine N O" });
    const flowId = await createFlow(db, biz, noShowDefinition());
    // The lead's last text was two days ago — the booking-nudge exchange,
    // long before this appointment's window.
    await seedInboundActivity(db, biz, lead, minutesAgo(2 * 24 * 60));
    const runId = await enqueueNoShowRun(db, flowId, biz, lead, {
      startsAt: minutesAgo(150),
      endsAt: minutesAgo(120)
    });

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("failed");
    expect(run.last_error).toContain("Telnyx messaging is not configured");
  });
});
