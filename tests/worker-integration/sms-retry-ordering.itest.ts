import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { STATELESS_5XX_MIN_ATTEMPT } from "../../supabase/functions/_shared/sms_rowboat";
import { enqueueSmsJob, getSmsJob, seedBusiness, serviceDb, tickSmsWorker } from "./harness";
import { startFakeRowboat, type FakeRowboat } from "./fake-rowboat";

/**
 * Pins the 2026-07-13 duplicate-reply/duplicate-booking incident fixes on the
 * REAL sms-inbound-worker + REAL Postgres (PR #566):
 *
 *  1. A Rowboat 5xx on an EARLY attempt no longer triggers the
 *     history-dropping stateless retry — the failure surfaces to the
 *     job-level retry, which re-runs STATEFUL with the thread intact.
 *  2. On a LATE attempt the stateless reset is allowed as the last resort,
 *     and the reset call carries the recent-thread transcript block so the
 *     model can't restart intake.
 *  3. claim_sms_inbound_jobs serializes per contact: rapid-fire inbounds
 *     drain oldest-first, one at a time, so replies can't interleave.
 *  4. The calendar_booking_dedupe ledger's uniqueness contract (what the
 *     app-side claim/CAS relies on) holds in the migrated schema.
 */

const LEAD = "+15485773546";

let db: SupabaseClient;
let rowboat: FakeRowboat;

beforeAll(async () => {
  db = serviceDb();
  rowboat = await startFakeRowboat();
});

// Same hard isolation as the reply-pipeline suite: park leftovers, drop
// unconsumed scripts (see sms-reply-pipeline.itest.ts for the rationale).
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

/** Bind the contact's SMS thread to a Rowboat continuation. */
async function seedThread(biz: string, conversationId: string): Promise<void> {
  const { error } = await db.from("sms_rowboat_threads").insert({
    business_id: biz,
    customer_e164: LEAD,
    rowboat_conversation_id: conversationId,
    rowboat_state: { seeded: true }
  });
  if (error) throw new Error(`seedThread: ${error.message}`);
}

/** Pending job with explicit attempt_count / created_at / customer_e164. */
async function seedJob(
  biz: string,
  text: string,
  over: Record<string, unknown> = {}
): Promise<string> {
  const { data, error } = await db
    .from("sms_inbound_jobs")
    .insert({
      business_id: biz,
      status: "pending",
      customer_e164: LEAD,
      payload: { data: { payload: { from: { phone_number: LEAD }, text } } },
      ...over
    })
    .select("id")
    .single();
  if (error) throw new Error(`seedJob: ${error.message}`);
  return (data as { id: string }).id;
}

describe("5xx retry semantics (history preservation, PR #566 fix 2)", () => {
  it("an early-attempt 500 gets NO stateless retry — one stateful call, job requeued", async () => {
    const biz = await seedBusiness(db, "IT 5xx early stateful");
    await seedThread(biz, "conv-KEEP");
    const jobId = await seedJob(biz, "Please book July 13 4pm");

    const before = rowboat.calls.length;
    rowboat.scriptError(500);
    await tickSmsWorker();

    // Exactly ONE wire call (pre-fix: two — initial + history-dropping
    // stateless retry), and it carried the stored continuation.
    expect(rowboat.calls.length).toBe(before + 1);
    expect(rowboat.calls[before].body.conversationId).toBe("conv-KEEP");

    // The failure went to the job-level retry: pending again, thread intact.
    const job = await getSmsJob(db, jobId);
    expect(job.status).toBe("pending");
    expect(job.last_error).toContain("rowboat_http_500");
    const { data: thread } = await db
      .from("sms_rowboat_threads")
      .select("rowboat_conversation_id")
      .eq("business_id", biz)
      .eq("customer_e164", LEAD)
      .maybeSingle();
    expect((thread as { rowboat_conversation_id?: string } | null)?.rowboat_conversation_id).toBe(
      "conv-KEEP"
    );
    expect(rowboat.pendingScripts()).toBe(0);
  });

  it("a late-attempt 500 falls back stateless WITH the recent-thread transcript", async () => {
    const biz = await seedBusiness(db, "IT 5xx late transcript");
    await seedThread(biz, "conv-STALE");
    // Prior completed exchange → the transcript the reset must carry.
    await seedJob(biz, "I want to book a call", {
      status: "done",
      assistant_reply_text: "I have Monday, July 13th at 4:00 PM EDT available. Does that work?",
      created_at: new Date(Date.now() - 3 * 60_000).toISOString()
    });
    // Claim bumps attempt_count, so seeding (threshold - 1) makes THIS the
    // first attempt allowed to reset.
    const jobId = await seedJob(biz, "Please book July 13 4pm", {
      attempt_count: STATELESS_5XX_MIN_ATTEMPT - 1
    });

    const before = rowboat.calls.length;
    rowboat.scriptError(500);
    rowboat.scriptReply("Ok — booking your July 13 4:00 PM call now.");
    await tickSmsWorker();

    expect(rowboat.calls.length).toBe(before + 2);
    const first = rowboat.calls[before];
    const retry = rowboat.calls[before + 1];
    expect(first.body.conversationId).toBe("conv-STALE");
    // The reset: no continuation, and the system preamble now carries the
    // transcript block (the anti-"restart intake" context).
    expect(retry.body.conversationId).toBeUndefined();
    const system = retry.body.messages.find((m) => m.role === "system");
    expect(system?.content).toContain("Recent SMS conversation with this texter");
    expect(system?.content).toContain("Texter: I want to book a call");
    expect(system?.content).toContain("You: I have Monday, July 13th at 4:00 PM EDT available.");
    // The first (stateful) call must NOT carry it — Rowboat holds history there.
    const firstSystem = first.body.messages.find((m) => m.role === "system");
    expect(firstSystem?.content).not.toContain("Recent SMS conversation with this texter");

    // Reply accepted; job proceeds to the harness's terminal Telnyx check.
    const job = await getSmsJob(db, jobId);
    expect(job.status).toBe("dead_letter");
    expect(job.last_error).toBe("missing_telnyx_messaging_env");
  });
});

describe("per-contact FIFO claim (PR #566 fix 4)", () => {
  it("rapid-fire inbounds drain strictly oldest-first, one tick apart", async () => {
    const biz = await seedBusiness(db, "IT contact fifo");
    const jobA = await seedJob(biz, "August 1st", {
      created_at: new Date(Date.now() - 2 * 60_000).toISOString()
    });
    const jobB = await seedJob(biz, "I wanna book a call", {
      created_at: new Date(Date.now() - 60_000).toISOString()
    });

    const before = rowboat.calls.length;
    rowboat.scriptReply("Noted — August 1st renewal.");
    await tickSmsWorker();

    // Tick 1: only the OLDER job ran (pre-fix: both claimed in one batch).
    expect(rowboat.calls.length).toBe(before + 1);
    expect(rowboat.calls[before].body.messages.at(-1)?.content).toBe("[SMS] August 1st");
    expect((await getSmsJob(db, jobA)).status).toBe("dead_letter"); // terminal Telnyx check
    expect((await getSmsJob(db, jobB)).status).toBe("pending");

    rowboat.scriptReply("Happy to book that call.");
    await tickSmsWorker();

    // Tick 2: the newer job runs only after the older one finished.
    expect(rowboat.calls.length).toBe(before + 2);
    expect(rowboat.calls[before + 1].body.messages.at(-1)?.content).toBe(
      "[SMS] I wanna book a call"
    );
    expect((await getSmsJob(db, jobB)).status).toBe("dead_letter");
  });

  it("a processing job blocks its contact's queue (stale-claim sweep owns recovery)", async () => {
    const biz = await seedBusiness(db, "IT fifo processing block");
    await seedJob(biz, "first message", {
      status: "processing",
      processing_started_at: new Date().toISOString(),
      created_at: new Date(Date.now() - 2 * 60_000).toISOString()
    });
    const jobB = await seedJob(biz, "second message", {
      created_at: new Date(Date.now() - 60_000).toISOString()
    });

    const before = rowboat.calls.length;
    await tickSmsWorker();

    expect(rowboat.calls.length).toBe(before);
    expect((await getSmsJob(db, jobB)).status).toBe("pending");
  });

  it("different contacts still drain in the same tick (no cross-contact serialization)", async () => {
    const biz = await seedBusiness(db, "IT fifo parallel contacts");
    await seedJob(biz, "from lead one", {
      created_at: new Date(Date.now() - 2 * 60_000).toISOString()
    });
    const other = await (async () => {
      const { data, error } = await db
        .from("sms_inbound_jobs")
        .insert({
          business_id: biz,
          status: "pending",
          customer_e164: "+14165550199",
          payload: {
            data: { payload: { from: { phone_number: "+14165550199" }, text: "from lead two" } }
          },
          created_at: new Date(Date.now() - 60_000).toISOString()
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return (data as { id: string }).id;
    })();

    const before = rowboat.calls.length;
    rowboat.scriptReply("Reply for lead one.");
    rowboat.scriptReply("Reply for lead two.");
    await tickSmsWorker();

    expect(rowboat.calls.length).toBe(before + 2);
    expect((await getSmsJob(db, other)).status).toBe("dead_letter");
  });

  it("legacy NULL-sender jobs are exempt from serialization (pre-fix behavior)", async () => {
    const biz = await seedBusiness(db, "IT fifo null exempt");
    // enqueueSmsJob does NOT stamp customer_e164 — exactly the legacy shape.
    await enqueueSmsJob(db, biz, LEAD, "legacy one");
    await enqueueSmsJob(db, biz, LEAD, "legacy two");

    const before = rowboat.calls.length;
    rowboat.scriptReply("Reply one.");
    rowboat.scriptReply("Reply two.");
    await tickSmsWorker();

    expect(rowboat.calls.length).toBe(before + 2);
  });
});

describe("calendar_booking_dedupe schema contract (PR #566 fix 1)", () => {
  it("enforces one live claim per (business, attendee, start) via the unique index", async () => {
    const biz = await seedBusiness(db, "IT booking dedupe uniq");
    const claim = {
      business_id: biz,
      attendee_key: `phone:${LEAD}`,
      start_at: "2026-07-13T20:00:00Z"
    };
    const { error: first } = await db.from("calendar_booking_dedupe").insert(claim);
    expect(first).toBeNull();
    const { error: dup } = await db.from("calendar_booking_dedupe").insert(claim);
    // 23505 is the exact signal claimBookingDedupe branches on.
    expect((dup as { code?: string } | null)?.code).toBe("23505");
  });
});
