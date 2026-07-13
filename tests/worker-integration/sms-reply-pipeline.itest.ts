import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NEEDS_HUMAN_TAG } from "../../supabase/functions/_shared/needs_human";
import { REASONING_MARKER } from "../../supabase/functions/_shared/reply_reasoning";
import {
  enqueueSmsJob,
  getContactTags,
  getSmsJob,
  seedBusiness,
  seedContact,
  serviceDb,
  tickSmsWorker
} from "./harness";
import { startFakeRowboat, type FakeRowboat } from "./fake-rowboat";

/**
 * The REAL sms-inbound-worker end to end: claim → preamble assembly
 * (customer memory + AiFlow run context) → Rowboat /chat wire → trailer
 * strip → ai_reply_reasoning capture → needs-human escalation through the
 * REAL notifications function → thread persistence.
 *
 * Rowboat itself is the fake in tests/worker-integration/fake-rowboat.ts
 * (the per-tenant agent runtime lives on fleet VPSes and cannot run in CI);
 * everything else in the loop — the worker bundle, Postgres, the
 * notifications function — is real. The live-AI e2e suite separately covers
 * what a real model puts INSIDE the reply.
 *
 * Terminal job state in this harness is dead_letter/missing_telnyx_messaging_env:
 * the suite deliberately carries no Telnyx credentials, and the worker only
 * reaches that check AFTER every AI-path side effect under test has been
 * persisted. A future Telnyx-API fake could close that last hop.
 */

const LEAD = "+14165550188";
const INBOUND_TEXT = "Was supposed to of been Apil 17th but they would not Renew it";

let db: SupabaseClient;
let rowboat: FakeRowboat;

beforeAll(async () => {
  db = serviceDb();
  rowboat = await startFakeRowboat();
});

// Hard test-boundary isolation. Every tick claims EVERY pending job in the
// shared local DB, and the fake's script queue is a global FIFO — so one
// leftover pending job (a prior run's abort, or this suite's deliberate
// retry-path scenario) shifts the queue and poisons every later test with
// someone else's scripted turn (observed live: an escalation-test job
// received a 500 scripted for the dead-letter test). Park all pending jobs
// and drop unconsumed scripts before each test so every scenario starts
// from a clean claimable set and an empty queue.
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

/** Business with a contact primed for the memory + flow-context preambles. */
async function seedLeadWithContext(name: string): Promise<{ biz: string }> {
  const biz = await seedBusiness(db, name);
  await seedContact(db, biz, LEAD, {
    display_name: "Dwight Colclough",
    summary_md: "Auto-insurance lead; no-fault accident dispute; truck parked since April 17.",
    tags: ["Privyr", "Engaged"]
  });
  // A recently-finished flow run + its last outbound text: the exact state
  // after the Truly incident's lead-intake flow ended.
  const { data: flow, error: flowErr } = await db
    .from("ai_flows")
    .insert({
      business_id: biz,
      name: "Lead intake & follow-up (Privyr)",
      enabled: true,
      definition: { version: 1, trigger: { channel: "sms", conditions: [] }, steps: [] }
    })
    .select("id")
    .single();
  if (flowErr) throw new Error(flowErr.message);
  const { error: runErr } = await db.from("ai_flow_runs").insert({
    flow_id: (flow as { id: string }).id,
    business_id: biz,
    status: "done",
    current_step: 3,
    context: {
      trigger: { channel: "tenant_email", from: LEAD },
      vars: { lead_name: "Dwight Colclough", lead_phone: LEAD, product: "auto_insurance" }
    }
  });
  if (runErr) throw new Error(runErr.message);
  const { error: logErr } = await db.from("sms_outbound_log").insert({
    business_id: biz,
    to_e164: LEAD,
    from_e164: "+14165550000",
    body: "Thanks for sharing that - Approximately when does your current policy renew?",
    source: "ai_flow"
  });
  if (logErr) throw new Error(logErr.message);
  return { biz };
}

async function reasoningRows(biz: string) {
  const { data, error } = await db
    .from("ai_reply_reasoning")
    .select("intent, rationale, escalated, reply_preview, inbound_preview, model")
    .eq("business_id", biz)
    .order("created_at");
  if (error) throw new Error(error.message);
  return data as Array<{
    intent: string;
    rationale: string;
    escalated: boolean;
    reply_preview: string;
    inbound_preview: string;
    model: string;
  }>;
}

async function notificationRows(biz: string) {
  const { data, error } = await db
    .from("notifications")
    .select("delivery_channel, status, kind, payload")
    .eq("business_id", biz);
  if (error) throw new Error(error.message);
  return data as Array<{
    delivery_channel: string;
    status: string;
    kind: string;
    payload: Record<string, unknown>;
  }>;
}

describe("sms-inbound-worker reply pipeline (real worker, fake Rowboat wire)", () => {
  it("assembles the full preamble, strips the trailer, and captures reasoning", async () => {
    const { biz } = await seedLeadWithContext("IT sms pipeline");
    rowboat.scriptReply(
      "Thanks Dwight — I've noted April 17th for your broker.\n" +
        `${REASONING_MARKER}{"intent":"policy_renewal_date","why":"They answered the renewal question.","handoff":false}`
    );
    const jobId = await enqueueSmsJob(db, biz, LEAD, INBOUND_TEXT);
    const callsBefore = rowboat.calls.length;
    await tickSmsWorker();

    // --- The wire TO Rowboat: bearer + system preamble + [SMS] user line ---
    expect(rowboat.calls.length).toBe(callsBefore + 1);
    const call = rowboat.calls[callsBefore];
    expect(call.authorization).toBe("Bearer itest-rowboat-bearer");
    const system = call.body.messages.find((m) => m.role === "system");
    const user = call.body.messages.find((m) => m.role === "user");
    expect(user?.content).toBe(`[SMS] ${INBOUND_TEXT}`);
    // Identity/tooling lines and the texter's number...
    expect(system?.content).toContain(`Current texter phone: ${LEAD}`);
    // ...cross-channel memory...
    expect(system?.content).toContain("Known-customer profile");
    expect(system?.content).toContain("no-fault accident dispute");
    // ...the AiFlow context bridge (the post-incident feature, verified on
    // the REAL wire for the first time)...
    expect(system?.content).toContain("Automation context");
    expect(system?.content).toContain("lead_name: Dwight Colclough");
    expect(system?.content).toContain("when does your current policy renew?");
    // ...and the reasoning-trailer instruction closes the preamble.
    expect(system?.content).toContain(REASONING_MARKER);

    // --- Persistence AFTER the reply: strip + capture + thread ---
    const rows = await reasoningRows(biz);
    expect(rows).toHaveLength(1);
    expect(rows[0].intent).toBe("policy_renewal_date");
    expect(rows[0].escalated).toBe(false);
    expect(rows[0].model).toBe("gemini");
    expect(rows[0].reply_preview).toBe("Thanks Dwight — I've noted April 17th for your broker.");
    expect(rows[0].reply_preview).not.toMatch(/reasoning|\{"intent"/i);
    expect(rows[0].inbound_preview).toBe(INBOUND_TEXT);

    const { data: thread } = await db
      .from("sms_rowboat_threads")
      .select("rowboat_conversation_id")
      .eq("business_id", biz)
      .eq("customer_e164", LEAD)
      .maybeSingle();
    expect((thread as { rowboat_conversation_id?: string } | null)?.rowboat_conversation_id).toMatch(
      /^fake-conv-/
    );

    // Harness has no Telnyx creds: the job must park at exactly that check,
    // AFTER all of the above landed, with the retry cache cleared.
    const job = await getSmsJob(db, jobId);
    expect(job.status).toBe("dead_letter");
    expect(job.last_error).toBe("missing_telnyx_messaging_env");
    expect(job.rowboat_reply_cached).toBeNull();
    expect(job.customer_e164).toBe(LEAD);

    // No handoff → no escalation state.
    expect(await getContactTags(db, biz, LEAD)).not.toContain(NEEDS_HUMAN_TAG);
  });

  it("strips the mangled-marker trailer (production leak shape) through the real worker", async () => {
    const { biz } = await seedLeadWithContext("IT sms mangled");
    rowboat.scriptReply(
      "I understand — I'll have your broker reach out to you directly.\n" +
        '\u27E6reasoning}{"intent":"policy_dispute","why":"Mangled marker variant.","handoff":false}\u27E7'
    );
    await enqueueSmsJob(db, biz, LEAD, "I'm tired of insurance refusing to give me insurance");
    await tickSmsWorker();

    const rows = await reasoningRows(biz);
    expect(rows).toHaveLength(1);
    expect(rows[0].intent).toBe("policy_dispute");
    expect(rows[0].reply_preview).toBe(
      "I understand — I'll have your broker reach out to you directly."
    );
    expect(rows[0].reply_preview).not.toMatch(/reasoning|\{"intent"|\u27E6|\u27E7/);
  });

  it("a dead-lettered customer message pages the owner (silence is never the end state)", async () => {
    const { biz } = await seedLeadWithContext("IT dead-letter page");
    // Seeded one claim away from the attempt ceiling (claim increments to
    // MAX_ATTEMPTS=8). One worker attempt = initial call + stateless retry,
    // so two scripted 500s exhaust it.
    const { data, error } = await db
      .from("sms_inbound_jobs")
      .insert({
        business_id: biz,
        status: "pending",
        attempt_count: 7,
        payload: {
          data: { payload: { from: { phone_number: LEAD }, text: "Is my policy active??" } }
        }
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const jobId = (data as { id: string }).id;
    rowboat.scriptError(500);
    rowboat.scriptError(500);
    await tickSmsWorker();

    const job = await getSmsJob(db, jobId);
    expect(job.status).toBe("dead_letter");
    expect(job.last_error).toContain("rowboat_http_500");

    // The needs-human pipeline fired: tag + owner page with the silence copy.
    expect(await getContactTags(db, biz, LEAD)).toContain(NEEDS_HUMAN_TAG);
    const pages = await notificationRows(biz);
    const dashboard = pages.find((n) => n.delivery_channel === "dashboard");
    expect(dashboard?.status).toBe("sent");
    expect(dashboard?.payload.taskType).toBe("sms_needs_human");
    expect(String(dashboard?.payload.summary)).toContain("never got a reply");
    expect(String(dashboard?.payload.summary)).toContain("Dwight Colclough");
  });

  it("a retryable failure below the ceiling does NOT page — the retry owns it", async () => {
    const { biz } = await seedLeadWithContext("IT retry no-page");
    const { data, error } = await db
      .from("sms_inbound_jobs")
      .insert({
        business_id: biz,
        status: "pending",
        payload: { data: { payload: { from: { phone_number: LEAD }, text: "Hello?" } } }
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const jobId = (data as { id: string }).id;
    // One scripted 500 is the whole attempt now: since PR #566, an
    // early-attempt 5xx gets NO stateless retry (it would drop the thread
    // history for a transient upstream outage) — the job-level retry owns it.
    rowboat.scriptError(500);
    await tickSmsWorker();

    const job = await getSmsJob(db, jobId);
    expect(job.status).toBe("pending"); // queued for the next tick's fresh sample
    expect(rowboat.pendingScripts()).toBe(0);
    expect(await getContactTags(db, biz, LEAD)).not.toContain(NEEDS_HUMAN_TAG);
    expect((await notificationRows(biz)).length).toBe(0);
    // (The beforeEach isolation sweep parks this deliberately-pending job
    // before the next scenario runs.)
  });

  it("a handoff turn escalates through the REAL notifications function, once per open state", async () => {
    const { biz } = await seedLeadWithContext("IT sms escalation");
    const trailer =
      `${REASONING_MARKER}{"intent":"policy_dispute","why":"Needs a licensed broker to resolve the refusal.","handoff":true}`;

    rowboat.scriptReply(`I'm sorry — a human on our team needs to take this over.\n${trailer}`);
    await enqueueSmsJob(db, biz, LEAD, "No one will insure me and I am done talking to a robot");
    await tickSmsWorker();

    // Status flip: the contact carries the open-escalation tag.
    expect(await getContactTags(db, biz, LEAD)).toContain(NEEDS_HUMAN_TAG);

    // Owner page: the real notifications function recorded history rows
    // (dashboard delivers with default prefs; SMS/email skip — no channels
    // configured in the harness) with owner-actionable copy and the
    // contactE164 stamp the dedupe relies on.
    const pages = await notificationRows(biz);
    const dashboard = pages.find((n) => n.delivery_channel === "dashboard");
    expect(dashboard?.status).toBe("sent");
    expect(dashboard?.kind).toBe("urgent_alert");
    expect(String(dashboard?.payload.summary)).toContain("needs you to take over");
    expect(String(dashboard?.payload.summary)).toContain("Dwight Colclough");
    expect(dashboard?.payload.taskType).toBe("sms_needs_human");
    expect(dashboard?.payload.contactE164).toBe(LEAD);
    const pageCount = pages.length;

    // A second escalated turn while the tag is still on: already_open — the
    // reply flows normally but the owner is NOT re-paged.
    rowboat.scriptReply(`Understood — the team has been alerted already.\n${trailer}`);
    await enqueueSmsJob(db, biz, LEAD, "Hello?? I said I need a person");
    await tickSmsWorker();

    expect(await reasoningRows(biz)).toHaveLength(2);
    expect((await notificationRows(biz)).length).toBe(pageCount);
  });
});
