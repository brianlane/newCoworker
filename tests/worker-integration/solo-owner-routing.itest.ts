import { beforeAll, describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
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
 * Solo-owner keep, pinned against the REAL worker + Postgres: a roster of
 * exactly one ACTIVE member whose phone is an owner number never runs the
 * offer race. The run completes in one tick with one informational notice
 * (send is best-effort in this harness, no Telnyx env), no awaiting_agent
 * park, no claim, and no contact-ownership write. Adding a second member,
 * or replacing the owner with an assistant, restores today's offer park
 * bit for bit, which is the rule's whole safety story: hiring changes the
 * answer with no backfill.
 */

const LEAD = "+14165550166";
const BRIAN = "+14165550990";
const DANA = "+14165550993";

function rotationFlow(): Record<string, unknown> {
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
        offerTemplate: "New lead {{vars.lead_phone}}, reply 1 to claim or 2 to pass.",
        ownerFallbackTemplate: "No one claimed {{vars.lead_phone}}, back to you.",
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

function broadcastAllFlow(): Record<string, unknown> {
  // The seeded needs-human shape: broadcastAll with a response window.
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
        broadcastAll: true,
        offerTemplate: "{{vars.lead_phone}} asked for a person. Reply 1 to take it or 2 to pass.",
        ownerFallbackTemplate: "Nobody claimed the handoff for {{vars.lead_phone}}.",
        responseMinutes: 10
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

type Routing = Record<string, unknown>;
function routingOf(run: Awaited<ReturnType<typeof getRun>>): Routing {
  return ((run.context as { routing?: Routing }).routing ?? {}) as Routing;
}

/** One-person roster + the owner-number source the rule matches against. */
async function seedSoloOwnerBusiness(name: string): Promise<string> {
  const biz = await seedBusiness(db, name);
  const { error: rosterErr } = await db
    .from("ai_flow_team_members")
    .insert([{ business_id: biz, name: "Brian", phone_e164: BRIAN, active: true }]);
  if (rosterErr) throw new Error(`seed roster: ${rosterErr.message}`);
  // The onboarding phone is the third owner-number source; any of the three
  // proves the roster row is the owner.
  const { error: phoneErr } = await db.from("businesses").update({ phone: BRIAN }).eq("id", biz);
  if (phoneErr) throw new Error(`seed owner phone: ${phoneErr.message}`);
  await seedContact(db, biz, LEAD);
  return biz;
}

async function ownerOf(biz: string): Promise<string | null> {
  const { data, error } = await db
    .from("contacts")
    .select("owner_employee_id")
    .eq("business_id", biz)
    .eq("customer_e164", LEAD)
    .maybeSingle();
  if (error) throw new Error(`ownerOf: ${error.message}`);
  return (data as { owner_employee_id: string | null } | null)?.owner_employee_id ?? null;
}

beforeAll(() => {
  db = serviceDb();
});

describe("solo-owner keep (real worker)", () => {
  it("rotation: completes in one tick with no offer park, no claim, no ownership write", async () => {
    const biz = await seedSoloOwnerBusiness("IT solo rotation");
    const flowId = await createFlow(db, biz, rotationFlow());
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    expect(run.respond_by_at).toBeNull();
    expect(run.context.vars?.claimed_agent).toBe("none");
    const routing = routingOf(run);
    expect(routing.solo_owner).toBe(true);
    expect(routing.offered).toBeUndefined();
    expect(routing.offered_log).toBeUndefined();
    expect(routing.offered_all).toBeUndefined();
    expect(routing.claimed_by).toBeUndefined();

    const steps = await getSteps(db, runId);
    const route = steps.find((s) => s.step_type === "route_to_team");
    expect((route?.result as { routed?: string }).routed).toBe("solo_owner");
    // No claim happened, so claim-gated later steps skip, exactly like the
    // owner-fallback path today.
    expect(steps.find((s) => s.step_type === "update_contact")?.status).toBe("skipped");
    // Read-time attribution only: the column must stay null so hiring a
    // second teammate changes the answer with no backfill.
    expect(await ownerOf(biz)).toBeNull();
  });

  it("broadcastAll (the needs-human shape): same keep, no fan-out state", async () => {
    const biz = await seedSoloOwnerBusiness("IT solo broadcast");
    const flowId = await createFlow(db, biz, broadcastAllFlow());
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    const routing = routingOf(run);
    expect(routing.solo_owner).toBe(true);
    expect(routing.offered_all).toBeUndefined();
    expect(routing.offer_deadline_ms).toBeUndefined();
    const steps = await getSteps(db, runId);
    const route = steps.find((s) => s.step_type === "route_to_team");
    expect((route?.result as { routed?: string }).routed).toBe("solo_owner");
    expect(await ownerOf(biz)).toBeNull();
  });

  it("a second active member restores the normal offer park", async () => {
    const biz = await seedSoloOwnerBusiness("IT solo plus hire");
    const { error } = await db
      .from("ai_flow_team_members")
      .insert([{ business_id: biz, name: "Dana", phone_e164: DANA, active: true }]);
    if (error) throw new Error(`hire: ${error.message}`);
    const flowId = await createFlow(db, biz, rotationFlow());
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_agent");
    const routing = routingOf(run);
    expect(routing.solo_owner).toBeUndefined();
    expect(typeof routing.offered).toBe("string");
  });

  it("a solo ASSISTANT roster keeps the offer race (owner can still hand over)", async () => {
    const biz = await seedBusiness(db, "IT solo assistant");
    const { error } = await db
      .from("ai_flow_team_members")
      .insert([{ business_id: biz, name: "Dana", phone_e164: DANA, active: true }]);
    if (error) throw new Error(`seed assistant: ${error.message}`);
    // Owner number on file differs from the sole roster phone.
    await db.from("businesses").update({ phone: BRIAN }).eq("id", biz);
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(db, biz, rotationFlow());
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_agent");
    const routing = routingOf(run);
    expect(routing.solo_owner).toBeUndefined();
    expect(routing.offered).toBe(DANA);
  });
});
