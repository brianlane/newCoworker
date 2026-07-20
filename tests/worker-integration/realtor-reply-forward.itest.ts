import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ageRun,
  createFlow,
  enqueueRun,
  getRun,
  getSteps,
  seedBusiness,
  seedContact,
  serviceDb,
  tickWorker
} from "./harness";

/**
 * Replays the Jennifer Phillips incident (Jul 19 2026) against the REAL
 * worker: a $1.75M realtor.com lead was kept for the owner; the lead's reply
 * relay re-triggered the lead flow and mis-routed her to a teammate.
 *
 * Covers the two engine pieces the fix added:
 *  - notify_lead_owner: forwards a lead's reply to whoever the lead BELONGS
 *    to — the claiming teammate (contacts.owner_employee_id) in round-robin,
 *    the business owner for owner-direct/unowned leads (Jennifer's case);
 *  - ownerDirectNudges: the $1M+ keep-for-owner alert parks and re-fires as
 *    ALL-CAPS reminders at 10/30 minutes unless the owner replies "1" (an
 *    ack, never a claim — claimed_agent stays "none").
 *
 * Definitions are inserted directly (createFlow does not validate): they
 * reference pre-seeded vars instead of extract steps because the itest stack
 * has no Gemini key, and a keyless extract would overwrite the seeded vars
 * with empties. Authoring-time validation is pinned by the unit suites.
 */

/** Today's lead (from the production run context). */
const JEN_PHONE = "+14802740963";
const JEN_NAME = "Jennifer Phillips";
const FULL_MESSAGE = "I have a few questions before we would like to tour the property";
const REPLY_URL = "https://rltr.pro/XKVuC";

const GABBY_PHONE = "+14807202013";
const OWNER_FORWARD = "+16025550001";

/** The reply relay trigger — realtor.com's sender never normalizes (from ""). */
const REPLY_TRIGGER = {
  channel: "sms",
  from: "",
  windowText: `New text reply from ${JEN_NAME}: "I have a few questions before we would like to to..." Click here to respond ( ${REPLY_URL} )`
};

function replyForwardFlow(): Record<string, unknown> {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [
      {
        id: "forward",
        type: "notify_lead_owner",
        phoneVar: "lead_phone",
        nameVar: "lead_name",
        message:
          "Realtor.com: {{vars.lead_name}} replied — full message:\n{{vars.full_message}}\nRespond via realtor.com: {{vars.reply_url}}"
      }
    ],
    options: { suppressDefaultReply: true }
  };
}

function replyVars(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lead_name: JEN_NAME,
    lead_phone: "",
    full_message: FULL_MESSAGE,
    reply_url: REPLY_URL,
    ...over
  };
}

let db: SupabaseClient;

beforeAll(() => {
  db = serviceDb();
});

async function seedMember(biz: string, name: string, phone: string): Promise<string> {
  const { data, error } = await db
    .from("ai_flow_team_members")
    .insert({ business_id: biz, name, phone_e164: phone, active: true })
    .select("id")
    .single();
  if (error) throw new Error(`seedMember: ${error.message}`);
  return (data as { id: string }).id;
}

async function forwardStep(runId: string) {
  const steps = await getSteps(db, runId);
  return steps.find((s) => s.step_type === "notify_lead_owner");
}

describe("notify_lead_owner — forward the reply to whoever holds the lead (real worker)", () => {
  it("today's case: owner-direct lead (unowned contact, name-only relay) goes to the business owner", async () => {
    const biz = await seedBusiness(db, "IT reply fwd owner-direct");
    // Jennifer's contact exists (created by the lead flow's intro text) but
    // has NO owning employee — the $1M+ rule kept her from the team.
    await seedContact(db, biz, JEN_PHONE, { display_name: JEN_NAME });
    const flowId = await createFlow(db, biz, replyForwardFlow());

    // The relay carries only her name; the browse found no phone on the page.
    const runId = await enqueueRun(db, flowId, biz, REPLY_TRIGGER, replyVars());
    await tickWorker();

    expect((await getRun(db, runId)).status).toBe("done");
    const step = await forwardStep(runId);
    expect(step?.status).toBe("done");
    expect((step?.result as { target?: string }).target).toBe("business_owner");
    expect((step?.result as { matched_by?: string }).matched_by).toBe("name");
  });

  it("round-robin case: a claimed lead's reply goes to the claiming teammate", async () => {
    const biz = await seedBusiness(db, "IT reply fwd claimant");
    const gabby = await seedMember(biz, "Gabrielle Mota", GABBY_PHONE);
    // The claim path stamps contacts.owner_employee_id (assignContactOwnerOnClaim).
    await seedContact(db, biz, JEN_PHONE, {
      display_name: JEN_NAME,
      owner_employee_id: gabby
    });
    const flowId = await createFlow(db, biz, replyForwardFlow());

    const runId = await enqueueRun(
      db,
      flowId,
      biz,
      REPLY_TRIGGER,
      replyVars({ lead_phone: "480-274-0963" })
    );
    await tickWorker();

    expect((await getRun(db, runId)).status).toBe("done");
    const step = await forwardStep(runId);
    expect(step?.status).toBe("done");
    expect((step?.result as { target?: string }).target).toBe("contact_owner");
    expect((step?.result as { notified?: string }).notified).toBe(GABBY_PHONE);
    expect((step?.result as { matched_by?: string }).matched_by).toBe("phone");
    const run = await getRun(db, runId);
    expect(String(run.context.vars?.actions_taken)).toContain("Gabrielle Mota");
  });

  it("an ambiguous name (two contacts) never guesses — the business owner gets it", async () => {
    const biz = await seedBusiness(db, "IT reply fwd ambiguous");
    const gabby = await seedMember(biz, "Gabrielle Mota", GABBY_PHONE);
    await seedContact(db, biz, JEN_PHONE, {
      display_name: JEN_NAME,
      owner_employee_id: gabby
    });
    await seedContact(db, biz, "+14805550222", { display_name: JEN_NAME });
    const flowId = await createFlow(db, biz, replyForwardFlow());

    const runId = await enqueueRun(db, flowId, biz, REPLY_TRIGGER, replyVars());
    await tickWorker();

    const step = await forwardStep(runId);
    expect((step?.result as { target?: string }).target).toBe("business_owner");
    expect((step?.result as { matched_by?: string }).matched_by).toBe(null);
  });

  it("an inactive owning employee falls back to the business owner", async () => {
    const biz = await seedBusiness(db, "IT reply fwd inactive owner");
    const { data, error } = await db
      .from("ai_flow_team_members")
      .insert({ business_id: biz, name: "Gone Agent", phone_e164: GABBY_PHONE, active: false })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    await seedContact(db, biz, JEN_PHONE, {
      display_name: JEN_NAME,
      owner_employee_id: (data as { id: string }).id
    });
    const flowId = await createFlow(db, biz, replyForwardFlow());

    const runId = await enqueueRun(
      db,
      flowId,
      biz,
      REPLY_TRIGGER,
      replyVars({ lead_phone: JEN_PHONE })
    );
    await tickWorker();

    const step = await forwardStep(runId);
    expect((step?.result as { target?: string }).target).toBe("business_owner");
  });
});

/** The $1.75M alert flow reduced to the routing step + a claim-gated step. */
function ownerDirectFlow(): Record<string, unknown> {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [
      {
        id: "route",
        type: "route_to_team",
        offerTemplate: "New lead {{vars.lead_name}} — reply 1 to claim.",
        ownerFallbackTemplate: "No one claimed {{vars.lead_name}}.",
        responseMinutes: 10,
        ownerDirectWhen: { var: "price_band", equals: "over_1m" },
        ownerDirectTemplate:
          "****************\nHIGH-VALUE Realtor.com lead ($1M+) kept for you — not offered to the team.\n{{vars.lead_name}} 480-274-0963\n****************",
        ownerDirectNudges: true
      },
      {
        id: "gated",
        type: "notify_owner",
        message: "claim-gated step",
        when: { var: "claimed_agent", notEquals: "none" }
      }
    ]
  };
}

const LEAD_TRIGGER = {
  channel: "sms",
  from: "",
  windowText: "New inquiry: Jennifer Phillips ... $1,750,000/6BR/5BA"
};

const OWNER_DIRECT_VARS = { lead_name: JEN_NAME, price_band: "over_1m" };

async function seedOwnerForward(biz: string): Promise<void> {
  const { error } = await db
    .from("business_telnyx_settings")
    .insert({ business_id: biz, forward_to_e164: OWNER_FORWARD });
  if (error) throw new Error(`seedOwnerForward: ${error.message}`);
}

type RoutingState = {
  owner_direct?: boolean;
  owner_nudges?: number;
  owner_direct_done?: boolean;
  offered?: string;
  last_event?: string;
  reply_from?: string;
};

async function getRouting(runId: string): Promise<RoutingState> {
  const run = await getRun(db, runId);
  return ((run.context as Record<string, unknown>).routing ?? {}) as RoutingState;
}

describe("ownerDirectNudges — 10/30-minute reminders until the owner replies 1 (real worker)", () => {
  it("parks the alert on the owner's number, nudges at both timeouts, then moves on", async () => {
    const biz = await seedBusiness(db, "IT owner-direct nudges");
    await seedOwnerForward(biz);
    const flowId = await createFlow(db, biz, ownerDirectFlow());

    const runId = await enqueueRun(db, flowId, biz, LEAD_TRIGGER, OWNER_DIRECT_VARS);
    await tickWorker();

    // Parked awaiting the owner's ack — NOT offered to any teammate.
    let run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_agent");
    expect(run.respond_by_at).not.toBeNull();
    let routing = await getRouting(runId);
    expect(routing.owner_direct).toBe(true);
    expect(routing.offered).toBe(OWNER_FORWARD);
    expect(String(run.context.vars?.claimed_agent)).toBe("none");

    // 10-minute timeout → first ALL-CAPS reminder, re-parked ~20 more minutes.
    await ageRun(db, runId, { respond_by_at: new Date(Date.now() - 60_000).toISOString() });
    await tickWorker();
    run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_agent");
    routing = await getRouting(runId);
    expect(routing.owner_nudges).toBe(1);

    // 30-minute timeout → final reminder, then the flow continues.
    await ageRun(db, runId, { respond_by_at: new Date(Date.now() - 60_000).toISOString() });
    await tickWorker();
    run = await getRun(db, runId);
    expect(run.status).toBe("done");
    routing = await getRouting(runId);
    expect(routing.owner_direct_done).toBe(true);
    expect(String(run.context.vars?.claimed_agent)).toBe("none");
    expect(String(run.context.vars?.actions_taken)).toContain("did not acknowledge");

    // The claim-gated step stayed closed — the owner's park is not a claim.
    const steps = await getSteps(db, runId);
    const gated = steps.find((s) => s.step_type === "notify_owner");
    expect(gated?.status).toBe("skipped");
  });

  it("the owner's \"1\" acks the alert: reminders stop, claimed_agent stays none", async () => {
    const biz = await seedBusiness(db, "IT owner-direct ack");
    await seedOwnerForward(biz);
    const flowId = await createFlow(db, biz, ownerDirectFlow());

    const runId = await enqueueRun(db, flowId, biz, LEAD_TRIGGER, OWNER_DIRECT_VARS);
    await tickWorker();
    expect((await getRun(db, runId)).status).toBe("awaiting_agent");

    // Resume exactly like the inbound webhook's live-claim path does for a
    // bare "1" from the offered number.
    const run = await getRun(db, runId);
    const context = run.context as Record<string, unknown>;
    const routing = (context.routing ?? {}) as Record<string, unknown>;
    const { error } = await db
      .from("ai_flow_runs")
      .update({
        status: "queued",
        awaiting_agent_e164: null,
        respond_by_at: null,
        context: {
          ...context,
          routing: { ...routing, last_event: "claim", reply_from: OWNER_FORWARD }
        },
        updated_at: new Date().toISOString()
      })
      .eq("id", runId);
    if (error) throw new Error(error.message);
    await tickWorker();

    const done = await getRun(db, runId);
    expect(done.status).toBe("done");
    expect(String(done.context.vars?.claimed_agent)).toBe("none");
    expect(String(done.context.vars?.actions_taken)).toContain("owner acknowledged");
    const finalRouting = await getRouting(runId);
    expect(finalRouting.owner_direct_done).toBe(true);
    // step_index cleared: a stray later "1" can never re-open this run as a claim.
    expect((finalRouting as { step_index?: number }).step_index).toBeUndefined();

    const steps = await getSteps(db, runId);
    const gated = steps.find((s) => s.step_type === "notify_owner");
    expect(gated?.status).toBe("skipped");
  });

  it("without ownerDirectNudges the alert stays fire-and-forget (today's behavior)", async () => {
    const biz = await seedBusiness(db, "IT owner-direct no nudges");
    await seedOwnerForward(biz);
    const def = ownerDirectFlow();
    delete ((def.steps as Array<Record<string, unknown>>)[0] as Record<string, unknown>)
      .ownerDirectNudges;
    const flowId = await createFlow(db, biz, def);

    const runId = await enqueueRun(db, flowId, biz, LEAD_TRIGGER, OWNER_DIRECT_VARS);
    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    expect(String(run.context.vars?.actions_taken)).toContain("kept for the owner");
  });
});
