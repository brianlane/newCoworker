import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ageRun,
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
import {
  UNTEXTABLE_SMS_VAR,
  readUntextableSms
} from "../../supabase/functions/_shared/ai_flows/untextable_sms";

/**
 * International SMS with NO P2P gateway configured (the itest env never sets
 * TELNYX_INTL_GATEWAY_E164): the send has no route, tenant A2P long codes
 * are domestic-only (Telnyx ticket #557577), so the step must SKIP with a
 * designed reason and the run must CONTINUE.
 *
 * Pinned against the real served worker because what this replaces was a
 * run-killer: KYP Ads / VFM, Aug 12 2026. A Meta lead arrived with a real
 * Indian mobile (+91...), the greeting send_sms hit Telnyx's permanent 409
 * 40306 ("Alpha sender not configured"), and the terminal step failure
 * killed the run with 13 steps never run: the whole nurture ladder, the
 * "lead went quiet" human flag, and the contact wrap-up.
 *
 * The skip alone left two lies standing, pinned here since Sep 2026:
 *   - the lead heard nothing, so a lead-facing skip now emails the same
 *     message to the address on the contact record (through the tenant AI
 *     mailbox, the fake app standing in for Resend);
 *   - the flow's owner alerts kept saying "I sent them the greeting", so the
 *     run records the skip and every owner alert that follows carries the
 *     honest note, and a run with no owner alert ahead gets a standalone one.
 *
 * Contrast with bad-phone-backstop.itest.ts: an impossible +1 number is a
 * DATA bug and still fails the step (the number is not real). A valid
 * international number is a ROUTE gap: the number is real, the platform
 * just cannot text it yet, and the flow's remaining steps are exactly how
 * the lead still gets handled.
 */

const BUSINESS_DID = "+16028053377";
/** The owner's forwarding cell (NANP, so notify_owner goes out as a text). */
const OWNER_FORWARD = "+16025550177";
/** A real, structurally valid Indian mobile (the Aug 12 2026 lead's shape). */
const INDIAN_LEAD = "+917782876437";
const INDIAN_LEAD_EMAIL = "ravi@example.com";
/** Hong Kong roster phone: the KYP owner-cell class from the tenant dossier. */
const HK_ROSTER_PHONE = "+85260100607";
const DOMESTIC_LEAD = "+16025550144";
const GREETING = "Hey Ravi, it's James. Grab a time here: calendly.example/james";

let db: SupabaseClient;
let app: FakeApp;

beforeAll(async () => {
  db = serviceDb();
  app = await startFakeApp();
});

beforeEach(() => {
  app.clearScript();
  app.telnyxSends.length = 0;
  app.resendSends.length = 0;
});

afterAll(async () => {
  await app.close();
});

async function seedTelnyx(biz: string, forward?: string): Promise<void> {
  const { error } = await db.from("business_telnyx_settings").insert({
    business_id: biz,
    telnyx_messaging_profile_id: "itest-profile",
    telnyx_sms_from_e164: BUSINESS_DID,
    ...(forward ? { forward_to_e164: forward } : {})
  });
  if (error) throw new Error(`telnyx settings: ${error.message}`);
}

async function settleRun(runId: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await tickWorker();
    const status = (await getRun(db, runId)).status;
    if (status !== "queued" && status !== "running") break;
  }
}

async function systemLogs(biz: string, event: string) {
  const { data, error } = await db
    .from("system_logs")
    .select("level, event, message, payload")
    .eq("business_id", biz)
    .eq("event", event);
  if (error) throw new Error(`system_logs read: ${error.message}`);
  return (data ?? []) as Array<{
    level: string;
    event: string;
    message: string;
    payload: Record<string, unknown>;
  }>;
}

/** notifications rows the notify_owner email fallback wrote for one run. */
async function ownerFallbackRows(biz: string, runId: string) {
  const { data, error } = await db
    .from("notifications")
    .select("delivery_channel, status, payload")
    .eq("business_id", biz)
    .eq("payload->>taskType", "owner_notify_fallback")
    .eq("payload->>runId", runId);
  if (error) throw new Error(`notifications read: ${error.message}`);
  return (data ?? []) as Array<{
    delivery_channel: string;
    status: string;
    payload: Record<string, unknown>;
  }>;
}

describe("send_sms international no-gateway skip", () => {
  it("skips an international lead text and keeps the rest of the run alive", async () => {
    const biz = await seedBusiness(db, "Intl SMS skip");
    await seedTelnyx(biz);

    const flowId = await createFlow(db, biz, {
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        { id: "s_greet", type: "send_sms", to: INDIAN_LEAD, body: "hello from the flow" },
        { id: "s_after", type: "send_sms", to: DOMESTIC_LEAD, body: "the run kept going" }
      ]
    });
    const runId = await enqueueRun(db, flowId, biz, {}, {});
    await settleRun(runId);

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    expect(run.last_error).toBeNull();

    const steps = await getSteps(db, runId);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.status).toBe("skipped");
    expect(steps[0]?.result).toMatchObject({
      skipped: "international_sms_no_gateway",
      to: INDIAN_LEAD,
      country: "IN",
      lead_facing: true,
      // No contact record for this number, so nothing to email.
      email_fallback: "no_email",
      email_to: null
    });
    expect(steps[1]?.status).toBe("done");

    // Only the domestic text reached the carrier. The lead was never emailed
    // (no address to use); the one email that did go out is the standalone
    // owner alert below, to the OWNER's address through the notify fallback.
    expect(app.telnyxSends).toHaveLength(1);
    expect(JSON.stringify(app.telnyxSends[0]?.body ?? {})).toContain(DOMESTIC_LEAD);
    const recipients = app.resendSends.map((s) => JSON.stringify(s.body.to));
    expect(recipients.some((r) => r.includes(`owner+${biz.slice(0, 8)}@example.com`))).toBe(true);
    expect(recipients.some((r) => r.includes(INDIAN_LEAD_EMAIL))).toBe(false);
    // No owner alert step in this flow, so the platform told the owner itself.
    expect(await systemLogs(biz, "ai_flow_sms_international_owner_alerted")).toHaveLength(1);

    // The skip is operator-visible: a run note and a warn in the log tail.
    const actions = String(run.context.vars?.actions_taken ?? "");
    expect(actions).toContain("could not text");
    expect(actions).toContain(INDIAN_LEAD);
    expect(actions).toContain("no email on file");

    const logs = await systemLogs(biz, "ai_flow_sms_international_skipped");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe("warn");
    expect(String(logs[0]?.message ?? "")).toContain(INDIAN_LEAD);
    expect(logs[0]?.payload).toMatchObject({ lead_facing: true, email_fallback: "no_email" });

    // The run remembers the skip for the owner-facing surfaces.
    expect(readUntextableSms(run.context.vars)).toMatchObject({
      to: INDIAN_LEAD,
      country: "IN",
      skipped: 1,
      emailed: 0,
      emailTo: null
    });
  });

  it("emails the lead the same message when their contact record has an address, and the flow's own owner alert tells the truth", async () => {
    const biz = await seedBusiness(db, "Intl SMS email fallback");
    await seedTelnyx(biz, OWNER_FORWARD);
    await seedContact(db, biz, INDIAN_LEAD, { email: INDIAN_LEAD_EMAIL, display_name: "Ravi" });

    // The KYP lead-flow shape in miniature: greet, then tell the owner "I
    // sent them the greeting".
    const flowId = await createFlow(db, biz, {
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        { id: "s_greet", type: "send_sms", to: "{{vars.lead_phone}}", body: GREETING },
        {
          id: "s_notify",
          type: "notify_owner",
          message:
            "New lead: {{vars.lead_name}}, {{vars.lead_phone}}. I sent them the greeting and I'm on follow-up duty."
        }
      ]
    });
    const runId = await enqueueRun(db, flowId, biz, {}, { lead_phone: INDIAN_LEAD, lead_name: "Ravi" });
    await settleRun(runId);

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    expect(run.last_error).toBeNull();

    const steps = await getSteps(db, runId);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.status).toBe("skipped");
    expect(steps[0]?.result).toMatchObject({
      skipped: "international_sms_no_gateway",
      to: INDIAN_LEAD,
      country: "IN",
      lead_facing: true,
      email_fallback: "emailed",
      email_to: INDIAN_LEAD_EMAIL
    });
    expect(steps[1]?.status).toBe("done");

    // The lead got the text's content by email, through the tenant mailbox,
    // keyed on the run + step like every other flow email.
    expect(app.resendSends).toHaveLength(1);
    const email = app.resendSends[0]!;
    expect(email.body.to).toBe(INDIAN_LEAD_EMAIL);
    expect(email.body.text).toBe(GREETING);
    expect(email.body.subject).toBe("Following up on your inquiry");
    expect(email.idempotencyKey).toBe(`aiflow-email/${runId}/0`);
    const { data: emailRows, error: emailErr } = await db
      .from("email_log")
      .select("to_email, body_full, source, run_id")
      .eq("business_id", biz)
      .eq("run_id", runId);
    if (emailErr) throw new Error(`email_log read: ${emailErr.message}`);
    expect(emailRows).toHaveLength(1);
    expect(emailRows?.[0]).toMatchObject({
      to_email: INDIAN_LEAD_EMAIL,
      body_full: GREETING,
      source: "tenant_mailbox_outbound"
    });

    // Exactly one carrier send: the owner's alert. It keeps the flow's copy
    // and appends what really happened, so "I sent them the greeting" is not
    // the last word about a text that never went out.
    expect(app.telnyxSends).toHaveLength(1);
    const ownerText = String(app.telnyxSends[0]?.body.text ?? "");
    expect(app.telnyxSends[0]?.body.to).toBe(OWNER_FORWARD);
    expect(ownerText).toContain("I sent them the greeting and I'm on follow-up duty. Note: ");
    expect(ownerText).toContain(`${INDIAN_LEAD} is a number in India`);
    expect(ownerText).toContain("was not sent");
    expect(ownerText).toContain(`I emailed the same message to ${INDIAN_LEAD_EMAIL} instead.`);

    // The flow's alert carried the note, so no standalone alert was sent.
    expect(await systemLogs(biz, "ai_flow_sms_international_owner_alerted")).toHaveLength(0);
    expect(readUntextableSms(run.context.vars)).toMatchObject({
      skipped: 1,
      emailed: 1,
      emailTo: INDIAN_LEAD_EMAIL,
      told: true
    });

    const actions = String(run.context.vars?.actions_taken ?? "");
    expect(actions).toContain(`emailed the same message to ${INDIAN_LEAD_EMAIL} instead`);
    const logs = await systemLogs(biz, "ai_flow_sms_international_skipped");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.payload).toMatchObject({ email_fallback: "emailed", email_to: INDIAN_LEAD_EMAIL });
  });

  it("alerts the owner on its own when no owner alert step is about to fire, then the late flag still carries the note", async () => {
    const biz = await seedBusiness(db, "Intl SMS standalone owner alert");
    // No forwarding number: the owner alert takes the email + dashboard
    // fallback, which is the only channel that reaches an owner like KYP's.
    await seedTelnyx(biz);
    await seedContact(db, biz, INDIAN_LEAD, { display_name: "Ravi" });

    // The went-quiet ladder in miniature: the only owner alert is gated on a
    // reply var the wait has not produced yet when the greeting skips.
    const flowId = await createFlow(db, biz, {
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        { id: "s_greet", type: "send_sms", to: "{{vars.lead_phone}}", body: GREETING },
        {
          id: "s_wait",
          type: "wait_for_reply",
          saveAs: "reply_1",
          phoneVar: "lead_phone",
          timeoutMinutes: 60
        },
        {
          id: "s_flag",
          type: "notify_owner",
          when: { var: "reply_1", equals: "no_reply" },
          message: "Personal touch needed: {{vars.lead_name}} hasn't replied to 3 follow-ups."
        }
      ]
    });
    const runId = await enqueueRun(db, flowId, biz, {}, { lead_phone: INDIAN_LEAD, lead_name: "Ravi" });
    await tickWorker();

    const parked = await getRun(db, runId);
    expect(parked.status).toBe("awaiting_reply");
    const steps = await getSteps(db, runId);
    expect(steps[0]?.status).toBe("skipped");
    expect(steps[0]?.result).toMatchObject({
      skipped: "international_sms_no_gateway",
      lead_facing: true,
      email_fallback: "no_email"
    });
    expect(app.telnyxSends).toHaveLength(0);

    // The standalone alert went out through the notify_owner ladder, at the
    // greeting's step index, and reached the owner by email + dashboard.
    const alerted = await systemLogs(biz, "ai_flow_sms_international_owner_alerted");
    expect(alerted).toHaveLength(1);
    expect(alerted[0]?.payload).toMatchObject({ step_index: 0, to: INDIAN_LEAD, notified: "email" });
    const standalone = (await ownerFallbackRows(biz, runId)).filter(
      (r) => r.payload.stepIndex === 0 || r.payload.stepIndex === "0"
    );
    expect(standalone.length).toBeGreaterThan(0);
    for (const row of standalone) {
      const summary = String(row.payload.summary ?? "");
      expect(summary).toContain("Heads up: I could not text the lead.");
      expect(summary).toContain(`${INDIAN_LEAD} is a number in India`);
      expect(summary).toContain("They have no email on file, so they have not heard from us.");
    }
    expect(standalone.find((r) => r.delivery_channel === "dashboard")?.status).toBe("sent");
    expect(readUntextableSms(parked.context.vars)?.told).toBe(true);
    expect(String(parked.context.vars?.actions_taken ?? "")).toContain(
      "told the owner the lead's number cannot be texted"
    );

    // The wait times out, the flag fires, and it carries the note too, so
    // "hasn't replied to 3 follow-ups" cannot read as three texts delivered.
    await ageRun(db, runId, { respond_by_at: minutesAgo(5) });
    await settleRun(runId);
    const done = await getRun(db, runId);
    expect(done.status).toBe("done");
    expect(done.context.vars?.reply_1).toBe("no_reply");
    const flag = (await getSteps(db, runId)).find((s) => s.step_type === "notify_owner");
    expect(flag?.status).toBe("done");
    const flagRows = (await ownerFallbackRows(biz, runId)).filter(
      (r) => r.payload.stepIndex === 2 || r.payload.stepIndex === "2"
    );
    expect(flagRows.length).toBeGreaterThan(0);
    for (const row of flagRows) {
      const summary = String(row.payload.summary ?? "");
      expect(summary).toContain("Ravi hasn't replied to 3 follow-ups. Note: ");
      expect(summary).toContain("was not sent");
    }
    // Told once: the flag carrying the note did not trigger a second
    // standalone alert.
    expect(await systemLogs(biz, "ai_flow_sms_international_owner_alerted")).toHaveLength(1);
    expect(typeof done.context.vars?.[UNTEXTABLE_SMS_VAR]).toBe("string");
  });

  it("skips a roster text to an international teammate instead of failing the run", async () => {
    const biz = await seedBusiness(db, "Intl roster skip");
    await seedTelnyx(biz);
    const { error: rosterErr } = await db.from("ai_flow_team_members").insert({
      business_id: biz,
      name: "Hong Kong Harry",
      phone_e164: HK_ROSTER_PHONE,
      active: true
    });
    if (rosterErr) throw new Error(`roster: ${rosterErr.message}`);

    const flowId = await createFlow(db, biz, {
      version: 1,
      trigger: { channel: "manual" },
      steps: [{ id: "s1", type: "send_sms", toAgentName: "Hong Kong Harry", body: "team ping" }]
    });
    const runId = await enqueueRun(db, flowId, biz, {}, {});
    await settleRun(runId);

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");

    const steps = await getSteps(db, runId);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.status).toBe("skipped");
    expect(steps[0]?.result).toMatchObject({
      skipped: "international_sms_no_gateway",
      to: HK_ROSTER_PHONE,
      country: "HK",
      // A teammate is not a lead: no email fallback, no owner bookkeeping.
      lead_facing: false,
      email_fallback: "no_email"
    });

    // The carrier was never asked, nothing was emailed, and the lead-side
    // record stays empty.
    expect(app.telnyxSends).toHaveLength(0);
    expect(app.resendSends).toHaveLength(0);
    expect(readUntextableSms(run.context.vars)).toBeNull();
    expect(await systemLogs(biz, "ai_flow_sms_international_owner_alerted")).toHaveLength(0);
  });
});
