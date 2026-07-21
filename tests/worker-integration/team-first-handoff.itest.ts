import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NEEDS_HUMAN_TAG } from "../../supabase/functions/_shared/needs_human";
import { REASONING_MARKER } from "../../supabase/functions/_shared/reply_reasoning";
import { needsHumanTeamFlowDefinition, NEEDS_HUMAN_TEAM_FLOW_NAME } from "@/lib/ai-flows/needs-human-flow";
import {
  ageRun,
  createFlow,
  enqueueSmsJob,
  getContactTags,
  getRun,
  getSteps,
  minutesAgo,
  seedBusiness,
  seedContact,
  serviceDb,
  tickSmsWorker,
  tickWorker
} from "./harness";
import { startFakeRowboat, type FakeRowboat } from "./fake-rowboat";

/**
 * TEAM-FIRST HUMAN HANDOFF, end to end through the REAL workers:
 * a "speak to a representative" turn (classified handoff:false by the model —
 * the Truly 2026-07-20 shape) escalates via the deterministic intent
 * backstop; with businesses.needs_human_team_first ON and the seeded
 * broadcastAll flow enabled, the escalation tags the contact and enqueues
 * the flow INSTEAD of paging the owner; the ai-flow-worker then broadcasts
 * the offer to every active roster member on one 10-minute deadline. The
 * owner hears about it only via a claim notice, or the timeout fallback.
 *
 * Offer/courtesy/fallback SMS cannot leave this harness (no Telnyx env) —
 * the park/claim rows are the durable facts under test.
 */

const LEAD = "+14165550177";
const DANIA = "+14165550881";
const AWAIS = "+14165550882";

/** The live Truly turn: rep request, model says handoff:false. */
const REP_REQUEST_REPLY =
  "I can help with that. Would you like to schedule a call with one of our licensed brokers?\n" +
  `${REASONING_MARKER}{"intent":"request_human_agent","why":"They want a person; offering to book.","handoff":false}`;

let db: SupabaseClient;
let rowboat: FakeRowboat;

beforeAll(async () => {
  db = serviceDb();
  rowboat = await startFakeRowboat();
});

beforeEach(async () => {
  // Same isolation sweep as the sms-reply-pipeline suite: park leftover
  // pending jobs and drop unconsumed scripts so scenarios can't cross-feed.
  await db
    .from("sms_inbound_jobs")
    .update({ status: "dead_letter", last_error: "itest_isolation_sweep" })
    .eq("status", "pending");
  rowboat.clearScript();
});

afterAll(async () => {
  await rowboat.close();
});

async function seedTeamFirstBusiness(
  name: string,
  { toggleOn = true, withFlow = true } = {}
): Promise<{ biz: string; flowId: string | null }> {
  const biz = await seedBusiness(db, name);
  if (toggleOn) {
    const { error } = await db
      .from("businesses")
      .update({ needs_human_team_first: true })
      .eq("id", biz);
    if (error) throw new Error(`toggle seed: ${error.message}`);
  }
  const { error: rosterErr } = await db.from("ai_flow_team_members").insert([
    { business_id: biz, name: "Dania Shaikh", phone_e164: DANIA, active: true },
    { business_id: biz, name: "Awais Chauhan", phone_e164: AWAIS, active: true }
  ]);
  if (rosterErr) throw new Error(`roster seed: ${rosterErr.message}`);
  await seedContact(db, biz, LEAD, { display_name: "Alex Shaikh", tags: ["Privyr"] });
  let flowId: string | null = null;
  if (withFlow) {
    flowId = await createFlow(db, biz, needsHumanTeamFlowDefinition());
    const { error } = await db
      .from("ai_flows")
      .update({ name: NEEDS_HUMAN_TEAM_FLOW_NAME })
      .eq("id", flowId);
    if (error) throw new Error(`flow rename: ${error.message}`);
  }
  return { biz, flowId };
}

async function needsHumanPages(biz: string): Promise<number> {
  const { data, error } = await db
    .from("notifications")
    .select("id, payload")
    .eq("business_id", biz);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ payload: Record<string, unknown> }>).filter(
    (n) => n.payload?.taskType === "sms_needs_human"
  ).length;
}

async function flowRuns(biz: string, flowId: string) {
  const { data, error } = await db
    .from("ai_flow_runs")
    .select("id, status")
    .eq("business_id", biz)
    .eq("flow_id", flowId)
    .order("created_at");
  if (error) throw new Error(error.message);
  return data as Array<{ id: string; status: string }>;
}

/** MIRROR of the webhook's broadcast-claim stamp (see broadcast-offer.itest). */
async function broadcastClaimLikeWebhook(runId: string, from: string): Promise<void> {
  const run = await getRun(db, runId);
  const routing = ((run.context as { routing?: Record<string, unknown> }).routing ??
    {}) as Record<string, unknown>;
  routing.last_event = "claim";
  routing.reply_from = from;
  routing.offered = from;
  routing.offered_name =
    ((routing.offered_names ?? {}) as Record<string, string>)[from] ?? "";
  delete routing.pass_reason;
  const { data, error } = await db
    .from("ai_flow_runs")
    .update({
      status: "queued",
      awaiting_agent_e164: null,
      respond_by_at: null,
      context: { ...run.context, routing },
      updated_at: new Date().toISOString()
    })
    .eq("id", runId)
    .eq("revision", run.revision)
    .in("status", ["awaiting_agent", "queued"])
    .select("id");
  if (error || (data ?? []).length === 0) {
    throw new Error(`broadcastClaimLikeWebhook: ${error?.message ?? "no row updated"}`);
  }
}

describe("team-first human handoff (real sms worker + real flow worker)", () => {
  it("rep request → tag + flow enqueue, NO owner page; broadcast fans out to the whole roster", async () => {
    const { biz, flowId } = await seedTeamFirstBusiness("IT team-first fan-out");
    rowboat.scriptReply(REP_REQUEST_REPLY);
    await enqueueSmsJob(db, biz, LEAD, "I would like to speak to a representative");
    await tickSmsWorker();

    // Escalation state: tag on, flow run enqueued, owner NOT paged.
    expect(await getContactTags(db, biz, LEAD)).toContain(NEEDS_HUMAN_TAG);
    expect(await needsHumanPages(biz)).toBe(0);
    const runs = await flowRuns(biz, flowId!);
    expect(runs).toHaveLength(1);

    // The flow worker fans the offer out to BOTH roster members at once.
    await tickWorker();
    const run = await getRun(db, runs[0].id);
    expect(run.status).toBe("awaiting_agent");
    expect(run.respond_by_at).not.toBeNull();
    const routing = (run.context as { routing?: Record<string, unknown> }).routing ?? {};
    expect(routing.offered_all).toEqual(expect.arrayContaining([DANIA, AWAIS]));
    expect((routing.offered_all as string[]).length).toBe(2);
    // The offer text rendered the customer's message into the SMS body —
    // pinned via the recorded step result being a broadcast park (the sends
    // themselves cannot leave the harness).
    expect(await needsHumanPages(biz)).toBe(0);
  });

  it("first '1' claims: contact assigned to the claimer, still no owner page", async () => {
    const { biz, flowId } = await seedTeamFirstBusiness("IT team-first claim");
    rowboat.scriptReply(REP_REQUEST_REPLY);
    await enqueueSmsJob(db, biz, LEAD, "can I speak to a representative please");
    await tickSmsWorker();
    await tickWorker();
    const runs = await flowRuns(biz, flowId!);
    expect(runs).toHaveLength(1);

    await broadcastClaimLikeWebhook(runs[0].id, DANIA);
    await tickWorker();

    const run = await getRun(db, runs[0].id);
    expect(run.status).toBe("done");
    expect(run.context.vars?.claimed_agent).toBe("Dania Shaikh");
    // The claim auto-assigned the contact to the claimer.
    const { data: contact } = await db
      .from("contacts")
      .select("owner_employee_id")
      .eq("business_id", biz)
      .eq("customer_e164", LEAD)
      .single();
    expect((contact as { owner_employee_id: string | null }).owner_employee_id).not.toBeNull();
    expect(await needsHumanPages(biz)).toBe(0);
  });

  it("nobody claims in 10 minutes: the run falls back to the owner", async () => {
    const { biz, flowId } = await seedTeamFirstBusiness("IT team-first timeout");
    rowboat.scriptReply(REP_REQUEST_REPLY);
    await enqueueSmsJob(db, biz, LEAD, "I want to speak w a rep");
    await tickSmsWorker();
    await tickWorker();
    const runs = await flowRuns(biz, flowId!);
    expect(runs).toHaveLength(1);

    await ageRun(db, runs[0].id, { respond_by_at: minutesAgo(1) });
    await tickWorker();

    const run = await getRun(db, runs[0].id);
    expect(run.status).toBe("done");
    expect(run.context.vars?.claimed_agent).toBe("none");
    const steps = await getSteps(db, runs[0].id);
    const route = steps.find((s) => s.step_type === "route_to_team");
    expect((route?.result as { routed?: string }).routed).toBe("owner_fallback");
  });

  it("toggle OFF (no seeded flow): the owner is paged immediately, exactly as before", async () => {
    const { biz } = await seedTeamFirstBusiness("IT team-first off", {
      toggleOn: false,
      withFlow: false
    });
    rowboat.scriptReply(REP_REQUEST_REPLY);
    await enqueueSmsJob(db, biz, LEAD, "I would like to speak to a rep");
    await tickSmsWorker();

    expect(await getContactTags(db, biz, LEAD)).toContain(NEEDS_HUMAN_TAG);
    expect(await needsHumanPages(biz)).toBeGreaterThan(0);
  });
});
