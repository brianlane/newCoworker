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
import { startFakeApp, type FakeApp } from "./fake-app";

/**
 * KYP noise incident (Jul 20 2026, Tim Tsai): the AI worker's SMS replies
 * carried RAW booking URLs ("calendly.com/james-kyp-ads/my-free-scale-plan")
 * while every AiFlow text in the same thread carried tracked
 * newcoworker.com/s/<code> short links — two link shapes for the same action
 * in one customer thread, and the AI-reply links were invisible to click
 * analytics. Two fixes pinned here against the REAL served sms-inbound-worker:
 *
 *   1. Short-linked AI replies: a fresh Rowboat reply's long URLs are
 *      rewritten to tracked /s/<code> redirects (sms_links rows, source
 *      "sms_auto_reply") BEFORE the reply is cached + sent, so the DELIVERED
 *      body matches what AiFlow sends look like and clicks are measurable.
 *   2. Booking-status preamble: before building the customer preamble, the
 *      worker asks the platform for the texter's calendar state
 *      (POST /api/internal/contact-booking-context, cron-bearer) and injects
 *      the answered line — so "was my reschedule received?" gets an informed
 *      answer instead of a confident denial. Fail-open: no answer, no line.
 *
 * The Telnyx hop is REAL here for the first time: the suite points the
 *  worker's TELNYX_API_BASE at the fake app's /v2/messages, so the delivered
 * text (not just the cached one) is assertable. Businesses that seed no
 * telnyx settings still dead-letter at missing_telnyx_messaging_env exactly
 * as the older suites assert (the env carries an API key but no profile).
 */

const LEAD = "+17805550188";
/** Long enough to shorten against the itest base URL (https://ncw.example). */
const BOOKING_URL = "https://calendly.com/james-kyp-ads/my-free-scale-plan";
const BARE_BOOKING_URL = "calendly.com/james-kyp-ads/kyp-ads-free-strategy-2";
const SHORT_BASE = "https://ncw.example/s/";

let db: SupabaseClient;
let rowboat: FakeRowboat;
let app: FakeApp;

beforeAll(async () => {
  db = serviceDb();
  rowboat = await startFakeRowboat();
  app = await startFakeApp();
});

// Same isolation sweep as sms-reply-pipeline.itest.ts: park leftover pending
// jobs and drop unconsumed scripts so each scenario starts clean.
beforeEach(async () => {
  await db
    .from("sms_inbound_jobs")
    .update({ status: "dead_letter", last_error: "itest_isolation_sweep" })
    .eq("status", "pending");
  rowboat.clearScript();
  app.clearScript();
});

afterAll(async () => {
  await rowboat.close();
  await app.close();
});

/** Business whose replies can actually SEND (profile + from seeded). */
async function seedSendableBusiness(name: string): Promise<string> {
  const biz = await seedBusiness(db, name);
  const { error } = await db.from("business_telnyx_settings").insert({
    business_id: biz,
    telnyx_messaging_profile_id: "itest-profile",
    telnyx_sms_from_e164: "+14385550000"
  });
  if (error) throw new Error(`seedSendableBusiness: ${error.message}`);
  await seedContact(db, biz, LEAD, { display_name: "Tim Tsai" });
  return biz;
}

async function smsLinkRows(biz: string) {
  const { data, error } = await db
    .from("sms_links")
    .select("short_code, original_url, to_e164, source, flow_id, run_id")
    .eq("business_id", biz)
    .order("created_at");
  if (error) throw new Error(error.message);
  return data as Array<{
    short_code: string;
    original_url: string;
    to_e164: string | null;
    source: string;
    flow_id: string | null;
    run_id: string | null;
  }>;
}

describe("AI-reply short links (real worker, fake Rowboat + fake Telnyx)", () => {
  it("rewrites long URLs in a fresh reply to tracked /s/ links before sending (fails pre-fix)", async () => {
    const biz = await seedSendableBusiness("IT short-linked reply");
    rowboat.scriptReply(
      `No problem at all, Tim. You can rebook here: ${BOOKING_URL} ` +
        `or the strategy call: ${BARE_BOOKING_URL}`
    );
    const jobId = await enqueueSmsJob(db, biz, LEAD, "HI - will have to rebook as mentioned");
    const sendsBefore = app.telnyxSends.length;
    await tickSmsWorker();

    // The DELIVERED body carries our short links, never the raw URLs.
    expect(app.telnyxSends.length).toBe(sendsBefore + 1);
    const send = app.telnyxSends[sendsBefore];
    expect(send.body.to).toBe(LEAD);
    expect(send.body.text).toContain(SHORT_BASE);
    expect(send.body.text).not.toContain("calendly.com");

    // Both URLs got tracked rows attributed to the AI-reply surface.
    const links = await smsLinkRows(biz);
    expect(links).toHaveLength(2);
    expect(new Set(links.map((l) => l.original_url))).toEqual(
      new Set([BOOKING_URL, `https://${BARE_BOOKING_URL}`])
    );
    for (const link of links) {
      expect(link.source).toBe("sms_auto_reply");
      expect(link.to_e164).toBe(LEAD);
      expect(send.body.text).toContain(`/s/${link.short_code}`);
    }

    // Job completed through the real send; the durable dashboard copy shows
    // exactly what the customer received (short links included).
    const job = await getSmsJob(db, jobId);
    expect(job.status).toBe("done");
    const { data: jobRow } = await db
      .from("sms_inbound_jobs")
      .select("assistant_reply_text, telnyx_outbound_message_id")
      .eq("id", jobId)
      .single();
    expect((jobRow as { assistant_reply_text?: string }).assistant_reply_text).toContain(
      SHORT_BASE
    );
    expect((jobRow as { telnyx_outbound_message_id?: string }).telnyx_outbound_message_id).toMatch(
      /^fake-tx-/
    );
  });

  it("a reply with no shortenable URLs sends unchanged and mints no link rows", async () => {
    const biz = await seedSendableBusiness("IT no-links reply");
    rowboat.scriptReply("Sounds good — see you at 1:00 PM Eastern!");
    await enqueueSmsJob(db, biz, LEAD, "What time zone is that?");
    const sendsBefore = app.telnyxSends.length;
    await tickSmsWorker();

    expect(app.telnyxSends.length).toBe(sendsBefore + 1);
    expect(app.telnyxSends[sendsBefore].body.text).toBe(
      "Sounds good — see you at 1:00 PM Eastern!"
    );
    expect(await smsLinkRows(biz)).toHaveLength(0);
  });
});

describe("booking-status preamble (real worker, scripted platform answer)", () => {
  it("injects the platform's booking-status line into the Rowboat system preamble (fails pre-fix)", async () => {
    const biz = await seedSendableBusiness("IT booking context");
    // The business timezone must ride the lookup so the platform renders the
    // booking start business-local (KYP/Ayanna timezone incident).
    const { error: tzErr } = await db
      .from("businesses")
      .update({ timezone: "America/Toronto" })
      .eq("id", biz);
    if (tzErr) throw new Error(tzErr.message);
    const LINE =
      'This contact has an upcoming booking: "KYP Ads Free Strategy Call" starting Thu, Jul 23, 2026, 2:00 PM EDT (they rescheduled it from an earlier time).';
    app.scriptBookingContext(LINE);
    rowboat.scriptReply("Yes Tim — I see you moved our call to Thursday. See you then!");
    const callsBefore = rowboat.calls.length;
    await enqueueSmsJob(db, biz, LEAD, "I did propose a new time last week. Was that received?");
    await tickSmsWorker();

    // The worker asked the platform for this texter's calendar state,
    // cron-authed, before generating the reply.
    expect(app.bookingContextCalls.length).toBeGreaterThanOrEqual(1);
    const ctxCall = app.bookingContextCalls[app.bookingContextCalls.length - 1];
    expect(ctxCall.authorization).toBe("Bearer itest-cron-secret");
    expect(ctxCall.body.businessId).toBe(biz);
    expect(ctxCall.body.phone).toBe(LEAD);
    expect(ctxCall.body.timezone).toBe("America/Toronto");

    // ...and the answered line rode into the system preamble verbatim.
    expect(rowboat.calls.length).toBe(callsBefore + 1);
    const system = rowboat.calls[callsBefore].body.messages.find((m) => m.role === "system");
    expect(system?.content).toContain("Booking status:");
    expect(system?.content).toContain(LINE);
  });

  it("no booking context (line null) leaves the preamble without a booking-status section", async () => {
    const biz = await seedSendableBusiness("IT booking context none");
    // Unscripted → the fake answers { line: null }.
    rowboat.scriptReply("Happy to help!");
    const callsBefore = rowboat.calls.length;
    await enqueueSmsJob(db, biz, LEAD, "hello");
    await tickSmsWorker();

    expect(rowboat.calls.length).toBe(callsBefore + 1);
    const system = rowboat.calls[callsBefore].body.messages.find((m) => m.role === "system");
    expect(system?.content).not.toContain("Booking status:");
  });
});
