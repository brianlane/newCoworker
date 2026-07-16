import { beforeAll, describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ageRun,
  createFlow,
  enqueueRun,
  getRun,
  getSteps,
  minutesAgo,
  resumeReplyLikeWebhook,
  seedBusiness,
  seedContact,
  serviceDb,
  tickWorker
} from "./harness";
import {
  buildBadPhoneSteps,
  FLOW_CONFIGS
} from "../../scripts/oneshot/add-bad-phone-agent-report";

/**
 * The bad-phone-report pattern against the REAL worker: after a
 * route_to_team claim, the flow parks a wait_for_reply on the CLAIMING
 * teammate (engine var claimed_agent_phone) for their stated ETA + 60
 * minutes (claimed_agent_eta_minutes → math → timeoutMinutesTemplate), then
 * classifies their next free text and either emails (bad number) or forwards
 * the note to the owner (anything else).
 *
 * The served worker has no GOOGLE_API_KEY, so a real classify deterministically
 * resolves to the reserved "unclear" fallback — which takes the branch's ELSE
 * arm, exactly like a live "other_update". The bad_phone_number arm's category
 * accuracy is pinned by the live-Gemini e2e suite
 * (tests/e2e/bad-phone-classify.e2e.test.ts); the arm's wiring (branch
 * condition → arm steps) is ordinary branch machinery covered by the branch
 * suites.
 */

const LEAD = "+14165550123";
const AGENT_PHONE = "+14165550777";

/** The REAL appended steps from the one-shot (Clever config: 1 lead email). */
const BP_STEPS = buildBadPhoneSteps(FLOW_CONFIGS.find((c) => c.flowName === "Clever Lead - Accept")!);

function badPhoneFlow(): Record<string, unknown> {
  const def = {
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    options: { suppressDefaultReply: false },
    steps: [
      {
        id: "extract",
        type: "extract_text",
        fields: [
          { name: "lead_phone", description: "The lead's phone number" },
          { name: "lead_email", description: "The lead's email address" },
          { name: "lead_name", description: "The lead's name" },
          { name: "lead_address", description: "The lead's address" }
        ]
      },
      {
        id: "route",
        type: "route_to_team",
        offerTemplate: "New lead {{vars.lead_phone}} — reply 1 to claim or 2 to pass.",
        ownerFallbackTemplate: "No one claimed {{vars.lead_phone}} — back to you.",
        responseMinutes: 10
      },
      ...BP_STEPS
    ]
  };
  parseAiFlowDefinition(def);
  return def;
}

const TRIGGER = {
  channel: "sms",
  from: LEAD,
  windowText: `New integration lead. Phone: ${LEAD}. Please follow up.`
};

let db: SupabaseClient;

async function seedRoster(biz: string): Promise<void> {
  const { error } = await db
    .from("ai_flow_team_members")
    .insert({ business_id: biz, name: "Dave", phone_e164: AGENT_PHONE, active: true });
  if (error) throw new Error(`seedRoster: ${error.message}`);
}

/**
 * Resume a parked route_to_team offer the way telnyx-sms-inbound's live-claim
 * path does. MIRROR of tryAgentClaimWithTimeframe / the bare-"1" resume in
 * supabase/functions/telnyx-sms-inbound/index.ts (keep in sync) — the webhook
 * itself can't be invoked here because it verifies Telnyx's Ed25519
 * signature, which a test cannot forge by design.
 */
async function claimLikeWebhook(runId: string, from: string, timeframe = ""): Promise<void> {
  const run = await getRun(db, runId);
  const routing = ((run.context as { routing?: Record<string, unknown> }).routing ??
    {}) as Record<string, unknown>;
  routing.last_event = "claim";
  routing.reply_from = from;
  if (timeframe) routing.claim_timeframe = timeframe;
  else delete routing.claim_timeframe;
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
    throw new Error(`claimLikeWebhook: ${error?.message ?? "no row updated"}`);
  }
}

/**
 * Retroactive unclaim ("86") the way telnyx-sms-inbound's tryUnclaim does.
 * MIRROR (keep in sync) — including `awaiting_reply` in the status lists,
 * which is the fix that lets an "86" beat a parked bad-phone-report wait
 * instead of being swallowed by it as a "report" text. Returns the run id it
 * re-opened, or null when this teammate holds no claimed lead.
 */
const UNCLAIM_STATUSES = ["done", "awaiting_agent", "queued", "awaiting_approval", "awaiting_reply"];
async function unclaimLikeWebhook(businessId: string, from: string): Promise<string | null> {
  const { data } = await db
    .from("ai_flow_runs")
    .select("id, status, context, updated_at, revision")
    .eq("business_id", businessId)
    .in("status", UNCLAIM_STATUSES)
    .not("context->routing", "is", null)
    .order("updated_at", { ascending: false })
    .limit(25);
  for (const row of (data ?? []) as Array<{
    id: string;
    context: Record<string, unknown> | null;
    revision: number;
  }>) {
    const routing = (row.context?.routing ?? {}) as Record<string, unknown>;
    if (routing.claimed_by !== from) continue;
    const idx = typeof routing.route_step_index === "number" ? routing.route_step_index : -1;
    if (idx < 0) continue;
    routing.last_event = "unclaim";
    routing.reply_from = from;
    const { data: reopened, error } = await db
      .from("ai_flow_runs")
      .update({
        status: "queued",
        current_step: idx,
        awaiting_agent_e164: null,
        respond_by_at: null,
        claimed_at: null,
        earliest_claim_at: null,
        context: { ...(row.context ?? {}), routing },
        updated_at: new Date().toISOString()
      })
      .eq("id", row.id)
      .eq("revision", row.revision)
      .in("status", UNCLAIM_STATUSES)
      .select("id");
    if (error || (reopened ?? []).length === 0) {
      throw new Error(`unclaimLikeWebhook: ${error?.message ?? "no row updated"}`);
    }
    return row.id;
  }
  return null;
}

async function stepByType(
  runId: string,
  type: string
): Promise<{ step_index: number; step_type: string; status: string; result: unknown } | undefined> {
  return (await getSteps(db, runId)).find((s) => s.step_type === type);
}

beforeAll(() => {
  db = serviceDb();
});

describe("bad-phone report wait (real worker)", () => {
  it('claim with "1, 30 min": stamps the new engine vars and parks on the CLAIMER for ETA + 60', async () => {
    const biz = await seedBusiness(db, "IT badphone eta");
    await seedRoster(biz);
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(db, biz, badPhoneFlow());
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();
    expect((await getRun(db, runId)).status).toBe("awaiting_agent");

    await claimLikeWebhook(runId, AGENT_PHONE, "30 min");
    await tickWorker();

    const parked = await getRun(db, runId);
    expect(parked.status).toBe("awaiting_reply");
    // The wait watches the CLAIMER's phone, not the lead's.
    expect(parked.context.waiting_reply).toMatchObject({ from: AGENT_PHONE });
    expect(parked.context.vars?.claimed_agent).toBe("Dave");
    expect(parked.context.vars?.claimed_agent_phone).toBe(AGENT_PHONE);
    expect(parked.context.vars?.claimed_agent_eta_minutes).toBe("30");
    // math: 30 + 60 = 90-minute window, applied via timeoutMinutesTemplate.
    expect(parked.context.vars?.report_wait_minutes).toBe("90");
    const respondBy = new Date(parked.respond_by_at!).getTime();
    expect(respondBy).toBeGreaterThan(Date.now() + 80 * 60_000);
    expect(respondBy).toBeLessThan(Date.now() + 95 * 60_000);
  });

  it("free-text report resumes the wait; classify (unclear without a key) takes the else arm and forwards the note", async () => {
    const biz = await seedBusiness(db, "IT badphone forward");
    await seedRoster(biz);
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(db, biz, badPhoneFlow());
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();
    await claimLikeWebhook(runId, AGENT_PHONE);
    await tickWorker();
    expect((await getRun(db, runId)).status).toBe("awaiting_reply");

    const resumed = await resumeReplyLikeWebhook(db, biz, AGENT_PHONE, "left a voicemail, will try again tomorrow");
    expect(resumed).toContain(runId);
    await tickWorker();

    const done = await getRun(db, runId);
    expect(done.status).toBe("done");
    expect(done.context.vars?.agent_report).toBe("left a voicemail, will try again tomorrow");
    // No GOOGLE_API_KEY in the served worker → the reserved fallback.
    expect(done.context.vars?.agent_report_class).toBe("unclear");
    // The else arm's owner forward ran; the bad-phone emails did not.
    expect((await stepByType(runId, "notify_owner"))?.status).toBe("done");
    const steps = await getSteps(db, runId);
    for (const s of steps.filter((x) => x.step_type === "send_email")) {
      expect(s.status).not.toBe("done");
    }
  });

  it("bare claim: 60-minute window; a silent timeout resolves no_reply and sends NOTHING", async () => {
    const biz = await seedBusiness(db, "IT badphone timeout");
    await seedRoster(biz);
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(db, biz, badPhoneFlow());
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();
    await claimLikeWebhook(runId, AGENT_PHONE);
    await tickWorker();

    const parked = await getRun(db, runId);
    expect(parked.status).toBe("awaiting_reply");
    // Bare "1": eta 0 → 0 + 60 = 60-minute window.
    expect(parked.context.vars?.claimed_agent_eta_minutes).toBe("0");
    expect(parked.context.vars?.report_wait_minutes).toBe("60");
    const respondBy = new Date(parked.respond_by_at!).getTime();
    expect(respondBy).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(respondBy).toBeLessThan(Date.now() + 65 * 60_000);

    await ageRun(db, runId, { respond_by_at: minutesAgo(5) });
    await tickWorker();

    const done = await getRun(db, runId);
    expect(done.status).toBe("done");
    expect(done.context.vars?.agent_report).toBe("no_reply");
    // Classify is gated off no_reply; both branch arms stay silent.
    expect((await stepByType(runId, "classify"))?.status).toBe("skipped");
    const steps = await getSteps(db, runId);
    expect(steps.find((s) => s.step_type === "notify_owner")?.status).not.toBe("done");
    for (const s of steps.filter((x) => x.step_type === "send_email")) {
      expect(s.status).not.toBe("done");
    }
  });

  it('claim then "86" 15 minutes later: the unclaim beats the parked wait (awaiting_reply is claimable back)', async () => {
    const biz = await seedBusiness(db, "IT badphone unclaim");
    await seedRoster(biz);
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(db, biz, badPhoneFlow());
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();
    await claimLikeWebhook(runId, AGENT_PHONE, "20 min");
    await tickWorker();
    expect((await getRun(db, runId)).status).toBe("awaiting_reply");

    // The "86" must resolve via the unclaim path — the awaiting_reply status
    // is in tryUnclaim's candidate list (the 1c fix). Were it not, the text
    // would fall through to the wait and be recorded as an agent_report.
    const reopened = await unclaimLikeWebhook(biz, AGENT_PHONE);
    expect(reopened).toBe(runId);
    await tickWorker();

    const done = await getRun(db, runId);
    expect(done.status).toBe("done");
    // Claim fully cleared; the "86" never became a report.
    expect(done.context.vars?.claimed_agent).toBe("none");
    expect(done.context.vars?.claimed_agent_phone).toBe("none");
    expect(done.context.vars?.claimed_agent_eta_minutes).toBe("0");
    expect(done.context.vars?.agent_report).toBeUndefined();
    const route = await stepByType(runId, "route_to_team");
    expect((route?.result as { routed?: string }).routed).toBe("unclaimed");
  });

  it("never claimed (roster exhausted → owner fallback): the wait resolves instantly, no park, nothing sent", async () => {
    const biz = await seedBusiness(db, "IT badphone unclaimed");
    await seedRoster(biz);
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(db, biz, badPhoneFlow());
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();
    expect((await getRun(db, runId)).status).toBe("awaiting_agent");
    // Offer lapses; the escalation sweep re-queues, the 1-member roster is
    // exhausted, and the owner fallback runs.
    await ageRun(db, runId, { respond_by_at: minutesAgo(5) });
    await tickWorker();

    const done = await getRun(db, runId);
    // claimed_agent_phone stays "none" → the wait planner resolves straight
    // to the no_reply sentinel: the run completes without ever parking.
    expect(done.status).toBe("done");
    expect(done.context.vars?.claimed_agent_phone).toBe("none");
    expect(done.context.vars?.agent_report).toBe("no_reply");
    expect(done.context.waiting_reply ?? null).toBeNull();
    const steps = await getSteps(db, runId);
    expect(steps.find((s) => s.step_type === "classify")?.status).toBe("skipped");
    expect(steps.find((s) => s.step_type === "notify_owner")?.status).not.toBe("done");
    for (const s of steps.filter((x) => x.step_type === "send_email")) {
      expect(s.status).not.toBe("done");
    }
  });
});
