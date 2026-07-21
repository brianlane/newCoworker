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
  seedBusiness,
  seedContact,
  serviceDb,
  tickWorker
} from "./harness";

/**
 * BROADCAST route_to_team offers (agentNames): every listed roster member is
 * texted at once and shares one claim deadline — first "1" wins, a "2"
 * retires just the passer, everyone passing (or the deadline lapsing) falls
 * back to the owner. Pinned here against the REAL worker + Postgres:
 * fan-out park state, the claim resume (webhook-mirrored), the
 * pass → re-park → all-passed fallback ladder, and the timeout sweep.
 *
 * Offer/courtesy SMS cannot leave this harness (no Telnyx env): those sends
 * are caught per recipient by design (the park/claim is the durable fact),
 * so every scenario still completes — which doubles as coverage for exactly
 * that failure path.
 */

const LEAD = "+14165550166";
const DAVE = "+14165550991";
const AMY = "+14165550992";

function broadcastFlow(): Record<string, unknown> {
  const def = {
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [
      {
        id: "extract",
        type: "extract_text",
        fields: [{ name: "lead_phone", description: "The lead's phone number" }]
      },
      {
        id: "route",
        type: "route_to_team",
        agentNames: ["Dave Lane", "Amy Laidlaw"],
        offerTemplate: "New lead {{vars.lead_phone}} — reply 1 to claim or 2 to pass.",
        ownerFallbackTemplate: "No one claimed {{vars.lead_phone}} — back to you.",
        responseMinutes: 10
      },
      {
        id: "after-claim",
        type: "update_contact",
        addTags: ["Assigned"],
        phoneVar: "lead_phone",
        when: { var: "claimed_agent", notEquals: "none" }
      }
    ]
  };
  parseAiFlowDefinition(def);
  return def;
}

const TRIGGER = {
  channel: "sms",
  from: LEAD,
  windowText: `New lead submitted. Phone: ${LEAD}. Product: Auto.`
};

let db: SupabaseClient;

async function seedRoster(biz: string): Promise<void> {
  const { error } = await db.from("ai_flow_team_members").insert([
    { business_id: biz, name: "Dave Lane", phone_e164: DAVE, active: true },
    { business_id: biz, name: "Amy Laidlaw", phone_e164: AMY, active: true }
  ]);
  if (error) throw new Error(`seedRoster: ${error.message}`);
}

type Routing = Record<string, unknown>;

function routingOf(run: Awaited<ReturnType<typeof getRun>>): Routing {
  return ((run.context as { routing?: Routing }).routing ?? {}) as Routing;
}

/**
 * Consume a broadcast CLAIM the way telnyx-sms-inbound's live path does.
 * MIRROR of the bare-"1" broadcast branch in
 * supabase/functions/telnyx-sms-inbound/index.ts (keep in sync) — the webhook
 * itself can't be invoked here because it verifies Telnyx's Ed25519
 * signature, which a test cannot forge by design.
 */
async function broadcastClaimLikeWebhook(runId: string, from: string): Promise<void> {
  const run = await getRun(db, runId);
  const routing = routingOf(run);
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

/**
 * Consume a broadcast PASS ("2" / "2, <reason>") the way the webhook does:
 * retire the passer from offered_all and stamp the reject. MIRROR (keep in
 * sync with tryAgentPassWithReason / the bare-"2" broadcast branch).
 */
async function broadcastPassLikeWebhook(
  runId: string,
  from: string,
  reason = ""
): Promise<void> {
  const run = await getRun(db, runId);
  const routing = routingOf(run);
  routing.last_event = "reject";
  routing.reply_from = from;
  if (reason) routing.pass_reason = reason;
  else delete routing.pass_reason;
  routing.offered_all = ((routing.offered_all ?? []) as string[]).filter((p) => p !== from);
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
    throw new Error(`broadcastPassLikeWebhook: ${error?.message ?? "no row updated"}`);
  }
}

async function seedBroadcastRun(name: string): Promise<{ biz: string; runId: string }> {
  const biz = await seedBusiness(db, name);
  await seedRoster(biz);
  await seedContact(db, biz, LEAD);
  const flowId = await createFlow(db, biz, broadcastFlow());
  const runId = await enqueueRun(db, flowId, biz, TRIGGER);
  return { biz, runId };
}

beforeAll(() => {
  db = serviceDb();
});

describe("broadcast route_to_team offers (real worker)", () => {
  it("fans out to every listed member at once and parks on one shared deadline", async () => {
    const { runId } = await seedBroadcastRun("IT broadcast fan-out");

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_agent");
    // One shared deadline; no single awaiting agent fits a broadcast.
    expect(run.respond_by_at).not.toBeNull();
    const routing = routingOf(run);
    expect(routing.offered).toBeUndefined();
    expect(routing.offered_all).toEqual([DAVE, AMY]);
    expect(routing.offered_names).toEqual({ [DAVE]: "Dave Lane", [AMY]: "Amy Laidlaw" });
    expect(routing.offered_log).toEqual([DAVE, AMY]);
    expect(typeof routing.offer_deadline_ms).toBe("number");
    expect(routing.step_index).toBe(1);
    expect(routing.route_step_index).toBe(1);
  });

  it("the first claim wins: the run finalizes for the claimer and later claim-gated steps run", async () => {
    const { runId } = await seedBroadcastRun("IT broadcast claim");
    await tickWorker();

    await broadcastClaimLikeWebhook(runId, AMY);
    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    expect(run.context.vars?.claimed_agent).toBe("Amy Laidlaw");
    expect(run.context.vars?.claimed_agent_phone).toBe(AMY);
    const routing = routingOf(run);
    expect(routing.claimed_by).toBe(AMY);
    expect(routing.claimed_name).toBe("Amy Laidlaw");
    // Broadcast state is consumed on the claim (losers were notified
    // best-effort off offered_all before it was cleared).
    expect(routing.offered_all).toBeUndefined();
    expect(routing.offered_names).toBeUndefined();
    expect(routing.offer_deadline_ms).toBeUndefined();

    const steps = await getSteps(db, runId);
    const route = steps.find((s) => s.step_type === "route_to_team");
    expect((route?.result as { routed?: string }).routed).toBe("claimed");
    expect(steps.find((s) => s.step_type === "update_contact")?.status).toBe("done");
  });

  it("a pass retires just that member; when everyone passed the owner gets the fallback", async () => {
    const { runId } = await seedBroadcastRun("IT broadcast passes");
    await tickWorker();

    // Dave passes with a reason: the offer must stay LIVE for Amy.
    await broadcastPassLikeWebhook(runId, DAVE, "showing a house");
    await tickWorker();

    let run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_agent");
    expect(run.respond_by_at).not.toBeNull();
    let routing = routingOf(run);
    expect(routing.offered_all).toEqual([AMY]);
    expect(routing.tried).toEqual([DAVE]);
    expect(routing.pass_reasons).toEqual(["Dave Lane: showing a house"]);

    // Amy passes too: nobody is left — owner fallback, claim-gated steps skip.
    await broadcastPassLikeWebhook(runId, AMY);
    await tickWorker();

    run = await getRun(db, runId);
    expect(run.status).toBe("done");
    expect(run.context.vars?.claimed_agent).toBe("none");
    routing = routingOf(run);
    expect(routing.offered_all).toBeUndefined();
    const steps = await getSteps(db, runId);
    const route = steps.find((s) => s.step_type === "route_to_team");
    expect((route?.result as { routed?: string }).routed).toBe("owner_fallback");
    expect(steps.find((s) => s.step_type === "update_contact")?.status).toBe("skipped");
  });

  it("a claim-then-pass clears the claimer's pointer — they can't re-claim the re-parked broadcast", async () => {
    const { runId } = await seedBroadcastRun("IT broadcast claim-then-pass");
    await tickWorker();

    // Amy claims, then passes BEFORE the worker consumes the claim. The pass
    // rides the single-offer webhook path (her claim stamped routing.offered),
    // which does NOT touch offered_all — mirror that exact shape.
    await broadcastClaimLikeWebhook(runId, AMY);
    {
      const run = await getRun(db, runId);
      const routing = routingOf(run);
      routing.last_event = "reject";
      routing.reply_from = AMY;
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
        throw new Error(`pass-after-claim mirror: ${error?.message ?? "no row updated"}`);
      }
    }
    await tickWorker();

    // The broadcast re-parks for Dave alone, and Amy's stale claim pointer is
    // gone — routing.offered must never survive a broadcast reject, or she
    // could live-claim the lead she just passed on.
    const run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_agent");
    const routing = routingOf(run);
    expect(routing.offered).toBeUndefined();
    expect(routing.offered_name).toBeUndefined();
    expect(routing.offered_all).toEqual([DAVE]);
    expect(routing.tried).toEqual([AMY]);
  });

  it("a pass that raced the lapsed deadline never extends the offer — owner fallback instead", async () => {
    const { runId } = await seedBroadcastRun("IT broadcast pass-after-deadline");
    await tickWorker();

    // Rewind the SHARED deadline into the past (the sweep hasn't fired yet),
    // then let Dave's pass arrive: the reject handler must not re-park Amy
    // on a fresh window past the advertised deadline.
    {
      const run = await getRun(db, runId);
      const routing = routingOf(run);
      routing.offer_deadline_ms = Date.now() - 60_000;
      const { error } = await db
        .from("ai_flow_runs")
        .update({ context: { ...run.context, routing } })
        .eq("id", runId);
      if (error) throw new Error(`deadline rewind: ${error.message}`);
    }
    await broadcastPassLikeWebhook(runId, DAVE);
    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    expect(run.context.vars?.claimed_agent).toBe("none");
    const routing = routingOf(run);
    expect(routing.offered_all).toBeUndefined();
    expect(routing.tried).toEqual(expect.arrayContaining([DAVE, AMY]));
    const steps = await getSteps(db, runId);
    const route = steps.find((s) => s.step_type === "route_to_team");
    expect((route?.result as { routed?: string }).routed).toBe("owner_fallback");
  });

  it("a lapsed shared deadline retires every remaining offeree and falls back to the owner", async () => {
    const { runId } = await seedBroadcastRun("IT broadcast timeout");
    await tickWorker();

    // Lapse the shared deadline; the tick's escalation sweep stamps the
    // timeout and the same tick's claim processes it.
    await ageRun(db, runId, { respond_by_at: minutesAgo(1) });
    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    expect(run.context.vars?.claimed_agent).toBe("none");
    const routing = routingOf(run);
    expect(routing.offered_all).toBeUndefined();
    expect(routing.tried).toEqual(expect.arrayContaining([DAVE, AMY]));
    const steps = await getSteps(db, runId);
    const route = steps.find((s) => s.step_type === "route_to_team");
    expect((route?.result as { routed?: string }).routed).toBe("owner_fallback");
  });
});
