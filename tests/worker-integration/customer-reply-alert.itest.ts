import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  enqueueSmsJob,
  getSmsJob,
  seedBusiness,
  seedContact,
  serviceDb,
  tickSmsWorker
} from "./harness";
import { startFakeRowboat, type FakeRowboat } from "./fake-rowboat";

/**
 * Opt-in "client replied" owner alerts, end to end against the REAL
 * sms-inbound-worker + REAL notifications function (KYP, Jul 20 2026):
 * James — "You need to let me know when clients text back i didnt see his
 * texts". The AI promised immediate alerts, but no per-client-reply owner
 * notification existed; he missed Tim Tsai's replies while working the
 * thread live.
 *
 * The alert is DETERMINISTIC pipeline code, not a model tool: it fires when
 * a claimed job is identified as a customer inbound, BEFORE the reply
 * branches — so flow-suppressed inbounds, tapbacks, and bare "1" replies
 * alert too. Gated on `notification_preferences.customer_reply_alerts`
 * (default false, opt-in), with a per-contact coalescing window so a
 * multi-part text or rapid back-and-forth is ONE alert.
 */

const LEAD = "+17808039935";
const INBOUND_TEXT = "HI - will have to rebook as mentioned";
const TASK_TYPE = "sms_customer_reply";

let db: SupabaseClient;
let rowboat: FakeRowboat;

beforeAll(async () => {
  db = serviceDb();
  rowboat = await startFakeRowboat();
});

// Same isolation sweep as sms-reply-pipeline.itest.ts: park leftover pending
// jobs and drop unconsumed scripts so each scenario starts clean.
beforeEach(async () => {
  await db
    .from("sms_inbound_jobs")
    .update({ status: "dead_letter", last_error: "itest_isolation_sweep" })
    .eq("status", "pending");
  rowboat.clearScript();
});

afterAll(async () => {
  await rowboat.close();
});

async function seedOptedInBusiness(name: string): Promise<string> {
  const biz = await seedBusiness(db, name);
  await seedContact(db, biz, LEAD, { display_name: "Tim Tsai" });
  const { error } = await db
    .from("notification_preferences")
    .insert({ business_id: biz, customer_reply_alerts: true });
  if (error) throw new Error(`seedOptedInBusiness: ${error.message}`);
  return biz;
}

async function alertRows(biz: string) {
  const { data, error } = await db
    .from("notifications")
    .select("delivery_channel, status, summary, payload")
    .eq("business_id", biz)
    .eq("payload->>taskType", TASK_TYPE);
  if (error) throw new Error(error.message);
  return data as Array<{
    delivery_channel: string;
    status: string;
    summary: string;
    payload: Record<string, unknown>;
  }>;
}

describe("customer reply alerts (opt-in, real worker + real notifications function)", () => {
  it("opted in: a customer inbound pages the owner with the preview (fails pre-fix)", async () => {
    const biz = await seedOptedInBusiness("IT reply-alert on");
    rowboat.scriptReply("No problem at all, Tim — here to help.");
    const jobId = await enqueueSmsJob(db, biz, LEAD, INBOUND_TEXT);
    await tickSmsWorker();

    const rows = await alertRows(biz);
    expect(rows.length).toBeGreaterThan(0);
    // Dashboard channel delivers even with Telnyx/Resend unconfigured in the
    // itest stack (those channels record skipped rows instead).
    const dashboard = rows.find((r) => r.delivery_channel === "dashboard");
    expect(dashboard?.status).toBe("sent");
    expect(dashboard?.summary).toContain("Tim Tsai");
    expect(dashboard?.summary).toContain("texted back");
    expect(dashboard?.summary).toContain(INBOUND_TEXT);
    // The contact stamp the per-contact coalesce relies on.
    expect(dashboard?.payload.contactE164).toBe(LEAD);

    // The reply pipeline itself is untouched: the job proceeded normally
    // (this business seeds no Telnyx settings, so it parks at the env check
    // AFTER the alert + reply side effects, exactly like the older suites).
    const job = await getSmsJob(db, jobId);
    expect(job.status).toBe("dead_letter");
    expect(job.last_error).toBe("missing_telnyx_messaging_env");
  });

  it("coalesces: a second text from the same contact inside the window does NOT re-page", async () => {
    const biz = await seedOptedInBusiness("IT reply-alert coalesce");
    rowboat.scriptReply("Got it!");
    await enqueueSmsJob(db, biz, LEAD, "First message");
    await tickSmsWorker();
    const countAfterFirst = (await alertRows(biz)).length;
    expect(countAfterFirst).toBeGreaterThan(0);

    rowboat.scriptReply("Understood!");
    await enqueueSmsJob(db, biz, LEAD, "Second message right away");
    await tickSmsWorker();
    expect((await alertRows(biz)).length).toBe(countAfterFirst);
  });

  it("alerts even when the AI reply is suppressed (tapback) — the alert is not tied to a reply", async () => {
    const biz = await seedOptedInBusiness("IT reply-alert tapback");
    // NO scripted Rowboat reply: tapback suppression fires before any model
    // call, so an unexpected /chat would fail loudly on the empty script.
    const jobId = await enqueueSmsJob(db, biz, LEAD, "Liked \u201CSee you then!\u201D");
    await tickSmsWorker();

    const rows = await alertRows(biz);
    const dashboard = rows.find((r) => r.delivery_channel === "dashboard");
    expect(dashboard?.status).toBe("sent");

    const job = await getSmsJob(db, jobId);
    expect(job.status).toBe("done");
    expect(job.last_error).toBe("suppressed_tapback");
  });

  it("a PAUSED tenant's client text still pages — silence is exactly when the owner needs it", async () => {
    const biz = await seedOptedInBusiness("IT reply-alert paused");
    const { error } = await db.from("businesses").update({ is_paused: true }).eq("id", biz);
    if (error) throw new Error(error.message);
    // No scripted Rowboat reply: a paused tenant's job dead-letters before
    // any model call, so an unexpected /chat fails loudly on the empty script.
    const jobId = await enqueueSmsJob(db, biz, LEAD, "Are you still open?");
    await tickSmsWorker();

    const job = await getSmsJob(db, jobId);
    expect(job.status).toBe("dead_letter");
    expect(job.last_error).toBe("paused");

    const rows = await alertRows(biz);
    const dashboard = rows.find((r) => r.delivery_channel === "dashboard");
    expect(dashboard?.status).toBe("sent");
    expect(dashboard?.summary).toContain("texted back");
  });

  it("staff texts never alert (the owner texting the assistant is not a client reply)", async () => {
    const biz = await seedOptedInBusiness("IT reply-alert staff");
    const { error } = await db.from("sms_inbound_jobs").insert({
      business_id: biz,
      status: "pending",
      staff_kind: "owner",
      staff_name: "James Lee",
      payload: {
        data: { payload: { from: { phone_number: "+15145188192" }, text: "sam did tim reply?" } }
      }
    });
    if (error) throw new Error(error.message);
    rowboat.scriptReply("Checking now, James!");
    await tickSmsWorker();

    expect(await alertRows(biz)).toHaveLength(0);
  });

  it("default (no prefs row) and explicit false: silent", async () => {
    const noPrefs = await seedBusiness(db, "IT reply-alert default");
    await seedContact(db, noPrefs, LEAD, { display_name: "Tim Tsai" });
    rowboat.scriptReply("Hi!");
    await enqueueSmsJob(db, noPrefs, LEAD, "hello?");
    await tickSmsWorker();
    expect(await alertRows(noPrefs)).toHaveLength(0);

    const optedOut = await seedBusiness(db, "IT reply-alert off");
    await seedContact(db, optedOut, LEAD, { display_name: "Tim Tsai" });
    const { error } = await db
      .from("notification_preferences")
      .insert({ business_id: optedOut, customer_reply_alerts: false });
    if (error) throw new Error(error.message);
    rowboat.scriptReply("Hi!");
    await enqueueSmsJob(db, optedOut, LEAD, "hello?");
    await tickSmsWorker();
    expect(await alertRows(optedOut)).toHaveLength(0);
  });
});
